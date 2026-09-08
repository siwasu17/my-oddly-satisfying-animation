# my-oddly-satisfying-animation

公開 URL: <https://siwasu17.github.io/my-oddly-satisfying-animation/>（`main` への push で自動デプロイ）

Three.js でつくった「見ていて気持ちのいい」ループアニメーション集。
いくつものシーンを自動／手動で切り替えながら眺められます。

就寝前に眺めることを想定して、青い光をほぼ使わず、色と明るさを全体に落としてあります。

## 起動

```sh
npm install
npm run dev        # ポートは自動採番
npm run build      # 型チェック + dist/ へ静的ビルド
npm run preview    # ビルド結果を確認
```

`vite.config.ts` で `base: './'` にしてあるので、`dist/` はどのパスに置いても動きます。

## 操作

| 操作 | 内容 |
| --- | --- |
| `1` – `9` / 画面上部のタブ | シーンを直接選ぶ（10 以降はタブか `←` `→` で） |
| `←` `→` | 前後のシーンへ |
| `Space` | 自動切替（34 秒間隔）の ON / OFF |
| `S` / 右下の「♪ 効果音」ボタン | 効果音の ON / OFF（既定は OFF） |
| ドラッグ / ホイール | 視点の回転・ズーム（放置するとゆっくり自動回転） |

URL の `#2` のようなハッシュで開始シーンを指定できます。切り替えるとハッシュも追従するので、
気に入った状態のリンクをそのまま共有できます。

スマートフォンで開いてブラウザの「ホーム画面に追加」を選ぶと、アドレスバーのない全画面で
起動します。一度開いておけばオフラインでも眺められます。

## シーン

シーンは `src/scenes/` に 1 ファイル 1 本で置いてあり、`src/scenes/index.ts` が
そのディレクトリを丸ごと読み込みます。何をしているかは各ファイル冒頭のコメントと、
アプリのタイトル下に出る 1 行説明（`SceneModule.desc`）に書いてあります。
一覧は起動して画面上部のタブを見るのがいちばん早いです。

シーンを足すときは `src/scenes/` に `SceneModule` を 1 つ export するファイルを置くだけで、
レジストリも README も書き換える必要がありません。1 ファイルで完結するので、複数の
Claude Code セッションで並列に増やせます（`/new-scene` が worktree の用意から
検証・コミットまで通しで行います）。作業ルールは [`CLAUDE.md`](./CLAUDE.md) を参照してください。

## 構成

```
src/
├── main.ts            シーン切替・カメラ補間・メインループ
├── stage.ts           レンダラ / カメラ / ライト / ブルームの共通設定
├── palette.ts         全シーン共通の暖色パレット
├── audio.ts           Web Audio API による効果音（音声ファイルは持たない）
├── ui.ts              タブ・タイトル・キーボード操作
├── pwa.ts             Service Worker の登録（オフライン対応）
├── types.ts           SceneModule インターフェース
└── scenes/            シーン本体（1 ファイル 1 シーン）
    └── index.ts       シーンの自動収集と並び順

templates/scene.ts     新規シーンの雛形
scripts/               new-scene.mjs / wt.sh / dev-smoke.sh / play.mjs / merge-scene.mjs / make-icons.mjs
docs/                  作りのノートとブラウザ自動操作のメモ
```

## もっと詳しく

- [`docs/design-notes.md`](./docs/design-notes.md) — 水面の作り・効果音・色づくり・画面サイズへの追従・PWA
- [`CLAUDE.md`](./CLAUDE.md) — Claude Code セッションの作業ルール
- [`docs/browser-automation.md`](./docs/browser-automation.md) — `npm run shot` と agent-browser
