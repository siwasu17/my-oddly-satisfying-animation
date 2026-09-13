import { defineConfig, type Plugin } from 'vite';
import { sceneAddedAt } from './scripts/scene-order.mjs';

const VIRTUAL_ID = 'virtual:scene-added-at';
const RESOLVED_ID = '\0' + VIRTUAL_ID;

/**
 * シーンの追加日を src/scenes/index.ts へ渡す。
 *
 * 並び順（新しいシーンほど先頭）は git の履歴から決めていて、ブラウザ側からは git が見えない。
 * ビルド時にここで読んで仮想モジュールに焼き込む。
 */
function sceneAddedAtPlugin(): Plugin {
  return {
    name: 'scene-added-at',
    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_ID : undefined;
    },
    load(id) {
      if (id !== RESOLVED_ID) return undefined;
      return `export const ADDED_AT = ${JSON.stringify(sceneAddedAt())};`;
    },
    configureServer(server) {
      // dev 中にシーンを足した／消したら履歴を読み直す（コミット前は履歴に無く、先頭に出る）
      const refresh = (file: string) => {
        if (!/src[\\/]scenes[\\/][^\\/]+\.ts$/.test(file)) return;
        const mod = server.moduleGraph.getModuleById(RESOLVED_ID);
        if (mod) server.moduleGraph.invalidateModule(mod);
        server.ws.send({ type: 'full-reload' });
      };
      server.watcher.on('add', refresh);
      server.watcher.on('unlink', refresh);
    },
  };
}

export default defineConfig({
  // どのパスに置いても動くよう相対パスで出力する
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 900 },
  plugins: [sceneAddedAtPlugin()],
});
