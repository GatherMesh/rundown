import { copyFile, mkdir } from 'node:fs/promises';
await mkdir(new URL('../functions/assets', import.meta.url), { recursive: true });
await copyFile(
  new URL('../node_modules/@fontsource/inter/files/inter-latin-400-normal.woff', import.meta.url),
  new URL('../functions/assets/inter-latin-400-normal.woff', import.meta.url),
);
