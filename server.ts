import express, { Request, Response } from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseRawCaptionToSegments, segmentsToSrt, YouTubeCaptionResponse } from './src/services/youtubeCaptionService';

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
    // Never return internal exception details that might contain upstream request metadata.
    return res.status(500).json({ error: 'Cloudflare image proxy encountered an unexpected server error.' });
  }
});


const PIPED_INSTANCES = [
  'https://api.piped.privacy.com.de',
  'https://pipedapi.tokhmi.xyz',
  'https://piped-api.lunar.icu',
  'https://pa.il.ax',
  'https://api-piped.mha.fi',
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.leptons.xyz',
  'https://pipedapi.drgns.space',
  'https://pipedapi.r4fo.com'
];

const INVIDIOUS_INSTANCES = [
  'https://inv.nadeko.net',
  'https://invidious.nerdvpn.de',
  'https://invidious.private.coffee',
  'https://invidious.projectsegfau.lt',
  'https://yewtu.be',
  'https://inv.riverside.rocks',
  'https://invidious.snopyta.org',
  'https://iv.ggtyler.dev',
  'https://invidious.perennialte.ch'
];

async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = 7000): Promise<any> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timeoutId);
  }
}

function extractVideoId(rawUrl: string): string | null {
  if (!rawUrl) return null;
  const clean = rawUrl.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(clean)) return clean;
  const match = clean.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i);
  return match ? match[1] : null;
}

export interface StreamFormatItem {
  id: string;
  type: 'audio' | 'video' | 'combined';
  label: string;
  quality?: string;
  bitrate?: number;
  mimeType: string;
  url: string;
  isProxyUrl?: boolean;
}

/**
 * Server-Side Resolution Engine:
 * 1. Queries YouTube InnerTube Player endpoint (Android Client)
 * 2. Queries Piped / Invidious Server Instances
 * 3. Builds a list of selectable format links & verified downloader links
 */
async function resolveYouTubeVideoServerSide(videoId: string) {
  let title = 'YouTube_Video';
  let dashUrl: string | null = null;
  let hlsUrl: string | null = null;
  let combinedStreamUrl: string | null = null;
  let combinedQuality: string | null = null;
  let bestAudioUrl: string | null = null;
  let audioBitrate: number | null = null;
  let bestVideoOnlyUrl: string | null = null;
  let videoQuality: string | null = null;
  let subtitles: Array<{ name: string; code: string; url: string; isAutoGenerated: boolean; mimeType: string }> = [];
  let formats: StreamFormatItem[] = [];
  let duration = 0;
  let thumbnailUrl = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

  // Always provide backend proxy streams as first-class selectable options
  formats.push({
    id: `proxy-audio-${videoId}`,
    type: 'audio',
    label: 'High-Quality Audio Stream (Backend Stream Proxy)',
    quality: 'High Bitrate Audio',
    mimeType: 'audio/mpeg',
    url: `/api/youtube/stream?videoId=${encodeURIComponent(videoId)}&quality=audio`,
    isProxyUrl: true
  });

  formats.push({
    id: `proxy-video-720-${videoId}`,
    type: 'combined',
    label: '720p HD Video Stream (Backend Stream Proxy)',
    quality: '720p',
    mimeType: 'video/mp4',
    url: `/api/youtube/stream?videoId=${encodeURIComponent(videoId)}&quality=720`,
    isProxyUrl: true
  });

  formats.push({
    id: `proxy-video-360-${videoId}`,
    type: 'combined',
    label: '360p Fast Video Stream (Backend Stream Proxy)',
    quality: '360p',
    mimeType: 'video/mp4',
    url: `/api/youtube/stream?videoId=${encodeURIComponent(videoId)}&quality=360`,
    isProxyUrl: true
  });

  // Strategy 1: YouTube InnerTube API (Android Client)
  try {
    const innertubeRes = await fetchWithTimeout('https://www.youtube.com/youtubei/v1/player', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip'
      },
      body: JSON.stringify({
        videoId,
        context: {
          client: {
            clientName: 'ANDROID',
            clientVersion: '19.09.37',
            androidSdkVersion: 30,
            hl: 'en',
            gl: 'US'
          }
        }
      })
    }, 5000);

    if (innertubeRes.ok) {
      const data = await innertubeRes.json();
      if (data.videoDetails) {
        title = data.videoDetails.title || title;
        duration = parseInt(data.videoDetails.lengthSeconds || '0', 10);
        if (data.videoDetails.thumbnail?.thumbnails?.length > 0) {
          thumbnailUrl = data.videoDetails.thumbnail.thumbnails[data.videoDetails.thumbnail.thumbnails.length - 1].url;
        }
      }

      // Harvest closed captions
      if (data.captions?.playerCaptionsTracklistRenderer?.captionTracks) {
        const tracks = data.captions.playerCaptionsTracklistRenderer.captionTracks;
        subtitles = tracks.map((t: any) => ({
          name: t.name?.simpleText || t.name?.runs?.[0]?.text || t.languageCode || 'Captions',
          code: t.languageCode || 'en',
          url: t.baseUrl,
          isAutoGenerated: !!t.vssId?.startsWith('a.'),
          mimeType: 'text/vtt'
        }));
      }

      // Harvest streams
      if (data.streamingData) {
        hlsUrl = data.streamingData.hlsManifestUrl || null;
        dashUrl = data.streamingData.dashManifestUrl || null;

        // Combined formats (video + audio)
        if (Array.isArray(data.streamingData.formats)) {
          data.streamingData.formats.forEach((f: any, idx: number) => {
            if (f.url) {
              const qual = f.qualityLabel || (f.height ? `${f.height}p` : 'Standard');
              formats.push({
                id: `direct-combined-${idx}`,
                type: 'combined',
                label: `Combined Progressive MP4 (${qual})`,
                quality: qual,
                mimeType: f.mimeType?.split(';')[0] || 'video/mp4',
                url: f.url
              });
            }
          });

          const validCombined = data.streamingData.formats.filter((f: any) => f.url && f.mimeType?.startsWith('video/'));
          if (validCombined.length > 0) {
            const best = validCombined.sort((a: any, b: any) => (b.height || 0) - (a.height || 0))[0];
            combinedStreamUrl = best.url;
            combinedQuality = best.qualityLabel || `${best.height}p`;
          }
        }

        // Adaptive formats (separate audio and video)
        if (Array.isArray(data.streamingData.adaptiveFormats)) {
          data.streamingData.adaptiveFormats.forEach((f: any, idx: number) => {
            if (f.url) {
              const isAudio = f.mimeType?.startsWith('audio/');
              const label = isAudio
                ? `Direct Audio Track (${Math.round((f.bitrate || 0) / 1000)} kbps ${f.mimeType?.includes('mp4') || f.mimeType?.includes('m4a') ? 'M4A' : 'WebM'})`
                : `Direct Video Track (${f.qualityLabel || `${f.height}p`})`;
              
              formats.push({
                id: `direct-adaptive-${idx}`,
                type: isAudio ? 'audio' : 'video',
                label,
                quality: f.qualityLabel || (f.height ? `${f.height}p` : undefined),
                bitrate: f.bitrate,
                mimeType: f.mimeType?.split(';')[0] || (isAudio ? 'audio/mp4' : 'video/mp4'),
                url: f.url
              });
            }
          });

          const audioFormats = data.streamingData.adaptiveFormats.filter((f: any) => f.url && f.mimeType?.startsWith('audio/'));
          if (audioFormats.length > 0) {
            const best = audioFormats.sort((a: any, b: any) => (b.bitrate || 0) - (a.bitrate || 0))[0];
            bestAudioUrl = best.url;
            audioBitrate = best.bitrate || null;
          }

          const videoFormats = data.streamingData.adaptiveFormats.filter((f: any) => f.url && f.mimeType?.startsWith('video/'));
          if (videoFormats.length > 0) {
            const best = videoFormats.sort((a: any, b: any) => (b.height || 0) - (a.height || 0))[0];
            bestVideoOnlyUrl = best.url;
            videoQuality = best.qualityLabel || `${best.height}p`;
          }
        }

        return {
          success: true,
          videoId,
          title,
          dashUrl,
          hlsUrl,
          combinedStreamUrl,
          combinedQuality,
          bestAudioUrl,
          audioBitrate,
          bestVideoOnlyUrl,
          videoQuality,
          subtitles,
          formats,
          duration,
          thumbnailUrl,
          directLinks: {
            cobalt: `https://cobalt.tools`,
            tenDownloader: `https://10downloader.com/download?v=https://www.youtube.com/watch?v=${videoId}`,
            y2mate: `https://www.y2mate.com/youtube/${videoId}`,
            saveFrom: `https://en.savefrom.net/20/#url=https://www.youtube.com/watch?v=${videoId}`,
            piped: `https://piped.video/watch?v=${videoId}`,
            invidious: `https://inv.nadeko.net/watch?v=${videoId}`
          }
        };
      }
    }
  } catch (innertubeErr) {
    console.warn('[InnerTube Extraction Notice]', innertubeErr);
  }

  // Strategy 2: Multi-Region Piped Server API
  for (const piped of PIPED_INSTANCES) {
    try {
      const streamRes = await fetchWithTimeout(`${piped}/streams/${videoId}`, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
      }, 4500);

      if (streamRes.ok) {
        const data = await streamRes.json();
        title = data.title || title;
        duration = data.duration || duration;
        thumbnailUrl = data.thumbnailUrl || thumbnailUrl;

        if (Array.isArray(data.subtitles) && subtitles.length === 0) {
          subtitles = data.subtitles.map((s: any) => ({
            name: s.name || s.code || 'Subtitles',
            code: s.code || 'en',
            url: s.url,
            isAutoGenerated: !!s.autoGenerated,
            mimeType: s.mimeType || 'text/vtt'
          }));
        }

        dashUrl = data.dash || dashUrl;
        hlsUrl = data.hls || hlsUrl;

        if (Array.isArray(data.videoStreams)) {
          data.videoStreams.forEach((v: any, idx: number) => {
            if (v.url) {
              formats.push({
                id: `piped-video-${idx}`,
                type: v.videoOnly ? 'video' : 'combined',
                label: `Piped ${v.videoOnly ? 'Video Track' : 'Combined MP4'} (${v.quality || `${v.height}p`})`,
                quality: v.quality || `${v.height}p`,
                bitrate: v.bitrate,
                mimeType: v.mimeType || 'video/mp4',
                url: v.url
              });
            }
          });

          const combined = data.videoStreams.filter((v: any) => !v.videoOnly);
          if (combined.length > 0) {
            const best = combined.sort((a: any, b: any) => (b.height || 0) - (a.height || 0))[0];
            combinedStreamUrl = best.url;
            combinedQuality = best.quality || `${best.height}p`;
          }
        }

        if (Array.isArray(data.audioStreams) && data.audioStreams.length > 0) {
          data.audioStreams.forEach((a: any, idx: number) => {
            if (a.url) {
              formats.push({
                id: `piped-audio-${idx}`,
                type: 'audio',
                label: `Piped Audio Track (${Math.round((a.bitrate || 0) / 1000)} kbps ${a.format || 'M4A'})`,
                bitrate: a.bitrate,
                mimeType: a.mimeType || 'audio/mp4',
                url: a.url
              });
            }
          });

          const best = data.audioStreams.sort((a: any, b: any) => (b.bitrate || 0) - (a.bitrate || 0))[0];
          bestAudioUrl = best.url;
          audioBitrate = best.bitrate || null;
        }

        return {
          success: true,
          videoId,
          title,
          dashUrl,
          hlsUrl,
          combinedStreamUrl,
          combinedQuality,
          bestAudioUrl,
          audioBitrate,
          bestVideoOnlyUrl,
          videoQuality,
          subtitles,
          formats,
          duration,
          thumbnailUrl,
          directLinks: {
            cobalt: `https://cobalt.tools`,
            tenDownloader: `https://10downloader.com/download?v=https://www.youtube.com/watch?v=${videoId}`,
            y2mate: `https://www.y2mate.com/youtube/${videoId}`,
            saveFrom: `https://en.savefrom.net/20/#url=https://www.youtube.com/watch?v=${videoId}`,
            piped: `https://piped.video/watch?v=${videoId}`,
            invidious: `https://inv.nadeko.net/watch?v=${videoId}`
          }
        };
      }
    } catch {
      // try next
    }
  }

  // Strategy 3: Multi-Region Invidious Server API
  for (const inv of INVIDIOUS_INSTANCES) {
    try {
      const invRes = await fetchWithTimeout(`${inv}/api/v1/videos/${videoId}`, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
      }, 4500);

      if (invRes.ok) {
        const data = await invRes.json();
        title = data.title || title;
        duration = data.lengthSeconds || duration;
        thumbnailUrl = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

        if (Array.isArray(data.captions) && subtitles.length === 0) {
          subtitles = data.captions.map((c: any) => ({
            name: c.label || c.languageCode,
            code: c.languageCode,
            url: `${inv}${c.url}`,
            isAutoGenerated: false,
            mimeType: 'text/vtt'
          }));
        }

        const audioFormat = Array.isArray(data.adaptiveFormats)
          ? data.adaptiveFormats.find((f: any) => f.type?.startsWith('audio/'))
          : null;
        const videoFormat = Array.isArray(data.formatStreams)
          ? data.formatStreams[0]
          : null;

        return {
          success: true,
          videoId,
          title,
          dashUrl: data.dashUrl || null,
          hlsUrl: data.hlsUrl || null,
          combinedStreamUrl: videoFormat?.url || null,
          combinedQuality: videoFormat?.resolution || '360p',
          bestAudioUrl: audioFormat?.url || null,
          audioBitrate: audioFormat?.bitrate || null,
          bestVideoOnlyUrl: null,
          videoQuality: null,
          subtitles,
          formats,
          duration,
          thumbnailUrl,
          directLinks: {
            cobalt: `https://cobalt.tools`,
            tenDownloader: `https://10downloader.com/download?v=https://www.youtube.com/watch?v=${videoId}`,
            y2mate: `https://www.y2mate.com/youtube/${videoId}`,
            saveFrom: `https://en.savefrom.net/20/#url=https://www.youtube.com/watch?v=${videoId}`,
            piped: `https://piped.video/watch?v=${videoId}`,
            invidious: `https://inv.nadeko.net/watch?v=${videoId}`
          }
        };
      }
    } catch {
      // try next
    }
  }

  return {
    success: true, // Return true with proxy & download links so the user can always choose
    videoId,
    title,
    subtitles,
    formats,
    thumbnailUrl,
    directLinks: {
      cobalt: `https://cobalt.tools`,
      tenDownloader: `https://10downloader.com/download?v=https://www.youtube.com/watch?v=${videoId}`,
      y2mate: `https://www.y2mate.com/youtube/${videoId}`,
      saveFrom: `https://en.savefrom.net/20/#url=https://www.youtube.com/watch?v=${videoId}`,
      piped: `https://piped.video/watch?v=${videoId}`,
      invidious: `https://inv.nadeko.net/watch?v=${videoId}`
    },
    error: 'Direct upstream streaming was throttled by YouTube. Select one of the stream links or verified direct downloaders below.'
  };
}


type YouTubeCaptionTrackCandidate = {
  name: string;
  code: string;
  url: string;
  isAutoGenerated: boolean;
  mimeType: string;
};

function parsePlayerResponseFromHtml(html: string): any | null {
  const markers = ['ytInitialPlayerResponse = ', 'ytInitialPlayerResponse=', '"ytInitialPlayerResponse":'];
  for (const marker of markers) {
    const markerIndex = html.indexOf(marker);
    if (markerIndex < 0) continue;
    const objectStart = html.indexOf('{', markerIndex + marker.length);
    if (objectStart < 0) continue;

    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = objectStart; i < html.length; i++) {
      const char = html[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '{') depth++;
      else if (char === '}') {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(html.slice(objectStart, i + 1)); } catch { break; }
        }
      }
    }
  }
  return null;
}

/**
 * Retrieve YouTube player metadata without touching the cross-origin iframe DOM.
 * Different official player clients can expose different caption tracks or manifests.
 */
async function fetchYouTubePlayerDataCandidates(videoId: string): Promise<any[]> {
  const clients = [
    {
      clientName: 'ANDROID',
      clientId: '3',
      clientVersion: '19.09.37',
      userAgent: 'com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip',
      context: { clientName: 'ANDROID', clientVersion: '19.09.37', androidSdkVersion: 30, hl: 'en', gl: 'US' }
    },
    {
      clientName: 'IOS',
      clientId: '5',
      clientVersion: '19.45.4',
      userAgent: 'com.google.ios.youtube/19.45.4 (iPhone16,2; U; CPU iOS 18_0 like Mac OS X)',
      context: { clientName: 'IOS', clientVersion: '19.45.4', deviceModel: 'iPhone16,2', osName: 'iPhone', osVersion: '18.0', hl: 'en', gl: 'US' }
    },
    {
      clientName: 'WEB',
      clientId: '1',
      clientVersion: '2.20241010.01.00',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
      context: { clientName: 'WEB', clientVersion: '2.20241010.01.00', hl: 'en', gl: 'US' }
    }
  ];

  const responses = await Promise.all(clients.map(async (client) => {
    try {
      const response = await fetchWithTimeout('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Accept-Language': 'en-US,en;q=0.9',
          'Origin': 'https://www.youtube.com',
          'Referer': `https://www.youtube.com/watch?v=${videoId}`,
          'User-Agent': client.userAgent,
          'X-YouTube-Client-Name': client.clientId,
          'X-YouTube-Client-Version': client.clientVersion
        },
        body: JSON.stringify({
          videoId,
          context: { client: client.context, user: { lockedSafetyMode: false }, request: { useSsl: true } }
        })
      }, 6500);
      if (!response.ok) return null;
      const payload = await response.json();
      return payload && typeof payload === 'object' ? payload : null;
    } catch {
      return null;
    }
  }));

  const payloads = responses.filter((payload): payload is any => !!payload);
  const hasTracks = payloads.some(payload => payload.captions?.playerCaptionsTracklistRenderer?.captionTracks?.length);
  const hasManifest = payloads.some(payload => payload.streamingData?.hlsManifestUrl || payload.streamingData?.dashManifestUrl);

  if (!hasTracks || !hasManifest) {
    try {
      const watchPage = await fetchWithTimeout(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9'
        },
        redirect: 'follow'
      }, 6500);
      if (watchPage.ok) {
        const playerResponse = parsePlayerResponseFromHtml(await watchPage.text());
        if (playerResponse) payloads.push(playerResponse);
      }
    } catch {
      // The InnerTube client results remain available if the watch page blocks server-side fetching.
    }
  }

  return payloads;
}

function collectYouTubeCaptionTracks(payloads: any[]): YouTubeCaptionTrackCandidate[] {
  const unique = new Map<string, YouTubeCaptionTrackCandidate>();
  for (const payload of payloads) {
    const tracks = payload?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!Array.isArray(tracks)) continue;
    for (const track of tracks) {
      if (typeof track?.baseUrl !== 'string' || !track.baseUrl) continue;
      let url: string;
      try { url = new URL(track.baseUrl, 'https://www.youtube.com').toString(); } catch { continue; }
      const code = String(track.languageCode || 'und');
      const name = track.name?.simpleText || track.name?.runs?.map((run: any) => run.text || '').join('') || code;
      const item = {
        name,
        code,
        url,
        isAutoGenerated: Boolean(track.vssId?.startsWith('a.') || track.kind === 'asr'),
        mimeType: 'text/vtt'
      };
      unique.set(`${item.code}|${item.isAutoGenerated}|${item.url}`, item);
    }
  }
  return Array.from(unique.values());
}

async function fetchCommunityYouTubeCaptionTracks(videoId: string): Promise<YouTubeCaptionTrackCandidate[]> {
  const attempts = [
    ...PIPED_INSTANCES.slice(0, 4).map(instance => async () => {
      const response = await fetchWithTimeout(`${instance}/streams/${encodeURIComponent(videoId)}`, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
      }, 4500);
      if (!response.ok) return [];
      const data = await response.json();
      if (!Array.isArray(data.subtitles)) return [];
      return data.subtitles.flatMap((track: any) => {
        if (typeof track?.url !== 'string' || !track.url) return [];
        let url = '';
        try { url = new URL(track.url, instance).toString(); } catch { return []; }
        return [{
          name: track.name || track.code || 'Captions',
          code: track.code || 'und',
          url,
          isAutoGenerated: Boolean(track.autoGenerated),
          mimeType: track.mimeType || 'text/vtt'
        }];
      });
    }),
    ...INVIDIOUS_INSTANCES.slice(0, 3).map(instance => async () => {
      const response = await fetchWithTimeout(`${instance}/api/v1/videos/${encodeURIComponent(videoId)}`, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
      }, 4500);
      if (!response.ok) return [];
      const data = await response.json();
      if (!Array.isArray(data.captions)) return [];
      return data.captions.flatMap((track: any) => {
        if (typeof track?.url !== 'string' || !track.url) return [];
        let url = '';
        try { url = new URL(track.url, instance).toString(); } catch { return []; }
        return [{
          name: track.label || track.languageCode || 'Captions',
          code: track.languageCode || 'und',
          url,
          isAutoGenerated: Boolean(track.autoGenerated || track.kind === 'asr'),
          mimeType: track.mimeType || 'text/vtt'
        }];
      });
    })
  ];
  const results = await Promise.all(attempts.map(async attempt => {
    try { return await attempt(); } catch { return []; }
  }));
  const unique = new Map<string, YouTubeCaptionTrackCandidate>();
  results.flat().forEach(track => unique.set(`${track.code}|${track.isAutoGenerated}|${track.url}`, track));
  return Array.from(unique.values());
}

// 1. Backend Extraction API: Resolves 4-tier streams, all formats & subtitles
app.post(['/api/youtube/extract', '/api/resolve-stream'], async (req: Request, res: Response) => {
  try {
    const { url, videoId: directVideoId } = req.body;
    const videoId = directVideoId || extractVideoId(url);

    if (!videoId) {
      return res.status(400).json({ error: 'Valid YouTube URL or videoId is required.' });
    }

    const [resolvedResult, playerPayloads] = await Promise.all([
      resolveYouTubeVideoServerSide(videoId),
      fetchYouTubePlayerDataCandidates(videoId)
    ]);
    const result: any = resolvedResult;

    // Merge metadata from multiple YouTube player clients. Caption tracks and
    // manifest URLs can differ by client, and are useful even when a stream
    // resolver only found progressive URLs.
    const playerTracks = collectYouTubeCaptionTracks(playerPayloads);
    for (const payload of playerPayloads) {
      const streamingData = payload?.streamingData;
      if (!result.dashUrl && streamingData?.dashManifestUrl) result.dashUrl = streamingData.dashManifestUrl;
      if (!result.hlsUrl && streamingData?.hlsManifestUrl) result.hlsUrl = streamingData.hlsManifestUrl;
      if (!result.title || result.title === 'YouTube_Video') result.title = payload?.videoDetails?.title || result.title;
      if (!result.duration && payload?.videoDetails?.lengthSeconds) {
        result.duration = parseInt(payload.videoDetails.lengthSeconds, 10) || result.duration;
      }
      if (payload?.videoDetails?.thumbnail?.thumbnails?.length && !result.thumbnailUrl) {
        result.thumbnailUrl = payload.videoDetails.thumbnail.thumbnails.slice(-1)[0].url;
      }
    }
    if (!Array.isArray(result.subtitles) || result.subtitles.length === 0) {
      result.subtitles = playerTracks;
    }
    if (!Array.isArray(result.formats)) result.formats = [];
    if (result.hlsUrl && !result.formats.some((format: StreamFormatItem) => format.url === result.hlsUrl)) {
      result.formats.push({
        id: `hls-manifest-${videoId}`,
        type: 'combined',
        label: 'HLS Manifest (m3u8)',
        mimeType: 'application/vnd.apple.mpegurl',
        url: result.hlsUrl
      });
    }
    if (result.dashUrl && !result.formats.some((format: StreamFormatItem) => format.url === result.dashUrl)) {
      result.formats.push({
        id: `dash-manifest-${videoId}`,
        type: 'combined',
        label: 'DASH Manifest (mpd)',
        mimeType: 'application/dash+xml',
        url: result.dashUrl
      });
    }
    return res.json(result);
  } catch (err: any) {
    console.error('[Backend Extract Error]', err);
    return res.status(500).json({ error: err?.message || 'Internal server extraction error.' });
  }
});

// 2. Backend Stream Proxy: Streams binary audio/video directly with chunking & headers
app.get('/api/youtube/stream', async (req: Request, res: Response) => {
  try {
    const videoId = (req.query.v as string) || (req.query.videoId as string);
    const quality = (req.query.quality as string) || 'audio';
    const directUrl = req.query.url as string;

    let targetStreamUrl = directUrl;

    if (!targetStreamUrl && videoId) {
      const resolved = await resolveYouTubeVideoServerSide(videoId);
      if (quality === 'audio') {
        targetStreamUrl = resolved.bestAudioUrl || resolved.combinedStreamUrl || null;
      } else {
        targetStreamUrl = resolved.combinedStreamUrl || resolved.bestVideoOnlyUrl || null;
      }
    }

    if (!targetStreamUrl) {
      return res.status(404).json({ error: 'Stream URL could not be resolved for proxying.' });
    }

    // Stream from source to client
    const sourceRes = await fetch(targetStreamUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Range': req.headers.range || 'bytes=0-'
      }
    });

    if (!sourceRes.ok && sourceRes.status !== 206) {
      return res.status(sourceRes.status).send(`Upstream stream error: ${sourceRes.statusText}`);
    }

    const contentType = sourceRes.headers.get('content-type') || (quality === 'audio' ? 'audio/mpeg' : 'video/mp4');
    const contentLength = sourceRes.headers.get('content-length');
    const contentRange = sourceRes.headers.get('content-range');

    const headers: Record<string, string> = {
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
      'Content-Disposition': `attachment; filename="youtube_${videoId || 'media'}.${quality === 'audio' ? 'mp3' : 'mp4'}"`
    };

    if (contentLength) headers['Content-Length'] = contentLength;
    if (contentRange) headers['Content-Range'] = contentRange;

    res.writeHead(sourceRes.status === 206 ? 206 : 200, headers);

    if (sourceRes.body) {
      const reader = sourceRes.body.getReader();
      const pump = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(Buffer.from(value));
          }
          res.end();
        } catch (streamErr) {
          console.error('[Stream Pipe Error]', streamErr);
          res.end();
        }
      };
      await pump();
    } else {
      const arrayBuffer = await sourceRes.arrayBuffer();
      res.end(Buffer.from(arrayBuffer));
    }
  } catch (err: any) {
    console.error('[Stream Proxy Route Error]', err);
    if (!res.headersSent) {
      res.status(500).json({ error: err?.message || 'Streaming proxy failed.' });
    }
  }
});

// 3. Dedicated YouTube Caption Service & Structured Endpoint
async function getYouTubeCaptionsServerSide(videoId: string, targetLanguage?: string): Promise<YouTubeCaptionResponse> {
  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return {
      success: false,
      videoId,
      source: 'unavailable',
      requiresTranscription: false,
      reason: 'YOUTUBE_VIDEO_INVALID',
      message: 'Invalid YouTube Video ID format.'
    };
  }

  try {
    // Retrieve captions independently from the stream resolver. Stream URLs may be
    // blocked or absent while the video's official caption track is still available.
    const playerPayloads = await fetchYouTubePlayerDataCandidates(videoId);
    let availableTracks = collectYouTubeCaptionTracks(playerPayloads);
    let metadata = playerPayloads.find(payload => payload?.videoDetails) || playerPayloads[0] || {};

    if (!availableTracks.length) {
      availableTracks = await fetchCommunityYouTubeCaptionTracks(videoId);
    }

    const videoDetails = metadata?.videoDetails || {};
    const title = videoDetails.title || 'YouTube_Video';
    const duration = parseInt(videoDetails.lengthSeconds || '0', 10) || 0;
    const thumbnailUrl = videoDetails.thumbnail?.thumbnails?.slice(-1)[0]?.url
      || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

    if (availableTracks.length > 0) {
      const target = String(targetLanguage || '').trim().toLowerCase();
      const isEnglishTarget = target === 'english' || target === 'en' || target.startsWith('en-');
      const languageMatches = (track: YouTubeCaptionTrackCandidate) =>
        (!!target && (track.name.toLowerCase().includes(target) || track.code.toLowerCase() === target || track.code.toLowerCase().startsWith(target + '-')))
        || (isEnglishTarget && (track.code.toLowerCase() === 'en' || track.code.toLowerCase().startsWith('en-')));
      const orderedTracks = [...availableTracks].sort((a, b) => {
        const aMatch = languageMatches(a) ? 1 : 0;
        const bMatch = languageMatches(b) ? 1 : 0;
        if (aMatch !== bMatch) return bMatch - aMatch;
        if (a.isAutoGenerated !== b.isAutoGenerated) return a.isAutoGenerated ? 1 : -1;
        return 0;
      });

      for (const track of orderedTracks) {
        const candidateUrls = [track.url];
        try {
          const parsed = new URL(track.url);
          if (parsed.hostname.endsWith('youtube.com') && parsed.pathname.includes('/api/timedtext')) {
            const json3 = new URL(track.url);
            json3.searchParams.set('fmt', 'json3');
            if (json3.toString() !== track.url) candidateUrls.unshift(json3.toString());
          }
        } catch {
          // Keep the original track URL when it cannot be parsed as an absolute URL.
        }

        for (const captionUrl of Array.from(new Set(candidateUrls))) {
          try {
            const subRes = await fetchWithTimeout(captionUrl, {
              headers: {
                'User-Agent': 'Mozilla/5.0',
                'Accept': 'text/vtt, application/json, application/xml, text/xml, */*',
                'Referer': `https://www.youtube.com/watch?v=${videoId}`
              }
            }, 6500);
            if (!subRes.ok) continue;
            const rawContent = await subRes.text();
            const segments = parseRawCaptionToSegments(rawContent);
            if (segments.length === 0) continue;

            const rawSrt = segmentsToSrt(segments);
            return {
              success: true,
              videoId,
              title,
              source: 'youtube_cc',
              language: track.code,
              isAutoGenerated: track.isAutoGenerated,
              segments,
              rawSrt,
              duration,
              thumbnailUrl,
              availableTracks
            };
          } catch {
            // A track may be expired or blocked; try its alternate format and remaining tracks.
          }
        }
      }
    }

    return {
      success: true,
      videoId,
      title,
      source: 'unavailable',
      requiresTranscription: true,
      reason: availableTracks.length ? 'CAPTIONS_RETRIEVAL_BLOCKED' : 'CAPTIONS_NOT_AVAILABLE',
      message: availableTracks.length
        ? 'YouTube caption tracks were found, but none of their timed-text URLs could be read. Use the AI Generate Subtitle action to transcribe the media audio.'
        : 'No YouTube closed-caption tracks could be found for this video. Use the AI Generate Subtitle action to transcribe the media audio.',
      duration,
      thumbnailUrl,
      availableTracks
    };
  } catch (err: any) {
    console.error('[YouTube Caption Service Error]', err);
    return {
      success: false,
      videoId,
      source: 'unavailable',
      requiresTranscription: true,
      reason: 'SERVER_RETRIEVAL_FAILED',
      message: err?.message || 'Server caption retrieval encountered an error.'
    };
  }
}

// Lightweight subtitle-track inventory endpoint. It intentionally does not invoke the slower stream resolver.
async function fetchCommunityYouTubeManifestCandidates(videoId: string): Promise<Array<{ source: string; hlsUrl: string | null; dashUrl: string | null }>> {
  const attempts = [
    ...PIPED_INSTANCES.slice(0, 4).map(instance => async () => {
      const response = await fetchWithTimeout(`${instance}/streams/${encodeURIComponent(videoId)}`, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
      }, 4500);
      if (!response.ok) return null;
      const data = await response.json();
      return {
        source: instance,
        hlsUrl: typeof data.hls === 'string' && data.hls ? data.hls : null,
        dashUrl: typeof data.dash === 'string' && data.dash ? data.dash : null
      };
    }),
    ...INVIDIOUS_INSTANCES.slice(0, 4).map(instance => async () => {
      const response = await fetchWithTimeout(`${instance}/api/v1/videos/${encodeURIComponent(videoId)}`, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
      }, 4500);
      if (!response.ok) return null;
      const data = await response.json();
      return {
        source: instance,
        hlsUrl: typeof data.hlsUrl === 'string' && data.hlsUrl ? data.hlsUrl : null,
        dashUrl: typeof data.dashUrl === 'string' && data.dashUrl ? data.dashUrl : null
      };
    })
  ];
  const results = await Promise.all(attempts.map(async attempt => {
    try { return await attempt(); } catch { return null; }
  }));
  return results.filter((item): item is { source: string; hlsUrl: string | null; dashUrl: string | null } => !!item);
}

// Fast HLS/DASH discovery avoids waiting for the legacy stream downloader's sequential fallbacks.
app.all('/api/youtube/manifests', async (req: Request, res: Response) => {
  try {
    const rawUrl = (req.query.url as string) || (req.body?.url as string) || '';
    const rawVideoId = (req.query.videoId as string) || (req.query.v as string) || (req.body?.videoId as string) || '';
    const videoId = rawVideoId || extractVideoId(rawUrl);
    if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
      return res.status(400).json({ success: false, videoId: videoId || '', hlsUrl: null, dashUrl: null, message: 'A valid YouTube URL or video ID is required.' });
    }

    const [playerPayloads, community] = await Promise.all([
      fetchYouTubePlayerDataCandidates(videoId),
      fetchCommunityYouTubeManifestCandidates(videoId)
    ]);
    const playerData = playerPayloads.map(payload => payload?.streamingData || {});
    const hlsUrl = playerData.map(streaming => streaming.hlsManifestUrl).find((url: unknown) => typeof url === 'string' && url)
      || community.map(item => item.hlsUrl).find(url => !!url)
      || null;
    const dashUrl = playerData.map(streaming => streaming.dashManifestUrl).find((url: unknown) => typeof url === 'string' && url)
      || community.map(item => item.dashUrl).find(url => !!url)
      || null;
    const metadata = playerPayloads.find(payload => payload?.videoDetails) || playerPayloads[0] || {};
    const title = metadata?.videoDetails?.title || 'YouTube_Video';
    const duration = parseInt(metadata?.videoDetails?.lengthSeconds || '0', 10) || 0;
    const thumbnailUrl = metadata?.videoDetails?.thumbnail?.thumbnails?.slice(-1)[0]?.url
      || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

    return res.json({
      success: true,
      videoId,
      title,
      duration,
      thumbnailUrl,
      hlsUrl,
      dashUrl,
      sources: {
        playerClients: playerPayloads.length,
        communityProviders: community.length
      },
      message: hlsUrl || dashUrl
        ? 'Available manifest URLs were discovered. Signed URLs may expire and are not guaranteed for every video.'
        : 'No HLS/DASH manifest URL was exposed by the available YouTube player clients or fallback providers. This does not mean timed captions are unavailable.'
    });
  } catch (error: any) {
    return res.status(502).json({
      success: false,
      hlsUrl: null,
      dashUrl: null,
      message: error?.message || 'YouTube manifest lookup failed.'
    });
  }
});

app.all('/api/youtube/caption-tracks', async (req: Request, res: Response) => {
  try {
    const rawUrl = (req.query.url as string) || (req.body?.url as string) || '';
    const rawVideoId = (req.query.videoId as string) || (req.query.v as string) || (req.body?.videoId as string) || '';
    const videoId = rawVideoId || extractVideoId(rawUrl);
    if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
      return res.status(400).json({ success: false, videoId: videoId || '', tracks: [], message: 'A valid YouTube URL or video ID is required.' });
    }

    const payloads = await fetchYouTubePlayerDataCandidates(videoId);
    let tracks = collectYouTubeCaptionTracks(payloads);
    if (!tracks.length) tracks = await fetchCommunityYouTubeCaptionTracks(videoId);
    const metadata = payloads.find(payload => payload?.videoDetails) || payloads[0] || {};
    return res.json({
      success: true,
      videoId,
      title: metadata?.videoDetails?.title || 'YouTube_Video',
      duration: parseInt(metadata?.videoDetails?.lengthSeconds || '0', 10) || 0,
      thumbnailUrl: metadata?.videoDetails?.thumbnail?.thumbnails?.slice(-1)[0]?.url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      tracks
    });
  } catch (error: any) {
    return res.status(502).json({ success: false, tracks: [], message: error?.message || 'Could not discover YouTube caption tracks.' });
  }
});

app.all('/api/youtube/captions', async (req: Request, res: Response) => {
  try {
    const rawUrl = (req.query.url as string) || (req.body?.url as string) || '';
    const rawVideoId = (req.query.videoId as string) || (req.query.v as string) || (req.body?.videoId as string) || '';
    const targetLang = (req.query.targetLang as string) || (req.body?.targetLang as string) || '';

    const videoId = rawVideoId || extractVideoId(rawUrl);
    if (!videoId) {
      return res.status(400).json({
        success: false,
        videoId: '',
        source: 'unavailable',
        requiresTranscription: false,
        reason: 'YOUTUBE_VIDEO_INVALID',
        message: 'A valid YouTube URL or videoId is required.'
      });
    }

    const captionResult = await getYouTubeCaptionsServerSide(videoId, targetLang);
    return res.json(captionResult);
  } catch (err: any) {
    console.error('[Captions API Route Error]', err);
    return res.status(500).json({
      success: false,
      source: 'unavailable',
      requiresTranscription: true,
      reason: 'SERVER_RETRIEVAL_FAILED',
      message: err?.message || 'Internal server error resolving captions.'
    });
  }
});

// 4. Subtitles Proxy: Fetches native closed captions
app.get('/api/youtube/subtitles', async (req: Request, res: Response) => {
  try {
    const subtitleUrl = req.query.url as string;
    if (!subtitleUrl) {
      return res.status(400).json({ error: 'Subtitle URL is required.' });
    }

    const subRes = await fetchWithTimeout(subtitleUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    }, 5000);

    if (!subRes.ok) {
      return res.status(subRes.status).send('Failed to fetch subtitle content from upstream.');
    }

    const text = await subRes.text();
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    return res.send(text);
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Subtitle proxy failed.' });
  }
});


// TinyFish live-web context API. Credentials are server-only; browser clients never receive the provider key.
function tinyFishConfigured() {
  return Boolean((process.env.TINYFISH_API_KEY || '').trim());
}

function tinyFishIsPublicWebUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    const host = url.hostname.toLowerCase().replace(/^\\[|\\]$/g, '');
    if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false;
    if (host.includes(':')) {
      const ip = host.toLowerCase();
      if (ip === '::1' || ip === '::' || ip.startsWith('fc') || ip.startsWith('fd') || /^fe[89ab]/.test(ip) || ip.startsWith('::ffff:')) return false;
    } else if (/^\\d{1,3}(?:\\.\\d{1,3}){3}$/.test(host)) {
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

  // Search result snippets are treated as untrusted external content. Avoid forwarding
  // the search query or credentials to any host other than TinyFish's fixed API endpoint.

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
      // Do not return the provider response body; it may contain request diagnostics.
      return res.status(upstream.status === 429 ? 429 : 502).json({
        error: upstream.status === 429
          ? 'TinyFish search rate limit reached. Try again shortly.'
          : `TinyFish search request failed (HTTP ${upstream.status}).`
      });
    }

    const payload: any = await upstream.json();
    // TinyFish Search returns results inside a top-level { results: [...] } object.
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

// Video enhancer gateway. The browser talks only to these same-origin endpoints;
// the private worker credential remains on the app server.
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
  const baseUrl = (process.env.VIDEO_WORKER_URL || '').trim().replace(/\\/$/, '');
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
  let uploadPath = '';
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
      const split = part.indexOf('\\r\\n\\r\\n');
      if (split < 0) continue;
      const headers = part.slice(0, split);
      const value = part.slice(split + 4).replace(/\\r\\n$/, '').replace(/\\r\\n--$/, '');
      if (/name="file"/i.test(headers)) {
        const nameMatch = headers.match(/filename="([^"]*)"/i);
        filename = (nameMatch?.[1] || 'video.mp4').split(/[\\/]/).pop() || 'video.mp4';
        fileBytes = Buffer.from(value, 'latin1');
      } else if (/name="settings"/i.test(headers)) {
        settingsJson = Buffer.from(value, 'latin1').toString('utf8');
      }
    }
    if (!fileBytes?.length) return res.status(400).json({ error: 'A non-empty video file is required.' });
    if (!/\\.(mp4|mov|webm|m4v|avi|mkv)$/i.test(filename)) {
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

// 4. Mount Vite Dev Middlewares or Production Static Files
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
