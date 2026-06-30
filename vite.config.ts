import { defineConfig, loadEnv } from 'vite'
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

  const proxyEntry = (prefix: string, target: string) => ({
    target,
    changeOrigin: true,
    rewrite: (path: string) => path.replace(new RegExp(`^${prefix}`), ''),
    headers: proxyHeaders,
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
      '/api-proxy':    proxyEntry('/api-proxy',    env.VITE_API_URL    ?? 'https://api.devnet.satoshitable.fun'),
      '/config-proxy': proxyEntry('/config-proxy', env.VITE_CONFIG_URL ?? 'https://config.devnet.satoshitable.fun'),
      '/price-proxy':  proxyEntry('/price-proxy',  env.VITE_PRICE_URL  ?? 'https://price.devnet.satoshitable.fun'),
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
