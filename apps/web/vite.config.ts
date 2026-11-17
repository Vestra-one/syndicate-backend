import { defineConfig, loadEnv, type ProxyOptions } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  // Dev proxy: browser hits /api-proxy/... (same origin, no CORS preflight).
  // Vite strips the prefix, forwards to the real API, and injects Basic Auth
  // server-side — so the Authorization header never touches the browser at all.
  // Only wired when VITE_DEVNET_USER is set (local dev only).
  const devUser = env.VITE_DEVNET_USER
  const devPass = env.VITE_DEVNET_PASS
  const proxyHeaders: Record<string, string> = devUser && devPass
    ? { Authorization: `Basic ${Buffer.from(`${devUser}:${devPass}`).toString('base64')}` }
    : {}

  const proxyEntry = (prefix: string, target: string): ProxyOptions => ({
    target,
    changeOrigin: true,
    secure: false, // devnet TLS cert doesn't cover all subdomains
    rewrite: (path: string) => path.replace(new RegExp(`^${prefix}`), ''),
    // Inject Basic auth ONLY when the browser sent no Authorization header — the v2
    // session flow sends `Authorization: Bearer <token>`, and a blanket `headers:`
    // override would clobber it (the server then 401s "missing Bearer token").
    configure: (proxy) => {
      proxy.on('proxyReq', (proxyReq) => {
        if (proxyHeaders.Authorization && !proxyReq.getHeader('authorization')) {
          proxyReq.setHeader('Authorization', proxyHeaders.Authorization)
        }
      })
    },
  })

  return {
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    proxy: {
      // v2: one REST surface (VITE_API_URL already ends in /v1) + one WS surface.
      '/api-proxy':   proxyEntry('/api-proxy',   env.VITE_API_URL   ?? 'https://api.devnet.satoshitable.fun/v1'),
      '/price-proxy': proxyEntry('/price-proxy', env.VITE_PRICE_URL ?? 'https://price.devnet.satoshitable.fun'),
      // WebSocket proxies — browser WS API cannot send Authorization headers, so we proxy
      // through Vite which injects Basic Auth server-side. Target must be https://, Vite
      // handles the ws→wss upgrade. secure:false because devnet TLS cert doesn't cover subdomains.
      '/ws-proxy': {
        target: 'https://api.devnet.satoshitable.fun',
        ws: true,
        changeOrigin: true,
        secure: false,
        rewrite: (path: string) => path.replace(/^\/ws-proxy/, '/v1/ws'),
        headers: proxyHeaders,
      },
      '/price-ws-proxy': {
        target: 'https://price.devnet.satoshitable.fun',
        ws: true,
        changeOrigin: true,
        secure: false,
        rewrite: (path: string) => path.replace(/^\/price-ws-proxy/, '/ws'),
        headers: proxyHeaders,
      },
    },
  },
  build: {
    target: 'es2022',
    // three.js is large — split it out of the main app chunk
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
        },
      },
    },
  },
  }
})
