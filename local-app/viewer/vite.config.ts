import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('./ui/', import.meta.url)),
  publicDir: fileURLToPath(new URL('../../public/', import.meta.url)),
  build: {
    outDir: fileURLToPath(new URL('../../.output/viewer/', import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
  },
});
