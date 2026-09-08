# my-oddly-satisfying-animation

Three.js のループアニメーションを、複数の Claude Code セッションで **並列に** 増やすためのリポジトリ。

- ビルド: Vite / 言語: TypeScript / 3D: Three.js / パッケージマネージャ: npm
- アプリは 1 本。`src/scenes/` の各ファイルが 1 シーンで、タブと自動切替で切り替わる。

---

## いちばん大事なルール（並列作業の作法）

複数のセッションが同時に動いている前提で作業すること。事故はほぼすべて
「共有ファイルを勝手に触った」ことが原因になる。

### 1. 自分のシーンのファイルだけを編集する

担当が `<name>` なら、書き換えてよいのは **`src/scenes/<name>.ts` の 1 ファイルだけ**。

以下は全セッションの共有物なので、**変更が必要になったら自分で直さずユーザーに報告して指示を仰ぐ**：

- `src/stage.ts`（レンダラ・カメラ・ライト・ブルーム）
- `src/palette.ts`（暖色パレット）、`src/audio.ts`（効果音）、`src/ui.ts`（タブ・キー操作）
- `src/main.ts`、`src/types.ts`、`src/scenes/index.ts`
- `index.html`、`package.json`、`vite.config.ts`、`tsconfig.json`
- `README.md`、この `CLAUDE.md`、`docs/`、`templates/`、`scripts/`、`.github/`

共通化したくなっても、まずは自分のシーン内に書く。3〜4 本のシーンで同じものが必要に
なって初めて共通化する（判断はユーザーが行う）。共有コードが厚いほど衝突面が増える。

### 2. シーンの登録作業は無い

`src/scenes/index.ts` が同じ階層の `.ts` を `import.meta.glob` で自動収集する。
**新しいシーンを足すときにこのファイルを編集しないこと。** 編集すると並列セッションと衝突する。

タブは**新しいシーンほど先頭**に並ぶ（`ORDER` は追加順で、表示はそれを逆に辿る。`ORDER` に
無いシーンは最新扱いで先頭に付く）。`ORDER` への追記と並びの調整はユーザーの仕事。
シーンを足すたび既存の `#N` はずれる。URL の番号は固定されない。

シーンの説明は README に書かない。**そのファイルの冒頭コメントと `SceneModule.desc`** に書く。

### 3. 依存追加は勝手にしない

`package-lock.json` は全セッションで共有される唯一の危険なファイル。
`npm install <package>` が必要になったら **必ず先にユーザーへ報告する**。
シーンは Three.js のプリミティブだけで作れるはず。

### 4. コミットは自分のブランチにだけ

自分のブランチは `scene/<name>`。`main` に直接コミットしない。push はユーザーが行う。

`main` への取り込みは `npm run merge-scene <name>` で行う。**手で `git merge` しない。**
未コミットの変更や lockfile の衝突、他セッションが使用中の worktree を、このスクリプトが見てくれる。

### 5. dev サーバー

- ポートは **指定しない**。Vite が空いているポートへ自動で繰り上げる。
  ポートを固定すると他セッションの dev サーバーと必ず衝突する。
- 確認が終わったら落とす。起動しっぱなしにしない。
- **例外**: 完成報告のとき、`npm run play -- --bg <name>` で 1 本だけ起動したまま渡す。
  止め方（`npm run play -- --stop <name>`）も一緒に伝えること。

---

## よく使うコマンド

```bash
/new-scene <scene-name> <コンセプト>    # 仕様決め〜実装〜検証〜コミットまで通しで行う（推奨）
npm run new-scene <scene-name>          # 足場だけ手で作る。src/scenes/<camelCase>.ts ができる

npm run dev                             # ポートは自動採番
npm run typecheck
npm run build                           # tsc --noEmit + vite build
npm run smoke <camelCase>               # dev サーバーを立てて配信確認し、必ず落とす
npm run shot -- <camelCase>             # #N へ直行して撮り、ページ内 JS エラーを判定する

npm run play -- --bg <name>             # 完成報告用に背面で起動して URL を出す（--list / --stop）

npm run merge-scene <name>              # main へ取り込む（親リポジトリで実行）
npm run merge-scene <name> -- --dry-run # 何をするか見るだけ
npm run merge-scene -- --list           # マージできる scene/* ブランチの一覧
```

**完了報告の前に必ず** `npm run typecheck` → `npm run build` → `npm run smoke <camelCase>` を通すこと。
build が通っても、`#app` が見つからない・モジュール解決に失敗するといった実行時の問題は build では拾えない。

## worktree

**セッション内で worktree に入るのが基本。** `EnterWorktree({ name: "<scene-name>" })` で
作業ディレクトリが `.claude/worktrees/<name>` に切り替わる（`/new-scene` が自動で行う）。
作られるブランチ名は `worktree-<name>` なので `git branch -m scene/<name>` で改名する。
抜けるのは `ExitWorktree({ action: "keep" })`。分岐元はローカルの現在の `main`。
worktree には `node_modules` が無いので、入ったら `npm install` する。
複数ターミナルで本当に同時並行させたいときだけ `npm run wt new|list|rm <scene-name>` を使う。

## シーンを書くときの約束

- **`requestAnimationFrame` を直接呼ばない。** ループは `main.ts` が回している。
  シーンが持つのは `build` / `update` / `sound` だけ。
- **形は毎フレーム `t` から作り直す。** 前フレームからの差分を積み上げない
  （タブを離れて戻ったときに崩れるし、開き直すたびに違う絵になる）。
  差分で動かすものには必ず `dt` を掛ける。`x += 0.1` のようなフレーム依存の書き方をしない。
- **`build()` はシーンを開くたびに呼ばれる。** `ticker()` などの状態を持つものはここで作り直す。
- **`build(root)` の子だけに追加する。** そうすれば切替時に `disposeGroup()` がまとめて破棄するので、
  自分で dispose を書く必要はない。root の外（`scene` 直下など）には何も足さない。
- **乱数は固定シードで散らす。** `Math.random()` を build で使うと、開き直すたびに絵が変わる。
- **色は `palette.ts` の `ember()` / `emberColor()` / `SURFACE` を通す。** 青い色相は使わない
  （就寝前に眺める前提で、画面から青い光を抜いてある）。
- **`sound()` に映像へ影響する処理を書かない。** 音が OFF の間は呼ばれない。
  鳴らす瞬間は `t` から逆算する（`ticker()` が「位相が整数をまたいだ回数」を返す）。
- `import type` を使う（型のみの import は `import type` で書く）。
- 300 行を大きく超えそうなら、動きを減らすほうを先に考える。

## ブラウザで見るとき

見た目の確認は `npm run shot -- <camelCase>` で行う。**`agent-browser` を直接叩かない。**
タブを `snapshot -i` して `click` で探しに行かないこと（ref が振り直されて往復に落ちる）。
`build()` の中で投げられた例外は `typecheck` も `build` も `smoke` も拾えず、
`npm run shot` のエラー判定が唯一の網になっている。

起動フラグやサンドボックスまわりの詳細は [`docs/browser-automation.md`](./docs/browser-automation.md)。
実装の解説（水面・効果音・色・PWA）は [`docs/design-notes.md`](./docs/design-notes.md)。
