import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  root: fileURLToPath(new URL('./web/', import.meta.url)),
  cacheDir: fileURLToPath(new URL('./.cache/vite/web/', import.meta.url)),
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./web/', import.meta.url)) } },
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    outDir: fileURLToPath(new URL('./dist/admin-web/', import.meta.url)),
    emptyOutDir: true,
    lib: { entry: fileURLToPath(new URL('./web/main.tsx', import.meta.url)), formats: ['es'], fileName: () => 'app.js', cssFileName: 'style' },
  },
});
