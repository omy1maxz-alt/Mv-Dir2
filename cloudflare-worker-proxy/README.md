# MV Director Cloudflare Workers AI Proxy

Use this proxy when MV Director runs inside the Google AI Studio hosted iframe and direct calls to `api.cloudflare.com` fail with browser `TypeError: Failed to fetch`. The app cannot add CORS permission to Cloudflare's REST API. This Worker makes the upstream request server-side and returns CORS headers to the app.

## 1. Deploy the Worker

Create a Cloudflare Worker (for example, `mv-director-ai-proxy`) in the Cloudflare dashboard and paste in `worker.js`.

Configure the following Worker values in Settings → Variables and Secrets:

- `CLOUDFLARE_ACCOUNT_ID` — your Cloudflare account ID
- `CLOUDFLARE_API_TOKEN` — create an API token with the minimum Workers AI permission needed to run models (Workers AI Run); store it as a **secret**
- `PROXY_ACCESS_TOKEN` — a long, random secret that you create; also store it as a **secret**

Deploy the Worker and copy its `https://<worker-name>.<your-subdomain>.workers.dev` URL.

## 2. Configure MV Director

Open Settings → API & Account Settings, select Custom API Keys, and under Cloudflare Workers AI enter:

- Account ID and Workers AI API Token only if you also want direct/server-backed fallback. With this Worker, keep the actual Cloudflare API token in the Worker secret store; the proxy URL is the important setting.
- **Cloudflare Worker Proxy URL** — the deployed Worker URL
- **Cloudflare Worker Proxy Access Token** — the same value as the Worker secret `PROXY_ACCESS_TOKEN`

Save settings, reload the AI Studio app, select a Cloudflare image model, and try one scene.

## 3. Security notes

- Never paste `CLOUDFLARE_API_TOKEN` into the app's Proxy Access Token field. They are different secrets.
- Anyone who obtains the Worker URL **and** `PROXY_ACCESS_TOKEN` can spend your Cloudflare AI quota. Keep the proxy token private.
- This proxy supports requests from any origin by default so a hosted AI Studio preview can use it. The bearer proxy token is the authorization gate. For stronger deployment isolation, replace the wildcard behavior with an allowlist that contains the exact origin shown in the browser address bar.
- Do not log tokens or add them to source control.
- Cloudflare free allocation is measured in Neurons, not a guaranteed count of images. Costs vary by model and output dimensions; check the current Cloudflare AI pricing page.

## Discover Cloudflare models

The Worker also exposes an authenticated catalog endpoint for the current Cloudflare account:

- GET <worker-url>?task=text-generation — filter to text-generation models.
- GET <worker-url>?task=text-to-image — filter to text-to-image models.
- GET <worker-url> — return the first 100 non-experimental models.

Include Authorization: Bearer <PROXY_ACCESS_TOKEN>. The Worker queries Cloudflare's official GET /accounts/{account_id}/ai/models/search endpoint. The API token stays in Worker secrets and is never sent to the browser. This endpoint returns catalog metadata; a model still needs a supported request adapter before it should be used for generation. The endpoint requests page 1 with 100 records, so it does not guarantee the entire catalog is included if it grows beyond that page.

## Supported request actions

- `action: "image"`: forwards prompt and image parameters, including width/height, to the selected `@cf/...` model. Supports image bytes and JSON/base64 responses.
- `action: "text"`: forwards a text model's input, such as a messages array, and returns the Cloudflare JSON response.
