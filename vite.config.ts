import { defineConfig } from 'vite';

export default defineConfig({
  // どのパスに置いても動くよう相対パスで出力する
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 900 },
});
