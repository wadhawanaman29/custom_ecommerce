import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Served by the API server at /wp-admin. In dev, API calls are proxied to it.
export default defineConfig({
  base: '/wp-admin/',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/wp-json': 'http://localhost:4000',
      '/wp-content': 'http://localhost:4000',
    },
  },
  build: { outDir: 'dist', chunkSizeWarningLimit: 1500 },
});
