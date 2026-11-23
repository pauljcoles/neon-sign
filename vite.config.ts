import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Two pages: the app and the build guide. Relative asset paths let the same build run at any address,
// such as GitHub Pages under /neon-sign/.
export default defineConfig({
  base: './',
  // Building a whole 900 mm sign takes a couple of seconds, and the CI machine is slower than a desktop.
  test: { testTimeout: 30000 },
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        guide: fileURLToPath(new URL('./guide.html', import.meta.url)),
      },
    },
  },
});
