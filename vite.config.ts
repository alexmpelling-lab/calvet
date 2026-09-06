import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  server: {
    proxy: {
      // Mirrors the Cloudflare Worker's /hf-proxy route (worker/index.ts)
      // for local dev — same-origin here too, so `npm run dev` sees the
      // identical CORS-free path production uses instead of a different
      // code path that only gets exercised once deployed.
      '/hf-proxy': {
        target: 'https://huggingface.co',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/hf-proxy/, ''),
      },
    },
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'Calvet',
        short_name: 'Calvet',
        description: 'Your voice-activated calendar secretary',
        theme_color: '#ffffff',
        background_color: '#ffffff',
        display: 'standalone',
        orientation: 'portrait',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        maximumFileSizeToCacheInBytes: 10 * 1024 * 1024,
        // The ONNX Runtime WASM binary (used lazily by the neural voice) is
        // large and only needed after the user first speaks — don't force
        // it into the eager install-time precache, but do cache it at
        // runtime once fetched so it's offline-ready after first use.
        globIgnores: ['**/*.wasm'],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.endsWith('.wasm'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'wasm-runtime-cache',
              expiration: { maxEntries: 10 },
            },
          },
        ],
      },
    }),
  ],
})
