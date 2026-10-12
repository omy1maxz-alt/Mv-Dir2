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

const ALLOWED_METHODS = "POST, OPTIONS";
const ALLOWED_HEADERS = "Authorization, Content-Type";
const MAX_BODY_BYTES = 1_000_000;

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
    if (request.method !== "POST") {
      return json({ error: "Use POST for model requests." }, 405, origin);
    }
    if (!env.PROXY_ACCESS_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN) {
      return json({ error: "Proxy is not configured. Set PROXY_ACCESS_TOKEN, CLOUDFLARE_ACCOUNT_ID, and CLOUDFLARE_API_TOKEN as Worker secrets/variables." }, 500, origin);
    }

    const auth = request.headers.get("Authorization") || "";
    const supplied = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (!constantTimeEqual(supplied, env.PROXY_ACCESS_TOKEN)) {
      return json({ error: "Unauthorized Worker Proxy request." }, 401, origin);
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

    let upstream;
    try {
      upstream = await fetch(url, {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + env.CLOUDFLARE_API_TOKEN,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(input),
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
