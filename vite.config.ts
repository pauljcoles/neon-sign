import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// Two pages: the app and the build guide. Relative asset paths let the same build run at any address,
// such as GitHub Pages under /neon-sign/.
export default defineConfig({
  base: './',
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        guide: fileURLToPath(new URL('./guide.html', import.meta.url)),
      },
    },
  },
});
