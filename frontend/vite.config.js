import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../public',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:5309',
        changeOrigin: true,
      },
      '/healthz': {
        target: 'http://localhost:5309',
        changeOrigin: true,
      },
      '/readyz': {
        target: 'http://localhost:5309',
        changeOrigin: true,
      },
      '/socket.io': {
        target: 'http://localhost:5309',
        changeOrigin: true,
        ws: true,
      }
    }
  }
})
