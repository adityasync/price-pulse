import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Local dev convenience: backend on :3001 without CORS/env juggling.
      '/search': 'http://localhost:3001',
      '/track': 'http://localhost:3001',
      '/tracked': 'http://localhost:3001',
      '/products': 'http://localhost:3001',
      '/export.csv': 'http://localhost:3001',
      '/health': 'http://localhost:3001',
      '/scrape': 'http://localhost:3001',
    },
  },
});
