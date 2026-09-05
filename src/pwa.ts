/**
 * Service Worker の登録。
 *
 * オフラインで起動できるようにするためだけのもので、映像や音には関わらない。
 * 登録できなくてもオンラインなら普通に動くので、失敗は握り潰す。
 */
export function registerServiceWorker(): void {
  // 開発サーバでキャッシュされると変更が反映されず紛らわしいので、本番だけ登録する
  if (!import.meta.env.PROD) return;
  if (!('serviceWorker' in navigator)) return;

  // 初回表示の負荷を上げたくないので、読み込みが済んでから登録する
  window.addEventListener('load', () => {
    // 相対パスはドキュメントの base URL 基準で解決されるため、
    // GitHub Pages のサブパス配信でもスコープが配信ディレクトリに揃う
    navigator.serviceWorker.register('./sw.js').catch(() => {
      // プライベートモードなどで登録できないことがある
    });
  });
}
