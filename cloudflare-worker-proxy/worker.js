/**
 * MV Director Cloudflare Workers AI Proxy
 *
 * Configure these Worker secrets/variables before deployment:
 *   CLOUDFLARE_ACCOUNT_ID  - Cloudflare account ID
 *   CLOUDFLARE_API_TOKEN   - API token with Workers AI Run permission
 *   PROXY_ACCESS_TOKEN     - long random token used by the MV Director app
 *
 * The application calls this Worker with:
 *   Authorization: Bearer <PROXY_ACCESS_TOKEN>
 *   { action: "image" | "text", model: "@cf/...", input: { ... } }
 *
 * Do not place CLOUDFLARE_API_TOKEN in browser code or client-side localStorage
 * when using this proxy. Only PROXY_ACCESS_TOKEN is stored by the application.
 */

const ALLOWED_METHODS = "GET, POST, OPTIONS";
const ALLOWED_HEADERS = "Authorization, Content-Type";
const MAX_BODY_BYTES = 6 * 1024 * 1024;
const FLUX2_MODELS = new Set([
  "@cf/black-forest-labs/flux-2-dev",
  "@cf/black-forest-labs/flux-2-klein-4b",
  "@cf/black-forest-labs/flux-2-klein-9b"
]);

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": ALLOWED_METHODS,
    "Access-Control-Allow-Headers": ALLOWED_HEADERS,
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(origin),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "*";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (!env.PROXY_ACCESS_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN) {
      return json({ error: "Proxy is not configured. Set PROXY_ACCESS_TOKEN, CLOUDFLARE_ACCOUNT_ID, and CLOUDFLARE_API_TOKEN as Worker secrets/variables." }, 500, origin);
    }

    const auth = request.headers.get("Authorization") || "";
    const supplied = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (!constantTimeEqual(supplied, env.PROXY_ACCESS_TOKEN)) {
      return json({ error: "Unauthorized Worker Proxy request." }, 401, origin);
    }

    if (request.method === "GET") {
      const incomingUrl = new URL(request.url);
      const task = incomingUrl.searchParams.get("task") || "";
      if (task && !/^[a-z0-9_-]{1,80}$/i.test(task)) {
        return json({ error: "Invalid task filter." }, 400, origin);
      }
      const params = new URLSearchParams({ hide_experimental: "true", per_page: "100", page: "1" });
      if (task) params.set("task", task);

      let upstream;
      try {
        upstream = await fetch(
          "https://api.cloudflare.com/client/v4/accounts/" +
            encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID) +
            "/ai/models/search?" + params.toString(),
          {
            headers: { "Authorization": "Bearer " + env.CLOUDFLARE_API_TOKEN, "Accept": "application/json" },
            signal: AbortSignal.timeout(20000)
          }
        );
      } catch (error) {
        const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
        return json({ error: timedOut ? "Cloudflare model catalog request timed out." : "The Worker could not connect to the Cloudflare model catalog." }, timedOut ? 504 : 502, origin);
      }

      if (!upstream.ok) {
        let details = (await upstream.text()).slice(0, 800);
        details = details.replaceAll(env.CLOUDFLARE_API_TOKEN, "[redacted]")
          .replace(/Bearer\s+[^\s"'<>]+/gi, "Bearer [redacted]");
        return json({ error: "Cloudflare model catalog request failed (HTTP " + upstream.status + ").", details }, upstream.status, origin);
      }

      const payload = await upstream.json();
      if (!payload?.success || !Array.isArray(payload.result)) {
        return json({ error: "Cloudflare returned an unexpected model catalog response." }, 502, origin);
      }
      const models = payload.result.map(model => ({
        id: model.name || model.id || "",
        name: model.name || model.id || "",
        description: model.description || "",
        task: typeof model.task === "object" ? (model.task?.name || "") : (model.task || ""),
        source: typeof model.source === "object" ? (model.source?.name || "") : (model.source || ""),
        properties: Array.isArray(model.properties) ? model.properties : [],
        tags: Array.isArray(model.tags) ? model.tags : []
      })).filter(model => typeof model.id === "string" && model.id.startsWith("@cf/"));
      return json({ success: true, models, page: 1, perPage: 100 }, 200, origin);
    }

    if (request.method !== "POST") {
      return json({ error: "Use GET to discover models or POST to run a model." }, 405, origin);
    }

    const contentLength = Number(request.headers.get("Content-Length") || "0");
    if (contentLength > MAX_BODY_BYTES) {
      return json({ error: "Request body is too large." }, 413, origin);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "A valid JSON body is required." }, 400, origin);
    }

    // Check parsed JSON size as well; Content-Length is not always supplied by clients.
    if (new TextEncoder().encode(JSON.stringify(body)).byteLength > MAX_BODY_BYTES) {
      return json({ error: "Request body is too large. Keep FLUX.2 reference images under 512x512 each." }, 413, origin);
    }

    const action = body?.action === "text" ? "text" : "image";
    const model = typeof body?.model === "string" ? body.model.trim() : "";
    const input = body?.input;
    if (!/^@cf\/[A-Za-z0-9._/-]+$/.test(model) || model.includes("..")) {
      return json({ error: "Invalid Cloudflare model identifier. Use an available @cf/... model." }, 400, origin);
    }
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return json({ error: "A model input object is required." }, 400, origin);
    }
    if (action === "image" && (typeof input.prompt !== "string" || !input.prompt.trim())) {
      return json({ error: "An image-generation prompt is required." }, 400, origin);
    }
    if (action === "text" && !Array.isArray(input.messages) && typeof input.prompt !== "string") {
      return json({ error: "A text prompt or messages array is required." }, 400, origin);
    }

    const url = "https://api.cloudflare.com/client/v4/accounts/" +
      encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID) + "/ai/run/" + model;

    // FLUX.2 reference images arrive at this Worker inside the app's JSON envelope
    // as data URLs. Convert them to binary multipart parts before calling Cloudflare.
    let upstreamBody;
    const upstreamHeaders = { "Authorization": "Bearer " + env.CLOUDFLARE_API_TOKEN };
    if (action === "image" && FLUX2_MODELS.has(model)) {
      const imageKeys = Object.keys(input).filter(key => /^input_image_[0-3]$/.test(key));
      if (imageKeys.length > 4) {
        return json({ error: "FLUX.2 supports at most four reference images." }, 400, origin);
      }
      const form = new FormData();
      for (const [key, value] of Object.entries(input)) {
        if (value === undefined || value === null) continue;
        if (/^input_image_[0-3]$/.test(key)) {
          if (typeof value !== "string") {
            return json({ error: key + " must be an image data URL." }, 400, origin);
          }
          const match = value.match(/^data:(image\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/);
          if (!match) {
            return json({ error: key + " must use a base64 image data URL." }, 400, origin);
          }
          let binary;
          try {
            binary = atob(match[2]);
          } catch {
            return json({ error: key + " contains invalid base64 data." }, 400, origin);
          }
          const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
          const extension = match[1].split("/")[1].replace(/[^A-Za-z0-9]/g, "") || "jpg";
          form.append(key, new Blob([bytes], { type: match[1] }), key + "." + extension);
        } else {
          if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
            return json({ error: "Unsupported FLUX.2 input field: " + key }, 400, origin);
          }
          form.append(key, String(value));
        }
      }
      upstreamBody = form;
    } else {
      upstreamHeaders["Content-Type"] = "application/json";
      upstreamBody = JSON.stringify(input);
    }

    let upstream;
    try {
      upstream = await fetch(url, {
        method: "POST",
        headers: upstreamHeaders,
        body: upstreamBody,
        signal: AbortSignal.timeout(90000)
      });
    } catch (error) {
      const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
      return json({ error: timedOut ? "Cloudflare model request timed out." : "The Worker could not connect to the Cloudflare AI API." }, timedOut ? 504 : 502, origin);
    }

    const contentType = upstream.headers.get("Content-Type") || "application/octet-stream";
    const headers = {
      ...corsHeaders(origin),
      "Content-Type": contentType,
      "Cache-Control": "no-store"
    };

    if (!upstream.ok) {
      let details = (await upstream.text()).slice(0, 1200);
      details = details.replaceAll(env.CLOUDFLARE_API_TOKEN, "[redacted]")
        .replace(/Bearer\s+[^\s"'<>]+/gi, "Bearer [redacted]");
      return new Response(JSON.stringify({
        error: "Cloudflare Workers AI rejected the request (HTTP " + upstream.status + ").",
        details
      }), {
        status: upstream.status,
        headers: { ...headers, "Content-Type": "application/json; charset=utf-8" }
      });
    }

    if (contentType.includes("application/json")) {
      return new Response(await upstream.arrayBuffer(), { status: 200, headers });
    }
    if (!contentType.startsWith("image/")) {
      const details = (await upstream.text()).slice(0, 300);
      return json({ error: "Cloudflare returned an unexpected content type: " + contentType, details }, 502, origin);
    }

    return new Response(await upstream.arrayBuffer(), { status: 200, headers });
  }
};
