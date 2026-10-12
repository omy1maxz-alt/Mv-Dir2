# MV Director Cloudflare Workers AI Proxy

Use this proxy when MV Director runs inside the Google AI Studio hosted iframe and direct calls to `api.cloudflare.com` fail with browser `TypeError: Failed to fetch`. The app cannot add CORS permission to Cloudflare's REST API. This Worker makes the upstream request server-side and returns CORS headers to the app.

## 1. Deploy the Worker

Create a Cloudflare Worker (for example, `mv-director-ai-proxy`) in the Cloudflare dashboard and paste in `worker.js`.

Configure the following Worker values in Settings → Variables and Secrets:

- `CLOUDFLARE_ACCOUNT_ID` — your Cloudflare account ID
- `CLOUDFLARE_API_TOKEN` — create an API token with the minimum Workers AI permission needed to run models (Workers AI Run); store it as a **secret**
- `PROXY_ACCESS_TOKEN` — a long, random secret that you create; also store it as a **secret**

Deploy the Worker and copy its `https://<worker-name>.<your-subdomain>.workers.dev` URL.

### Updating an existing Worker

If a model request returns `required properties at '/' are 'multipart'` for FLUX.2, or refreshing the catalog displays `Use POST for model requests`, the deployed Worker is likely older than the current repository source. Open that existing Worker in Cloudflare Dashboard, replace its code with the latest `cloudflare-worker-proxy/worker.js` from this repository, and click **Deploy**. Keep the existing values for `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, and `PROXY_ACCESS_TOKEN`; a GitHub commit does not redeploy the Cloudflare Worker automatically.

The updated Worker uses **GET** for model-catalog discovery and **POST** for model inference. FLUX.2 [dev], Klein 4B, and Klein 9B requests are converted to upstream `multipart/form-data` automatically.


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

- FLUX.2 image models are supported by the authenticated JSON envelope and translated server-side to the required `multipart/form-data` request. The supported IDs are `@cf/black-forest-labs/flux-2-dev`, `@cf/black-forest-labs/flux-2-klein-4b`, and `@cf/black-forest-labs/flux-2-klein-9b`.
- FLUX.2 reference images are sent in `input_image_0` through `input_image_3`, with a maximum of four images. MV Director resizes them so each image is smaller than 512×512 before sending them.
- After pulling an app update that adds FLUX.2 support, **redeploy the latest `cloudflare-worker-proxy/worker.js`** in the Cloudflare dashboard. An older deployed Worker will continue forwarding JSON and will reject FLUX.2 reference-image requests.

- `action: "text"`: forwards a text model's input, such as a messages array, and returns the Cloudflare JSON response.
