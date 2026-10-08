import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 1420, strictPort: true },
  clearScreen: false,
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: { environment: 'jsdom', setupFiles: ['./src/test/setup.ts'], css: false },
});
