import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  resolve: {
    // Prefer TS/TSX modules when duplicate legacy JS files exist.
    extensions: ['.tsx', '.ts', '.jsx', '.js', '.json'],
  },
  plugins: [react()],
})
