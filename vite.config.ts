import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// GitHub Pages project site: https://<user>.github.io/have-you-paid/
export default defineConfig({
  plugins: [react()],
  base: '/have-you-paid/',
})
