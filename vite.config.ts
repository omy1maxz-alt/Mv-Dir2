import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import fs from 'fs';

function setupCustomMiddlewares(middlewares: any) {
  middlewares.use(async (req: any, res: any, next: any) => {
    // 1. In-App Browser Proxy Endpoint (strips X-Frame-Options and injects <base>)
    if (req.url && req.url.startsWith('/api/proxy')) {
      try {
        const parsedUrl = new URL(req.url, 'http://localhost:3000');
        const targetUrl = parsedUrl.searchParams.get('url');
        if (!targetUrl) {
          res.statusCode = 400;
          res.end('Missing url parameter');
          return;
        }

        const headers: Record<string, string> = {
          'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9'
        };

        const response = await fetch(targetUrl, {
          headers,
          redirect: 'follow'
        });

        const contentType = response.headers.get('content-type') || 'text/html; charset=utf-8';
        res.setHeader('Content-Type', contentType);
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
        // Do NOT forward x-frame-options or content-security-policy

        if (contentType.includes('text/html')) {
          let html = await response.text();
          const targetOrigin = new URL(response.url || targetUrl).origin;
          const baseTag = `<base href="${targetOrigin}/" target="_self">`;
          if (html.includes('<head>')) {
            html = html.replace('<head>', `<head>${baseTag}`);
          } else {
            html = baseTag + html;
          }
          res.statusCode = response.status;
          res.end(html);
        } else {
          const buffer = await response.arrayBuffer();
          res.statusCode = response.status;
          res.end(Buffer.from(buffer));
        }
      } catch (err: any) {
        res.statusCode = 502;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;padding:20px;background:#111;color:#fff;"><h2>Proxy Error</h2><p>${err.message}</p></body></html>`);
      }
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
          ignored: ['**/agent_bridge.json']
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
      define: {
        'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY),
        'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY)
      },
      build: {
        outDir: 'dist',
        emptyOutDir: true,
        sourcemap: false,
        chunkSizeWarningLimit: 3000,
      },
      resolve: {
        alias: {
          '@': path.resolve(__dirname, './src'),
        }
      }
    };
});
