import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// Root package.json is the release-version authority (bumped alongside the
// server, not the client's own package.json) - read it via createRequire
// rather than a JSON import assertion, since Vite 5's config file runs
// directly under Node and this avoids the assert/with-syntax churn.
const require = createRequire(import.meta.url);
const pkg = require('../package.json');

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/favicon-32.png', 'icons/apple-touch-icon.png'],
      manifest: {
        name: 'RackStack',
        short_name: 'RackStack',
        description: 'Self-hosted idle infrastructure tycoon - spare Pi to hyperscale.',
        theme_color: '#0E141B',
        background_color: '#0E141B',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // This app is server-authoritative (saves, auth) - never let the
        // service worker serve stale API/auth responses from cache.
        navigateFallbackDenylist: [/^\/api\//, /^\/auth\//],
        runtimeCaching: [
          {
            urlPattern: /^\/api\//,
            handler: 'NetworkOnly',
          },
          {
            urlPattern: /^\/auth\//,
            handler: 'NetworkOnly',
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('../shared', import.meta.url)),
    },
  },
  server: {
    fs: {
      allow: ['..'],
    },
    proxy: {
      '/api': 'http://localhost:3000',
      '/auth': 'http://localhost:3000',
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
});
