import express, { Request, Response } from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseRawCaptionToSegments, segmentsToSrt, YouTubeCaptionResponse } from './src/services/youtubeCaptionService';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90000);
    let upstream: globalThis.Response;
    try {
      upstream = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${model}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(input),
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

// 1. Backend Extraction API: Resolves 4-tier streams, all formats & subtitles
app.post(['/api/youtube/extract', '/api/resolve-stream'], async (req: Request, res: Response) => {
  try {
    const { url, videoId: directVideoId } = req.body;
    const videoId = directVideoId || extractVideoId(url);

    if (!videoId) {
      return res.status(400).json({ error: 'Valid YouTube URL or videoId is required.' });
    }

    const result = await resolveYouTubeVideoServerSide(videoId);
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
    const resolved = await resolveYouTubeVideoServerSide(videoId);
    const availableTracks = resolved.subtitles || [];

    if (availableTracks.length > 0) {
      // 1. Select best matching track
      let chosenTrack = availableTracks[0];
      if (targetLanguage && targetLanguage !== 'Auto-detect') {
        const lower = targetLanguage.toLowerCase();
        const matched = availableTracks.find(t => 
          t.name.toLowerCase().includes(lower) || t.code.toLowerCase().includes(lower)
        );
        if (matched) chosenTrack = matched;
      } else {
        const manual = availableTracks.find(t => !t.isAutoGenerated && (t.code === 'en' || t.code.startsWith('en')));
        const anyManual = availableTracks.find(t => !t.isAutoGenerated);
        const anyEn = availableTracks.find(t => t.code === 'en' || t.code.startsWith('en'));
        chosenTrack = manual || anyManual || anyEn || availableTracks[0];
      }

      // 2. Fetch track content
      const subRes = await fetchWithTimeout(chosenTrack.url, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      }, 6000);

      if (subRes.ok) {
        const rawContent = await subRes.text();
        const segments = parseRawCaptionToSegments(rawContent);

        if (segments.length > 0) {
          const rawSrt = segmentsToSrt(segments);
          return {
            success: true,
            videoId,
            title: resolved.title,
            source: 'youtube_cc',
            language: chosenTrack.code,
            isAutoGenerated: chosenTrack.isAutoGenerated,
            segments,
            rawSrt,
            duration: resolved.duration,
            thumbnailUrl: resolved.thumbnailUrl,
            availableTracks
          };
        }
      }
    }

    // If no authentic caption tracks exist on YouTube (e.g. video only has burned-in captions or no CC uploaded)
    return {
      success: true,
      videoId,
      title: resolved.title,
      source: 'unavailable',
      requiresTranscription: true,
      reason: 'CAPTIONS_NOT_AVAILABLE',
      message: 'Authentic YouTube closed captions (CC) are not uploaded for this video. You can transcribe the audio track directly using Gemini Multimodal AI.',
      duration: resolved.duration,
      thumbnailUrl: resolved.thumbnailUrl,
      availableTracks: []
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
