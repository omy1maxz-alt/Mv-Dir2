import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GoogleGenAI } from '@google/genai';

const AISTUDIO_PLACEHOLDER_KEY = 'AIzaSyCnx3oHaOAtIcttEtJDlfq7YxBGeoTu0Co';

export function isRealGeminiKey(key?: string): boolean {
  if (!key || typeof key !== 'string') return false;
  const trimmed = key.trim();
  return trimmed.length >= 25 && trimmed !== AISTUDIO_PLACEHOLDER_KEY && !trimmed.includes('PLACEHOLDER');
}

/**
 * Normalizes video/audio MIME types so Gemini File API and generateContent never reject
 * containers like .mkv, .mov, .mp3, or generic application/octet-stream with 400 INVALID_ARGUMENT.
 */
function normalizeGeminiMediaMimeType(rawMime: string, fileName: string): string {
  const lowerMime = (rawMime || '').toLowerCase().trim();
  const ext = (fileName.split('.').pop() || '').toLowerCase();

  const extMap: Record<string, string> = {
    mp4: 'video/mp4',
    m4v: 'video/mp4',
    mov: 'video/quicktime',
    webm: 'video/webm',
    mkv: 'video/mp4', // Gemini File API processes H.264/AAC MKV cleanly when labeled video/mp4 or video/webm
    avi: 'video/x-msvideo',
    flv: 'video/x-flv',
    wmv: 'video/wmv',
    mpeg: 'video/mpeg',
    mpg: 'video/mpeg',
    '3gp': 'video/3gpp',
    ts: 'video/mp2t',
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    aac: 'audio/aac',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    opus: 'audio/ogg',
    flac: 'audio/flac',
    aiff: 'audio/aiff',
  };

  if (!lowerMime || lowerMime === 'application/octet-stream' || lowerMime === 'binary/octet-stream') {
    return extMap[ext] || 'video/mp4';
  }
  if (lowerMime === 'audio/mp3') return 'audio/mpeg';
  if (lowerMime === 'video/x-matroska' || lowerMime === 'video/mkv') return 'video/mp4';
  if (lowerMime === 'video/x-ms-wmv') return 'video/wmv';
  return lowerMime;
}

/**
 * Safely reads the request body whether or not Express's `express.json()` / `express.urlencoded()`
 * middleware has already consumed the incoming stream.
 */
async function readRawRequestBody(req: any): Promise<Buffer | undefined> {
  const method = (req.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD') return undefined;

  if (Buffer.isBuffer(req.body)) {
    return req.body.length > 0 ? req.body : undefined;
  }
  if (typeof req.body === 'string' && req.body.length > 0) {
    return Buffer.from(req.body, 'utf-8');
  }
  if (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) {
    return Buffer.from(JSON.stringify(req.body), 'utf-8');
  }
  if (req.readableEnded) {
    return undefined;
  }

  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    req.on('data', (chunk: any) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve());
    req.on('error', reject);
  });
  return chunks.length > 0 ? Buffer.concat(chunks) : undefined;
}

/**
 * Extracts the best valid Gemini API key from request headers, query params, or server environment.
 */
function resolveGeminiApiKey(req: any, fullUrl: string): string {
  const headerGoogKey = ((req.headers?.['x-goog-api-key'] as string) || '').trim();
  const headerCustomKey = ((req.headers?.['x-gemini-api-key'] as string) || '').trim();
  const authHeader = ((req.headers?.['authorization'] as string) || '').replace(/^Bearer\s+/i, '').trim();

  let queryKey = '';
  try {
    const parsedUrl = new URL(fullUrl, 'http://localhost');
    queryKey = (parsedUrl.searchParams.get('key') || '').trim();
  } catch (_) {}

  const envKey = (process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY || '').trim();

  for (const candidate of [headerCustomKey, headerGoogKey, queryKey, authHeader, envKey]) {
    if (isRealGeminiKey(candidate)) {
      return candidate;
    }
  }
  return '';
}

/**
 * Connect/Vite & Express compatible middleware for:
 * 1. `/api/gemini/proxy/*` — Direct Node.js pass-through proxy to `https://generativelanguage.googleapis.com/*`.
 *    Bypasses the AI Studio preview iframe's `window.fetch` monkey-patch (which otherwise hijacks browser requests
 *    to `generativelanguage.googleapis.com`, strips the user's custom API key, and throws
 *    "Failed to call the Gemini API. Please try again.").
 *    Also preserves all `x-goog-upload-*` headers required by the Google Resumable Upload protocol.
 * 2. `/api/gemini/upload-file` — Streaming proxy for Gemini File API uploads (>2MB / 80MB+ Audio & Video).
 */
export async function handleGeminiUploadMiddleware(req: any, res: any, next?: () => void): Promise<boolean> {
  const fullUrl = req.originalUrl || req.url || '';
  const urlPath = fullUrl.split('?')[0] || '';

  // Handle CORS preflight for proxy/upload endpoints
  if (
    req.method === 'OPTIONS' &&
    (urlPath.startsWith('/api/gemini/proxy/') || urlPath === '/api/gemini/upload-file')
  ) {
    res.statusCode = 204;
    res.setHeader('Access-Control-Allow-Origin', req.headers?.origin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, x-goog-api-key, x-gemini-api-key, x-goog-api-client, x-mime-type, x-file-name, x-goog-upload-protocol, x-goog-upload-command, x-goog-upload-header-content-length, x-goog-upload-header-content-type, x-goog-upload-offset, x-goog-upload-url'
    );
    res.setHeader(
      'Access-Control-Expose-Headers',
      'x-goog-upload-url, x-goog-upload-status, x-goog-upload-chunk-granularity, x-goog-upload-control-url'
    );
    res.end();
    return true;
  }

  // --- 1. Direct Node.js Reverse Proxy for Gemini API (/api/gemini/proxy/*) ---
  if (urlPath.startsWith('/api/gemini/proxy/')) {
    if (req.setTimeout) req.setTimeout(600000);
    if (res.setTimeout) res.setTimeout(600000);

    const keyToUse = resolveGeminiApiKey(req, fullUrl);
    if (!keyToUse) {
      res.statusCode = 401;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          error: {
            code: 401,
            message:
              'A valid personal Gemini API key is required for direct Google API routing. Please paste your Gemini API key in Settings -> API Settings Vault.',
            status: 'UNAUTHENTICATED',
          },
        })
      );
      return true;
    }

    // Strip `/api/gemini/proxy` prefix and remove any placeholder `key` query param so `x-goog-api-key` is authoritative
    const rawUpstream = fullUrl.replace(/^\/api\/gemini\/proxy/, '');
    let cleanUpstreamPathAndQuery = rawUpstream;
    try {
      const parsed = new URL(rawUpstream, 'https://generativelanguage.googleapis.com');
      if (parsed.searchParams.has('key') && !isRealGeminiKey(parsed.searchParams.get('key') || '')) {
        parsed.searchParams.delete('key');
      }
      cleanUpstreamPathAndQuery = `${parsed.pathname}${parsed.search}`;
    } catch (_) {}

    const targetUrl = `https://generativelanguage.googleapis.com${cleanUpstreamPathAndQuery}`;
    const method = (req.method || 'GET').toUpperCase();

    try {
      const bodyBuffer = await readRawRequestBody(req);

      const forwardHeaders: Record<string, string> = {
        'x-goog-api-key': keyToUse,
      };
      if (req.headers?.['content-type']) {
        forwardHeaders['Content-Type'] = String(req.headers['content-type']);
      }
      // Forward all x-goog-* headers (including resumable upload protocol headers)
      for (const [hKey, hVal] of Object.entries(req.headers || {})) {
        const lowerKey = hKey.toLowerCase();
        if (
          lowerKey.startsWith('x-goog-') &&
          lowerKey !== 'x-goog-api-key' &&
          hVal !== undefined
        ) {
          forwardHeaders[hKey] = Array.isArray(hVal) ? hVal.join(', ') : String(hVal);
        }
      }

      const upstreamRes = await fetch(targetUrl, {
        method,
        headers: forwardHeaders,
        body: bodyBuffer && bodyBuffer.length > 0 ? (bodyBuffer as any) : undefined,
      });

      res.statusCode = upstreamRes.status;
      const contentType = upstreamRes.headers.get('content-type') || 'application/json';
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'no-store');

      // Forward all upstream x-goog-* response headers (such as x-goog-upload-url)
      upstreamRes.headers.forEach((value, key) => {
        if (key.toLowerCase().startsWith('x-goog-')) {
          res.setHeader(key, value);
        }
      });
      res.setHeader(
        'Access-Control-Expose-Headers',
        'x-goog-upload-url, x-goog-upload-status, x-goog-upload-chunk-granularity, x-goog-upload-control-url'
      );

      const responseBuffer = Buffer.from(await upstreamRes.arrayBuffer());
      res.end(responseBuffer);
      return true;
    } catch (proxyErr: any) {
      console.error('[Gemini Direct Proxy] Upstream error:', proxyErr);
      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          error: {
            code: 502,
            message: `Direct Gemini proxy network error: ${proxyErr?.message || proxyErr}`,
            status: 'UNAVAILABLE',
          },
        })
      );
      return true;
    }
  }

  // --- 2. Streaming Proxy for Gemini File API (/api/gemini/upload-file) ---
  if (urlPath !== '/api/gemini/upload-file' || req.method !== 'POST') {
    if (next) next();
    return false;
  }

  // Set extended timeout for large media files (up to 10 minutes)
  if (req.setTimeout) req.setTimeout(600000);
  if (res.setTimeout) res.setTimeout(600000);

  const keyToUse = resolveGeminiApiKey(req, fullUrl);
  if (!keyToUse) {
    res.statusCode = 401;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        error:
          'A personal Gemini API key is required for File API uploads. Please enter your Gemini API key in Settings -> API Settings Vault.',
      })
    );
    return true;
  }

  const encodedName = ((req.headers?.['x-file-name'] as string) || 'upload.mp4').trim();
  let rawFileName = 'upload.mp4';
  try {
    rawFileName = decodeURIComponent(encodedName);
  } catch (_) {
    rawFileName = encodedName;
  }
  const displayName = rawFileName.replace(/[^a-zA-Z0-9_\-\.]/g, '_') || 'upload';
  const rawMime = ((req.headers?.['x-mime-type'] as string) || (req.headers?.['content-type'] as string) || '').trim();
  const safeMime = normalizeGeminiMediaMimeType(rawMime, rawFileName);

  const ext = path.extname(displayName) || (safeMime.startsWith('video/') ? '.mp4' : '.mp3');
  const tempDir = os.tmpdir();
  const tempFileName = `gemini-upload-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
  const tempFilePath = path.join(tempDir, tempFileName);

  try {
    if (Buffer.isBuffer(req.body) && req.body.length > 0) {
      fs.writeFileSync(tempFilePath, req.body);
    } else if (req.readableEnded) {
      throw new Error('Request stream was already consumed before reaching the upload handler.');
    } else {
      const writeStream = fs.createWriteStream(tempFilePath);
      await new Promise<void>((resolve, reject) => {
        req.pipe(writeStream);
        req.on('error', reject);
        writeStream.on('error', reject);
        writeStream.on('finish', () => resolve());
      });
    }
  } catch (pipeErr: any) {
    try {
      if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
    } catch (_) {}
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: `File streaming to disk failed: ${pipeErr?.message || pipeErr}` }));
    return true;
  }

  try {
    const stats = fs.statSync(tempFilePath);
    if (!stats || stats.size === 0) {
      try {
        if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
      } catch (_) {}
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Received empty file payload (0 bytes).' }));
      return true;
    }

    console.log(
      `[Gemini Proxy] Streaming ${(stats.size / (1024 * 1024)).toFixed(1)}MB file (${displayName}, ${safeMime}) to Gemini File API...`
    );

    const ai = new GoogleGenAI({ apiKey: keyToUse });

    const uploadRes = await ai.files.upload({
      file: tempFilePath,
      config: {
        mimeType: safeMime,
        displayName: displayName,
      },
    });

    let state = String(uploadRes.state || '');
    let finalFile: any = uploadRes;
    let pollAttempts = 0;
    while (state === 'PROCESSING' && pollAttempts < 90) {
      await new Promise((r) => setTimeout(r, 2000));
      finalFile = await ai.files.get({ name: uploadRes.name });
      state = String(finalFile.state || '');
      pollAttempts++;
    }

    if (state === 'FAILED') {
      const errDetail = finalFile?.error?.message || 'Gemini File API returned processing state: FAILED';
      throw new Error(errDetail);
    }

    const resolvedMime = finalFile.mimeType || safeMime;
    console.log(
      `[Gemini Proxy] Upload completed: ${finalFile.name} (uri: ${finalFile.uri}, mimeType: ${resolvedMime})`
    );

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        fileUri: finalFile.uri,
        name: finalFile.name,
        mimeType: resolvedMime,
        size: stats.size,
      })
    );
    return true;
  } catch (uploadErr: any) {
    console.error('[Gemini Proxy] Upload failed:', uploadErr);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        error: uploadErr?.message || 'File upload to Gemini API failed.',
      })
    );
    return true;
  } finally {
    try {
      if (fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
      }
    } catch (_) {}
  }
}
