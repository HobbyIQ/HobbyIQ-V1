import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API_BASE_URL = process.env.VITE_API_BASE_URL || 'http://localhost:4000';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/compiq': API_BASE_URL,
      '/portfolio': API_BASE_URL,
    },
    port: 5173,
    open: true,
  },
});
