/**
 * オフラインでも起動できるようにするための Service Worker。
 *
 * ビルド成果物は index.html とハッシュ付きの JS だけなので、Workbox のような
 * プリキャッシュ一覧は持たず、実際に要求されたものをその場でキャッシュする方式にしている。
 * HTML を network-first にしておけば、新しいビルドの HTML が新しいハッシュの JS を
 * 指すため、SW 側にファイル名を埋め込まなくても自然に新版へ入れ替わる。
 */

/** キャッシュの世代。作り方を変えたときはここを上げて古いものを捨てる。 */
const VERSION = 'v1';
/** ナビゲーション（HTML）用 */
const SHELL = `shell-${VERSION}`;
/** JS・アイコン・マニフェスト用 */
const ASSETS = `assets-${VERSION}`;

/** 起点。SW の位置がそのまま配信ディレクトリなので、サブパス配信でもこれで当たる。 */
const ROOT = new URL('./', self.location.href).href;

/** 古いハッシュの JS が溜まり続けないよう、アセットのキャッシュ数に上限を設ける。 */
const ASSET_LIMIT = 24;

/**
 * キャッシュ照合時は Vary を無視する。
 *
 * 配信側が `Vary: Origin` を返す一方、モジュールスクリプトの取得だけは Origin
 * ヘッダを送る。素直に照合すると、同じ URL でも SW 内の fetch() で保存した
 * レスポンスに当たらず、オフライン時に本体 JS だけ読めなくなる。
 */
const MATCH = { ignoreVary: true };

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      // reload 指定で、SW 更新時に HTTP キャッシュの古い HTML を拾わないようにする
      const res = await fetch(new Request(ROOT, { cache: 'reload' }));
      const shell = await caches.open(SHELL);
      await shell.put(ROOT, res.clone());

      // 初回訪問のロードは SW がまだ制御していないため、JS は fetch を通らない。
      // ここで HTML から参照先を拾って先に取っておかないと、
      // 「開いた直後に機内モード」で本体が無いという状態になる。
      const html = await res.text();
      const urls = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map(
        (m) => new URL(m[1], ROOT).href,
      );
      const assets = await caches.open(ASSETS);
      await Promise.all(
        urls.map((u) =>
          fetch(u).then(
            (r) => (r.ok ? assets.put(u, r) : undefined),
            // 1 つ取れなかっただけで install 全体を失敗させない
            () => undefined,
          ),
        ),
      );

      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k !== SHELL && k !== ASSETS).map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(networkFirst(req));
  } else {
    event.respondWith(staleWhileRevalidate(event));
  }
});

/**
 * HTML は毎回ネットワークを試す。落ちていればキャッシュ、それも無ければ起点の HTML。
 * 単一ページなので、どの URL で開かれても最後は起点の HTML を返せば表示できる。
 */
async function networkFirst(req) {
  const cache = await caches.open(SHELL);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(ROOT, res.clone());
    return res;
  } catch {
    return (await cache.match(req, MATCH)) ?? (await cache.match(ROOT, MATCH)) ?? Response.error();
  }
}

/**
 * JS などはキャッシュがあれば即返し、裏で更新を取りに行く。
 * ファイル名にハッシュが付いているので、古いものを返してしまう心配はない。
 */
async function staleWhileRevalidate(event) {
  const req = event.request;
  const cache = await caches.open(ASSETS);
  const hit = await cache.match(req, MATCH);

  const update = fetch(req)
    .then(async (res) => {
      if (res.ok) {
        await cache.put(req, res.clone());
        await trim(cache);
      }
      return res;
    })
    .catch(() => undefined);

  if (hit) {
    // 更新はバックグラウンドで進めたいので、待たずにキャッシュを返す。
    // respondWith の解決後も SW が生き続けるよう waitUntil でつなぎ止める。
    event.waitUntil(update);
    return hit;
  }
  return (await update) ?? Response.error();
}

/** cache.keys() は挿入順に返るので、先頭（＝古いもの）から削る。 */
async function trim(cache) {
  const keys = await cache.keys();
  if (keys.length <= ASSET_LIMIT) return;
  await Promise.all(keys.slice(0, keys.length - ASSET_LIMIT).map((k) => cache.delete(k)));
}
