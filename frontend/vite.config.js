import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    allowedHosts: ['docker', '.ts.net', 'localhost'],
    watch: {
      // КРИТИЧЕСКИ ВАЖНО: Заставит Vite проверять файлы каждую секунду, 
      // что обязательно при работе через сетевой диск Y:
      usePolling: true, 
      interval: 500,
      ignored: [
        '**/games/**', 
        '**/_tmp_uploads/**', 
        '**/.audio-cache/**',
        '**/_saves/**'
      ]
    },
    proxy: {
      '/api': {
        target: 'http://rpg-library:3000', 
        changeOrigin: true,
      },
      // Шрифт перевода (api/public/fonts) — для предпросмотра на экране «Картинки»
      '/fonts': {
        target: 'http://rpg-library:3000',
        changeOrigin: true,
      },
      '/socket.io': {
        target: 'http://rpg-library:3000',
        ws: true, 
      },
      '/media': {
        target: 'http://rpg-library:3000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/media/, '') 
      }
    }
  }
})
