import { defineConfig } from '#q-app/wrappers';
export default defineConfig(() => ({
  boot: ['firebase'],
  css: ['app.scss'],
  extras: ['material-icons'],
  build: { target: { browser: ['es2022'], node: 'node20' }, vueRouterMode: 'history' },
  devServer: { port: 9000, open: false, host: '0.0.0.0' },
  framework: { config: { brand: { primary: '#2457D6' } }, plugins: ['Notify', 'Dialog'] },
}));
