import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
export default defineConfig({
  plugins: [viteSingleFile()],
  build: {
    outDir: '../functions/print',
    emptyOutDir: true,
    rollupOptions: { input: 'src/render/print.html' },
  },
});
