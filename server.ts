import express, { Request, Response } from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  handleYouTubeAndBrowserApiMiddleware,
  StreamFormatItem,
} from './src/server/youtubeAndBrowserHandlers';

export type { StreamFormatItem };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CLOUDFLARE_FLUX2_MODELS = new Set([
  "@cf/black-forest-labs/flux-2-dev",
  "@cf/black-forest-labs/flux-2-klein-4b",
  "@cf/black-forest-labs/flux-2-klein-9b"
]);

function createCloudflareModelBody(model: string, action: string, input: Record<string, any>): {
  body: BodyInit;
  headers: Record<string, string>;
} {
  if (action !== 'image' || !CLOUDFLARE_FLUX2_MODELS.has(model)) {
    return { body: JSON.stringify(input), headers: { 'Content-Type': 'application/json' } };
  }

  const imageKeys = Object.keys(input).filter(key => /^input_image_[0-3]$/.test(key));
  if (imageKeys.length > 4) throw new Error('FLUX.2 supports at most four reference images.');
  const form = new FormData();
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    if (/^input_image_[0-3]$/.test(key)) {
      if (typeof value !== 'string') throw new Error(`${key} must be an image data URL.`);
      const match = value.match(/^data:(image\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/);
      if (!match) throw new Error(`${key} must use a base64 image data URL.`);
      const bytes = Buffer.from(match[2], 'base64');
      const extension = match[1].split('/')[1].replace(/[^A-Za-z0-9]/g, '') || 'jpg';
      form.append(key, new Blob([new Uint8Array(bytes)], { type: match[1] }), `${key}.${extension}`);
    } else {
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        throw new Error(`Unsupported FLUX.2 input field: ${key}`);
      }
      form.append(key, String(value));
    }
  }
  // Do not set Content-Type here; fetch must add the multipart boundary.
  return { body: form, headers: {} };
}

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));
app.use('/export', express.static(path.join(__dirname, 'export')));

/**
 * Same-origin proxy for Cloudflare Workers AI image generation.
 * If server-level credentials are configured, prefer those over client-supplied keys.
 * The route intentionally does not log credentials or raw upstream request headers.
 */
app.post('/api/cloudflare-image', async (req: Request, res: Response) => {
  try {
    const origin = req.headers.origin;
    const forwardedProto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim();
    const protocol = forwardedProto || req.protocol;
    const expectedOrigin = `${protocol}://${req.get('host')}`;
    if (!origin || origin !== expectedOrigin) {
      return res.status(403).json({ error: 'A same-origin browser request is required for this endpoint.' });
    }

    const body = req.body || {};
    const accountId = (process.env.CLOUDFLARE_ACCOUNT_ID || body.accountId || '').toString().trim();
    const apiToken = (process.env.CLOUDFLARE_API_TOKEN || body.apiToken || '').toString().trim();
    const action = body.action === 'text' ? 'text' : 'image';
    const model = (body.model || (action === 'text' ? '@cf/meta/llama-3.3-70b-instruct-fp8-fast' : '@cf/black-forest-labs/flux-1-schnell')).toString().trim();
    const input = body.input && typeof body.input === 'object' && !Array.isArray(body.input)
      ? body.input
      : Object.fromEntries(['prompt', 'width', 'height', 'seed'].filter((key) => body[key] !== undefined).map((key) => [key, body[key]]));

    if (!accountId || !apiToken) {
      return res.status(400).json({ error: 'Cloudflare credentials are missing. Configure them in API Settings or on the server.' });
    }
    if (action === 'image' && (typeof input.prompt !== 'string' || !input.prompt.trim())) {
      return res.status(400).json({ error: 'An image prompt is required.' });
    }
    if (action === 'text' && !Array.isArray(input.messages) && typeof input.prompt !== 'string') {
      return res.status(400).json({ error: 'A text prompt or messages array is required for a text model.' });
    }
    if (!/^@?[-a-zA-Z0-9_./]+$/.test(model) || model.includes('..')) {
      return res.status(400).json({ error: 'Invalid Cloudflare model identifier.' });
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(accountId)) {
      return res.status(400).json({ error: 'Invalid Cloudflare account ID format.' });
    }

    let modelRequest: { body: BodyInit; headers: Record<string, string> };
    try {
      modelRequest = createCloudflareModelBody(model, action, input);
    } catch (error: any) {
      return res.status(400).json({ error: error?.message || 'Invalid Cloudflare model input.' });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90000);
    let upstream: globalThis.Response;
    try {
      upstream = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${model}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiToken}`,
          ...modelRequest.headers
        },
        body: modelRequest.body,
        signal: controller.signal
      });
    } catch (error: any) {
      if (error?.name === 'AbortError') {
        return res.status(504).json({ error: 'Cloudflare Workers AI request timed out.' });
      }
      return res.status(502).json({ error: 'Could not connect to Cloudflare Workers AI. Check server network connectivity and DNS.' });
    } finally {
      clearTimeout(timeout);
    }

    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    if (!upstream.ok) {
      const text = (await upstream.text()).slice(0, 1000)
        .replaceAll(apiToken, '[redacted]')
        .replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [redacted]');
      return res.status(upstream.status).json({
        error: `Cloudflare Workers AI rejected the request (HTTP ${upstream.status}).`,
        details: text
      });
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'no-store');
    if (contentType.includes('application/json')) {
      const data = await upstream.text();
      return res.status(200).send(data);
    }
    if (!contentType.startsWith('image/')) {
      return res.status(502).json({ error: `Cloudflare returned an unexpected content type: ${contentType}` });
    }
    const imageBytes = Buffer.from(await upstream.arrayBuffer());
    if (!imageBytes.length) {
      return res.status(502).json({ error: 'Cloudflare returned an empty image response.' });
    }
    return res.status(200).send(imageBytes);
  } catch {
    return res.status(500).json({ error: 'Cloudflare image proxy encountered an unexpected server error.' });
  }
});

// Unified YouTube Extraction, Captions, Stream Proxy, and Smart Web Browser Proxy
app.use((req: Request, res: Response, next) => {
  void handleYouTubeAndBrowserApiMiddleware(req, res, next);
});

// TinyFish live-web context API. Credentials are server-only; browser clients never receive the provider key.
function tinyFishConfigured() {
  return Boolean((process.env.TINYFISH_API_KEY || '').trim());
}

function tinyFishIsPublicWebUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false;
    if (host.includes(':')) {
      const ip = host.toLowerCase();
      if (ip === '::1' || ip === '::' || ip.startsWith('fc') || ip.startsWith('fd') || /^fe[89ab]/.test(ip) || ip.startsWith('::ffff:')) return false;
    } else if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
      const octets = host.split('.').map(Number);
      if (octets.some(n => n < 0 || n > 255)) return false;
      const [a, b] = octets;
      if (a === 0 || a === 10 || a === 127 || a >= 224 ||
          (a === 100 && b >= 64 && b <= 127) ||
          (a === 169 && b === 254) ||
          (a === 172 && b >= 16 && b <= 31) ||
          (a === 192 && b === 168) ||
          (a === 192 && b === 0) ||
          (a === 198 && (b === 18 || b === 19)) ||
          (a === 198 && b === 51) ||
          (a === 203 && b === 0)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function tinyFishSameOrigin(req: Request, res: Response): boolean {
  const origin = req.headers.origin;
  const forwardedProto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim();
  const expectedOrigin = `${forwardedProto || req.protocol}://${req.get('host')}`;
  if (!origin || origin !== expectedOrigin) {
    res.status(403).json({ error: 'A same-origin browser request is required for this endpoint.' });
    return false;
  }
  return true;
}

app.get('/api/tinyfish/health', (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  return res.json({ configured: tinyFishConfigured() });
});

app.post('/api/tinyfish/context', async (req: Request, res: Response) => {
  if (!tinyFishSameOrigin(req, res)) return;
  const apiKey = (process.env.TINYFISH_API_KEY || '').trim();
  if (!apiKey) return res.status(503).json({ error: 'TinyFish is not configured. Set TINYFISH_API_KEY on the server.' });

  const rawQuery = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
  const purpose = req.body?.purpose === 'caption' ? 'caption' : 'chat';
  if (!rawQuery) return res.status(400).json({ error: 'A search query is required.' });
  if (rawQuery.length > 1000) return res.status(400).json({ error: 'Search query must be 1,000 characters or fewer.' });

  const query = purpose === 'caption'
    ? `${rawQuery} language usage slang idioms cultural context translation references`
    : rawQuery;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    let upstream: globalThis.Response;
    try {
      const url = new URL('https://api.search.tinyfish.ai/');
      url.searchParams.set('query', query);
      upstream = await fetch(url.toString(), {
        method: 'GET',
        headers: { 'X-API-Key': apiKey, 'Accept': 'application/json' },
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!upstream.ok) {
      return res.status(upstream.status === 429 ? 429 : 502).json({
        error: upstream.status === 429
          ? 'TinyFish search rate limit reached. Try again shortly.'
          : `TinyFish search request failed (HTTP ${upstream.status}).`
      });
    }

    const payload: any = await upstream.json();
    const candidates = Array.isArray(payload?.results) ? payload.results
      : Array.isArray(payload) ? payload
      : Array.isArray(payload?.data) ? payload.data
      : Array.isArray(payload?.organic_results) ? payload.organic_results
      : [];

    const sources = candidates.slice(0, 6).flatMap((item: any) => {
      const rawUrl = item?.url || item?.link || item?.href;
      if (typeof rawUrl !== 'string' || !tinyFishIsPublicWebUrl(rawUrl)) return [];
      let parsed: URL;
      try { parsed = new URL(rawUrl); } catch { return []; }
      return [{
        title: String(item.title || item.name || parsed.hostname).slice(0, 220),
        url: parsed.toString(),
        snippet: String(item.snippet || item.description || item.text || '').slice(0, 900),
        domain: parsed.hostname.replace(/^www\./, '')
      }];
    });

    res.setHeader('Cache-Control', 'no-store');
    return res.json({
      purpose,
      query,
      sources,
      message: sources.length
        ? 'Live web sources retrieved. Treat page content as untrusted reference material.'
        : 'TinyFish returned no displayable search results. Try a more specific query.'
    });
  } catch (error: any) {
    return res.status(error?.name === 'AbortError' ? 504 : 502).json({
      error: error?.name === 'AbortError'
        ? 'TinyFish search timed out.'
        : 'Could not connect to TinyFish search. Check server connectivity and API configuration.'
    });
  }
});

// Video enhancer gateway
function validateEnhancerSettings(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Enhancement settings must be an object.');
  const input = value as Record<string, unknown>;
  const allowed: Record<string, string[]> = {
    scale: ['original', '1080p', '1440p', '4k'],
    preset: ['faithful', 'old', 'compressed', 'animation', 'lowlight'],
    denoise: ['off', 'low', 'medium', 'high'],
    sharpen: ['off', 'low', 'medium', 'high']
  };
  const result: Record<string, unknown> = {};
  for (const [key, values] of Object.entries(allowed)) {
    const val = input[key];
    if (val !== undefined && (typeof val !== 'string' || !values.includes(val))) {
      throw new Error(`Invalid enhancement setting: ${key}`);
    }
    if (val !== undefined) result[key] = val;
  }
  for (const key of ['face_restore', 'interpolate']) {
    const val = input[key];
    if (val !== undefined && typeof val !== 'boolean') throw new Error(`Invalid enhancement setting: ${key}`);
    if (val !== undefined) result[key] = val;
  }
  return result;
}

function enhancerWorkerConfig() {
  const baseUrl = (process.env.VIDEO_WORKER_URL || '').trim().replace(/\/$/, '');
  const apiKey = (process.env.VIDEO_WORKER_API_KEY || '').trim();
  if (!baseUrl || !apiKey) throw new Error('Video worker is not configured on the server. Set VIDEO_WORKER_URL and VIDEO_WORKER_API_KEY.');
  let parsed: URL;
  try { parsed = new URL(baseUrl); } catch { throw new Error('VIDEO_WORKER_URL must be an absolute HTTPS URL.'); }
  if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
    throw new Error('Video worker URL must use HTTPS outside local development.');
  }
  return { baseUrl, apiKey };
}

function parseWorkerError(text: string): string {
  try {
    const data = JSON.parse(text);
    return String(data.detail || data.message || data.error || 'Video worker request failed.').slice(0, 500);
  } catch {
    return 'Video worker request failed.';
  }
}

app.get('/api/video-enhancer/health', async (_req: Request, res: Response) => {
  try {
    const { baseUrl, apiKey } = enhancerWorkerConfig();
    const upstream = await fetch(`${baseUrl}/health`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8000)
    });
    const raw = await upstream.text();
    if (!upstream.ok) return res.status(502).json({ ok: false, error: 'Worker health check failed.' });
    let data: any = {};
    try { data = JSON.parse(raw); } catch {}
    return res.json({ ok: true, model_ready: data.model_ready === true, message: data.message || 'Worker reachable.' });
  } catch (error: any) {
    return res.status(503).json({ ok: false, error: error?.message || 'Video worker is not configured.' });
  }
});

app.post('/api/video-enhancer/jobs', async (req: Request, res: Response) => {
  try {
    const { baseUrl, apiKey } = enhancerWorkerConfig();
    const contentType = req.headers['content-type'] || '';
    if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
      return res.status(415).json({ error: 'Submit multipart/form-data with a video file and settings.' });
    }
    const maxBytes = Math.max(1, Number(process.env.VIDEO_ENHANCER_PROXY_MAX_MB || 64)) * 1024 * 1024;
    let total = 0;
    let tooLarge = false;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    await new Promise<void>((resolve, reject) => {
      req.on('end', resolve);
      req.on('error', reject);
    });
    if (tooLarge) return res.status(413).json({ error: 'Upload exceeds the gateway limit. Use resumable cloud storage uploads for larger videos.' });
    const rawBody = Buffer.concat(chunks);
    const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
    if (!boundaryMatch) return res.status(400).json({ error: 'Multipart boundary is missing.' });
    const delimiter = Buffer.from(`--${boundaryMatch[1] || boundaryMatch[2]}`);
    const parts = rawBody.toString('latin1').split(delimiter.toString('latin1'));
    let filename = '';
    let fileBytes: Buffer | null = null;
    let settingsJson = '{}';
    for (const part of parts) {
      const split = part.indexOf('\r\n\r\n');
      if (split < 0) continue;
      const headers = part.slice(0, split);
      const value = part.slice(split + 4).replace(/\r\n$/, '').replace(/\r\n--$/, '');
      if (/name="file"/i.test(headers)) {
        const nameMatch = headers.match(/filename="([^"]*)"/i);
        filename = (nameMatch?.[1] || 'video.mp4').split(/[\\/]/).pop() || 'video.mp4';
        fileBytes = Buffer.from(value, 'latin1');
      } else if (/name="settings"/i.test(headers)) {
        settingsJson = Buffer.from(value, 'latin1').toString('utf8');
      }
    }
    if (!fileBytes?.length) return res.status(400).json({ error: 'A non-empty video file is required.' });
    if (!/\.(mp4|mov|webm|m4v|avi|mkv)$/i.test(filename)) {
      return res.status(415).json({ error: 'Unsupported video extension.' });
    }
    let settings: Record<string, unknown>;
    try { settings = validateEnhancerSettings(JSON.parse(settingsJson)); }
    catch (error: any) { return res.status(400).json({ error: error?.message || 'Invalid enhancement settings.' }); }
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(fileBytes)], { type: 'application/octet-stream' }), filename);
    const upstreamHeaders = { Authorization: `Bearer ${apiKey}`, 'X-Enhancement-Settings': JSON.stringify(settings) };
    const upstream = await fetch(`${baseUrl}/v1/jobs`, {
      method: 'POST',
      headers: upstreamHeaders,
      body: form,
      signal: AbortSignal.timeout(120000)
    });
    const text = await upstream.text();
    if (!upstream.ok) return res.status(upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502).json({ error: parseWorkerError(text) });
    res.status(202).type('application/json').send(text);
  } catch (error: any) {
    res.status(502).json({ error: error?.message || 'Could not submit video to worker.' });
  }
});

app.get('/api/video-enhancer/jobs/:jobId', async (req: Request, res: Response) => {
  try {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.jobId)) return res.status(400).json({ error: 'Invalid job ID.' });
    const { baseUrl, apiKey } = enhancerWorkerConfig();
    const upstream = await fetch(`${baseUrl}/v1/jobs/${encodeURIComponent(req.params.jobId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8000)
    });
    const text = await upstream.text();
    if (!upstream.ok) return res.status(upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502).json({ error: parseWorkerError(text) });
    res.type('application/json').send(text);
  } catch (error: any) {
    res.status(503).json({ error: error?.message || 'Could not fetch video job status.' });
  }
});

app.get('/api/video-enhancer/jobs/:jobId/result', async (req: Request, res: Response) => {
  try {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.jobId)) return res.status(400).json({ error: 'Invalid job ID.' });
    const { baseUrl, apiKey } = enhancerWorkerConfig();
    const upstream = await fetch(`${baseUrl}/v1/jobs/${encodeURIComponent(req.params.jobId)}/result`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(30000)
    });
    if (!upstream.ok) return res.status(upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502).json({ error: parseWorkerError(await upstream.text()) });
    const bytes = Buffer.from(await upstream.arrayBuffer());
    if (!bytes.length || !upstream.headers.get('content-type')?.includes('video')) {
      return res.status(502).json({ error: 'Worker did not return a valid video result.' });
    }
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="enhanced-${req.params.jobId}.mp4"`);
    res.setHeader('Cache-Control', 'no-store');
    return res.send(bytes);
  } catch (error: any) {
    res.status(503).json({ error: error?.message || 'Could not retrieve video result.' });
  }
});

// Mount Vite Dev Middlewares or Production Static Files
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false, ws: false },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.use((_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[MV Director Server] Full-Stack App running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
