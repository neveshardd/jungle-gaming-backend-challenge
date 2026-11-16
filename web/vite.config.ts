import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The console always calls `/api/...`; in dev Vite proxies it to the load balancer of the
// docker compose stack (no CORS needed). In the `web` container, nginx does the same.
const target = process.env.API_URL ?? 'http://localhost:8080';

export default defineConfig({
  plugins: [react({ jsxImportSource: '@emotion/react' })],
  server: {
    port: 5173,
    proxy: {
      '/api': { target, changeOrigin: true, rewrite: (path) => path.replace(/^\/api/, '') },
    },
  },
});
