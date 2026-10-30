import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// Two pages: the app and the build guide.
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        guide: fileURLToPath(new URL('./guide.html', import.meta.url)),
      },
    },
  },
});
