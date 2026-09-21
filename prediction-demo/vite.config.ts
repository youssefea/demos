import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@vibenet/aa': new URL('../200ms-demo/vendor/aa/index.js', import.meta.url).pathname } },
  server: { port: 5175, fs: { allow: ['..'] } },
})
