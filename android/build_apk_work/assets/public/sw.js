/**
 * Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// If the loader is already loaded, just stop.
if (!self.define) {
  let registry = {};

  // Used for `eval` and `importScripts` where we can't get script URL by other means.
  // In both cases, it's safe to use a global var because those functions are synchronous.
  let nextDefineUri;

  const singleRequire = (uri, parentUri) => {
    uri = new URL(uri + ".js", parentUri).href;
    return registry[uri] || (
      
        new Promise(resolve => {
          if ("document" in self) {
            const script = document.createElement("script");
            script.src = uri;
            script.onload = resolve;
            document.head.appendChild(script);
          } else {
            nextDefineUri = uri;
            importScripts(uri);
            resolve();
          }
        })
      
      .then(() => {
        let promise = registry[uri];
        if (!promise) {
          throw new Error(`Module ${uri} didn’t register its module`);
        }
        return promise;
      })
    );
  };

  self.define = (depsNames, factory) => {
    const uri = nextDefineUri || ("document" in self ? document.currentScript.src : "") || location.href;
    if (registry[uri]) {
      // Module is already loading or loaded.
      return;
    }
    let exports = {};
    const require = depUri => singleRequire(depUri, uri);
    const specialDeps = {
      module: { uri },
      exports,
      require
    };
    registry[uri] = Promise.all(depsNames.map(
      depName => specialDeps[depName] || require(depName)
    )).then(deps => {
      factory(...deps);
      return exports;
    });
  };
}
define(['./workbox-b1bafff1'], (function (workbox) { 'use strict';

  self.skipWaiting();
  workbox.clientsClaim();
  /**
   * The precacheAndRoute() method efficiently caches and responds to
   * requests for URLs in the manifest.
   * See https://goo.gl/S9QRab
   */
  workbox.precacheAndRoute([{
    "url": "registerSW.js",
    "revision": "1872c500de691dce40960bb85481de07"
  }, {
    "url": "pwa-maskable-512x512.png",
    "revision": "e360fe3ed3f78af6b9b70f9a11fe8180"
  }, {
    "url": "pwa-512x512.png",
    "revision": "b502dd1c248cfe94d11f60c1db89a115"
  }, {
    "url": "pwa-192x192.png",
    "revision": "e47120c2cb3317e1d6d69bb992e7cc5c"
  }, {
    "url": "index.html",
    "revision": "1f497fb656ba5674764b2b079653a8fa"
  }, {
    "url": "icon.svg",
    "revision": "22f48f43fbac16f5c555f8cc20f04ed3"
  }, {
    "url": "apple-touch-icon.png",
    "revision": "660d03981383a456fe7ea31fd5935771"
  }, {
    "url": "assets/react-Dl6OI0Vd.js",
    "revision": null
  }, {
    "url": "assets/react-CygIO5pK.js",
    "revision": null
  }, {
    "url": "assets/react-ClaDWJMw.js",
    "revision": null
  }, {
    "url": "assets/react-C_CHStbx.js",
    "revision": null
  }, {
    "url": "assets/react-CJZru0dL.js",
    "revision": null
  }, {
    "url": "assets/react-BhDAsNk8.js",
    "revision": null
  }, {
    "url": "assets/react-BZvgs7g2.js",
    "revision": null
  }, {
    "url": "assets/react-B1utgHcO.js",
    "revision": null
  }, {
    "url": "assets/mixin-DIQKSja0.js",
    "revision": null
  }, {
    "url": "assets/index-BtM-yZ0Y.js",
    "revision": null
  }, {
    "url": "assets/index-BpwEfbRA.css",
    "revision": null
  }, {
    "url": "assets/index-B6_3PTYU.js",
    "revision": null
  }, {
    "url": "assets/index-3GxRXUSf.js",
    "revision": null
  }, {
    "url": "assets/hls-MmTFPL5i.js",
    "revision": null
  }, {
    "url": "assets/geminiArchitectPipeline-CCIw9Qyy.js",
    "revision": null
  }, {
    "url": "assets/dash.all.min-B7SfqX9N.js",
    "revision": null
  }, {
    "url": "assets/Preview-Dt5XxbAU.js",
    "revision": null
  }, {
    "url": "apple-touch-icon.png",
    "revision": "660d03981383a456fe7ea31fd5935771"
  }, {
    "url": "icon.svg",
    "revision": "22f48f43fbac16f5c555f8cc20f04ed3"
  }, {
    "url": "pwa-192x192.png",
    "revision": "e47120c2cb3317e1d6d69bb992e7cc5c"
  }, {
    "url": "pwa-512x512.png",
    "revision": "b502dd1c248cfe94d11f60c1db89a115"
  }, {
    "url": "pwa-maskable-512x512.png",
    "revision": "e360fe3ed3f78af6b9b70f9a11fe8180"
  }, {
    "url": "manifest.webmanifest",
    "revision": "573f37eb8efd51bf94e2adf3d19a2348"
  }], {});
  workbox.cleanupOutdatedCaches();
  workbox.registerRoute(new workbox.NavigationRoute(workbox.createHandlerBoundToURL("/index.html"), {
    denylist: [/^\/api/]
  }));
  workbox.registerRoute(/^https:\/\/fonts\.googleapis\.com\/.*/i, new workbox.CacheFirst({
    "cacheName": "google-fonts-stylesheets",
    plugins: [new workbox.ExpirationPlugin({
      maxEntries: 20,
      maxAgeSeconds: 31536000
    }), new workbox.CacheableResponsePlugin({
      statuses: [0, 200]
    })]
  }), 'GET');
  workbox.registerRoute(/^https:\/\/fonts\.gstatic\.com\/.*/i, new workbox.CacheFirst({
    "cacheName": "google-fonts-webfonts",
    plugins: [new workbox.ExpirationPlugin({
      maxEntries: 30,
      maxAgeSeconds: 31536000
    }), new workbox.CacheableResponsePlugin({
      statuses: [0, 200]
    })]
  }), 'GET');
  workbox.registerRoute(/\.(?:png|jpg|jpeg|svg|gif|webp|ico)$/i, new workbox.StaleWhileRevalidate({
    "cacheName": "static-image-assets",
    plugins: [new workbox.ExpirationPlugin({
      maxEntries: 100,
      maxAgeSeconds: 2592000
    }), new workbox.CacheableResponsePlugin({
      statuses: [0, 200]
    })]
  }), 'GET');
  workbox.registerRoute(/\.(?:js|css)$/i, new workbox.StaleWhileRevalidate({
    "cacheName": "static-resources",
    plugins: [new workbox.ExpirationPlugin({
      maxEntries: 100,
      maxAgeSeconds: 2592000
    }), new workbox.CacheableResponsePlugin({
      statuses: [0, 200]
    })]
  }), 'GET');

}));
