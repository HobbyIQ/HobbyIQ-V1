import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/compiq': 'http://localhost:4000',
      '/portfolio': 'http://localhost:4000',
    },
    port: 5173,
    open: true,
  },
});
