import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  // Served from /dashboard/ in production behind Fastify static serving.
  base: '/dashboard/',
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Proxy API calls to the Ouija server in dev mode.
    proxy: {
      '/api': 'http://localhost:4000',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
});
