import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

function envPort(name: string, fallback: number): number {
  const parsed = Number(process.env[name])
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

const appPort = envPort('APP_PORT', 4455)
const vitePort = envPort('VITE_PORT', 5173)

// Dev: Vite on VITE_PORT (default 5173) proxies /api + /collab to APP_PORT
//      (default 4455).
//       HMR uses Vite's own /@vite/* websocket — runs over the same tunnel
//       as everything else, so teammates see hot reload remotely too.
// Prod: the app server serves dist/ directly on 4455 (no Vite involved).
export default defineConfig({
  plugins: [react()],
  server: {
    port: vitePort,
    host: '0.0.0.0',                     // accept connections from the tunnel
    strictPort: false,
    allowedHosts: [                      // allow Cloudflare Tunnel + localhost.run subdomains
      'localhost',
      '.trycloudflare.com',
      '.localhost.run',
      '.lhr.life',
      '.ngrok-free.app',
      '.ngrok.app',
      '.ngrok.io',
    ],
    proxy: {
      '/api': `http://localhost:${appPort}`,
      '/collab': { target: `ws://localhost:${appPort}`, ws: true, changeOrigin: true },
    },
    hmr: {
      // Keep HMR working behind HTTPS/wss tunnels by letting Vite auto-detect
      // the client host from window.location.
      clientPort: undefined,
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
