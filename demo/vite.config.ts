import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
export default defineConfig({
  root: resolve(root, 'demo'),
  base: './',
  plugins: [
    react(),
    {
      name: 'demo-local-fonts',
      enforce: 'pre',
      transform(code, id) {
        if (id.split('?')[0] === resolve(root, 'src/style.css'))
          return code.replace(/^@import url\('https:\/\/fonts\.googleapis\.com[^\n]+\n/, '');
      },
    },
  ],
  resolve: { alias: [{ find: /^\.\/api(?:\.js)?$/, replacement: resolve(root, 'demo/api.ts') }] },
  build: { outDir: resolve(root, '.pages-build'), emptyOutDir: true },
});
