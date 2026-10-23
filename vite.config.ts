import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import fs from 'fs';
import { handleYouTubeAndBrowserApiMiddleware } from './src/server/youtubeAndBrowserHandlers';
import { handleGeminiUploadMiddleware } from './src/server/geminiUploadHandler';

function setupCustomMiddlewares(middlewares: any) {
  // 1. Streaming Proxy for Gemini File API (Uploads >20MB)
  middlewares.use(async (req: any, res: any, next: any) => {
    try {
      const handled = await handleGeminiUploadMiddleware(req, res);
      if (!handled && next) next();
    } catch (e) {
      if (next) next(e);
    }
  });

  // 2. Unified YouTube Extraction, Captions, Stream Proxy & Smart Web Browser Proxy
  middlewares.use((req: any, res: any, next: any) => {
    void handleYouTubeAndBrowserApiMiddleware(req, res, next);
  });

  middlewares.use(async (req: any, res: any, next: any) => {
    // Cloudflare Workers AI same-origin proxy for Vite dev/preview.
    if (req.url === '/api/cloudflare-image' && req.method === 'POST') {
      let rawBody = '';
      req.on('data', (chunk: any) => { rawBody += chunk; });
      req.on('end', async () => {
        try {
          const body = JSON.parse(rawBody || '{}');
          const accountId = String(body.accountId || '').trim();
          const apiToken = String(body.apiToken || '').trim();
          const action = body.action === 'text' ? 'text' : 'image';
          const model = String(body.model || (action === 'text' ? '@cf/meta/llama-3.3-70b-instruct-fp8-fast' : '@cf/black-forest-labs/flux-1-schnell')).trim();
          const input = body.input && typeof body.input === 'object' && !Array.isArray(body.input)
            ? body.input
            : Object.fromEntries(['prompt', 'width', 'height', 'seed'].filter((key) => body[key] !== undefined).map((key) => [key, body[key]]));
          if (!accountId || !apiToken) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Cloudflare credentials are required.' }));
            return;
          }
          if (action === 'image' && (typeof input.prompt !== 'string' || !input.prompt.trim())) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'An image prompt is required.' }));
            return;
          }
          if (action === 'text' && !Array.isArray(input.messages) && typeof input.prompt !== 'string') {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'A text prompt or messages array is required.' }));
            return;
          }
          if (!/^[a-zA-Z0-9_-]+$/.test(accountId) || !/^@?[-a-zA-Z0-9_./]+$/.test(model) || model.includes('..')) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Invalid Cloudflare account ID or model identifier.' }));
            return;
          }
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 90000);
          let upstream: Response;
          try {
            upstream = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${model}`, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
              body: JSON.stringify(input),
              signal: controller.signal
            });
          } finally {
            clearTimeout(timeout);
          }
          const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
          if (!upstream.ok) {
            const details = (await upstream.text()).slice(0, 1000)
              .replaceAll(apiToken, '[redacted]')
              .replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [redacted]');
            res.statusCode = upstream.status;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: `Cloudflare Workers AI rejected the request (HTTP ${upstream.status}).`, details }));
            return;
          }
          if (!contentType.includes('application/json') && !contentType.startsWith('image/')) {
            res.statusCode = 502;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: `Cloudflare returned an unexpected content type: ${contentType}` }));
            return;
          }
          res.statusCode = 200;
          res.setHeader('Content-Type', contentType);
          res.setHeader('Cache-Control', 'no-store');
          if (contentType.includes('application/json')) {
            res.end(await upstream.text());
          } else {
            res.end(Buffer.from(await upstream.arrayBuffer()));
          }
        } catch (error: any) {
          res.statusCode = error?.name === 'AbortError' ? 504 : 502;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: error?.name === 'AbortError' ? 'Cloudflare Workers AI request timed out.' : 'Could not connect to Cloudflare Workers AI from the development server.' }));
        }
      });
      return;
    }

    // 2. Agent Bridge Endpoints
    if (req.url === '/api/agent-bridge' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk: any) => { body += chunk; });
      req.on('end', () => {
        try {
          fs.writeFileSync(path.resolve(__dirname, 'agent_bridge.json'), body);
          res.statusCode = 200;
          res.end('ok');
        } catch (e) {
          res.statusCode = 500;
          res.end('error');
        }
      });
      return;
    }
    if (req.url === '/api/agent-bridge' && req.method === 'GET') {
      try {
        const data = fs.readFileSync(path.resolve(__dirname, 'agent_bridge.json'), 'utf-8');
        res.setHeader('Content-Type', 'application/json');
        res.end(data);
      } catch (e) {
        res.setHeader('Content-Type', 'application/json');
        res.end('{}');
      }
      return;
    }

    next();
  });
}

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    return {
      server: {
        port: 3000,
        host: '0.0.0.0',
        hmr: false,
        ws: false,
        watch: {
          ignored: ['**/agent_bridge.json', '**/android/**', '**/build_apk_work/**', '**/dist/**', '**/build/**', '**/export/**']
        },
      },
      plugins: [
        tailwindcss(),
        react(),
        VitePWA({
          registerType: 'autoUpdate',
          includeAssets: ['icon.svg', 'apple-touch-icon.png', 'pwa-192x192.png', 'pwa-512x512.png', 'pwa-maskable-512x512.png'],
          manifest: {
            id: '/',
            name: 'MV Director AI Studio',
            short_name: 'MV Director',
            description: 'Professional-grade cinematic music video storyboarding and AI visual director engineered exclusively for mobile touch workflows.',
            theme_color: '#000000',
            background_color: '#000000',
            display: 'standalone',
            orientation: 'portrait',
            start_url: '/',
            scope: '/',
            icons: [
              {
                src: '/pwa-192x192.png',
                sizes: '192x192',
                type: 'image/png',
                purpose: 'any',
              },
              {
                src: '/pwa-512x512.png',
                sizes: '512x512',
                type: 'image/png',
                purpose: 'any',
              },
              {
                src: '/pwa-maskable-512x512.png',
                sizes: '512x512',
                type: 'image/png',
                purpose: 'maskable',
              },
            ],
          },
          workbox: {
            globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2,json}'],
            maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
            navigateFallback: '/index.html',
            navigateFallbackDenylist: [/^\/api/],
            runtimeCaching: [
              {
                urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
                handler: 'CacheFirst',
                options: {
                  cacheName: 'google-fonts-stylesheets',
                  expiration: {
                    maxEntries: 20,
                    maxAgeSeconds: 60 * 60 * 24 * 365, // 1 year
                  },
                  cacheableResponse: {
                    statuses: [0, 200],
                  },
                },
              },
              {
                urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
                handler: 'CacheFirst',
                options: {
                  cacheName: 'google-fonts-webfonts',
                  expiration: {
                    maxEntries: 30,
                    maxAgeSeconds: 60 * 60 * 24 * 365, // 1 year
                  },
                  cacheableResponse: {
                    statuses: [0, 200],
                  },
                },
              },
              {
                urlPattern: /\.(?:png|jpg|jpeg|svg|gif|webp|ico)$/i,
                handler: 'StaleWhileRevalidate',
                options: {
                  cacheName: 'static-image-assets',
                  expiration: {
                    maxEntries: 100,
                    maxAgeSeconds: 60 * 60 * 24 * 30, // 30 days
                  },
                  cacheableResponse: {
                    statuses: [0, 200],
                  },
                },
              },
              {
                urlPattern: /\.(?:js|css)$/i,
                handler: 'StaleWhileRevalidate',
                options: {
                  cacheName: 'static-resources',
                  expiration: {
                    maxEntries: 100,
                    maxAgeSeconds: 60 * 60 * 24 * 30,
                  },
                  cacheableResponse: {
                    statuses: [0, 200],
                  },
                },
              },
            ],
          },
          devOptions: {
            enabled: false,
            type: 'module',
          },
        }),
        {
          name: 'agent-bridge',
          configureServer(server) {
            setupCustomMiddlewares(server.middlewares);
          },
          configurePreviewServer(server) {
            setupCustomMiddlewares(server.middlewares);
          }
        }
      ],
      build: {
        outDir: 'dist',
        emptyOutDir: true,
        sourcemap: false,
        chunkSizeWarningLimit: 3000,
      },
      resolve: {
        alias: {
          '@': path.resolve(__dirname, './src'),
        },
        dedupe: ['react', 'react-dom']
      },
      optimizeDeps: {
        entries: ['index.html'],
        include: [
          'react',
          'react-dom',
          'react-dom/client',
          'react/jsx-runtime',
          'react/jsx-dev-runtime',
          '@emotion/is-prop-valid',
          'lucide-react',
          'motion/react',
          'idb-keyval'
        ]
      }
    };
});
