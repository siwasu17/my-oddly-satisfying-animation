# my-oddly-satisfying-animation

Three.js のループアニメーションを、複数の Claude Code セッションで **並列に** 増やすためのリポジトリ。

- ビルド: Vite / 言語: TypeScript / 3D: Three.js
- パッケージマネージャ: npm
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
- `README.md`、この `CLAUDE.md`、`templates/`、`scripts/`、`.github/`

「palette にこの色があると便利だ」と思ったら、まずは自分のシーン内に書く。
3〜4 本のシーンで同じものが必要になって初めて共通化する（判断はユーザーが行う）。
共有コードが厚いほど並列作業の衝突面が増える。

### 2. シーンの登録作業は無い

`src/scenes/index.ts` が同じ階層の `.ts` を `import.meta.glob` で自動収集する。
**新しいシーンを足すときにこのファイルを編集しないこと。** 編集すると並列セッションと衝突する。

並び順は `index.ts` の `ORDER` 順で、そこに無いシーンはファイル名順で末尾に付く。
新しいシーンは末尾に出るのが正しい状態。並びを整えるのはユーザーの仕事。

README にもシーン表は置いていない。シーンの説明は
**そのファイルの冒頭コメントと `SceneModule.desc`** に書くこと。

### 3. 依存追加は勝手にしない

`package-lock.json` は全セッションで共有される唯一の危険なファイル。
`npm install <package>` が必要になったら **必ず先にユーザーへ報告する**。
シーンは Three.js のプリミティブだけで作れるはず。

### 4. コミットは自分のブランチにだけ

worktree 運用をしている場合、自分のブランチは `scene/<name>`。
`main` に直接コミットしない。push はユーザーが行う。

`main` への取り込みは `npm run merge-scene <name>` で行う。**手で `git merge` しない。**
未コミットの変更や lockfile の衝突、他セッションが使用中の worktree を、このスクリプトが見てくれる。

### 5. dev サーバー

- ポートは **指定しない**。Vite が空いているポートへ自動で繰り上げる（5173 → 5174 → …）。
  ポートを固定すると他セッションの dev サーバーと必ず衝突する。
- 確認が終わったら落とす。起動しっぱなしにしない。
- **例外**: 完成報告のとき、ユーザーがすぐ見られるように `npm run play -- --bg <name>` で 1 本だけ
  起動したまま渡す。止め方（`npm run play -- --stop <name>`）も一緒に伝えること。

---

## よく使うコマンド

```bash
# 新しいシーンを作る（推奨: 仕様決め〜実装〜検証〜コミットまで通しで行う）
/new-scene <scene-name> <コンセプト>

# 足場だけ手で作る場合
npm run new-scene <scene-name>     # kebab-case。src/scenes/<camelCase>.ts ができる

# 動かす・検証する
npm run dev                        # ポートは自動採番
npm run typecheck
npm run build                      # tsc --noEmit + vite build
npm run smoke <camelCase>          # dev サーバーを立てて配信確認し、必ず落とす

# 完成報告のときの引き渡し
npm run play -- --bg <name>        # 背面で起動して URL を出す
npm run play -- --list
npm run play -- --stop <name>

# main に取り込む（親リポジトリで実行する）
npm run merge-scene <name>              # 停止 → マージ → 衝突解決 → 検証 → 後始末
npm run merge-scene <name> -- --dry-run # 何をするか見るだけ
npm run merge-scene -- --list           # マージできる scene/* ブランチの一覧
```

**完了報告の前に必ず** `npm run typecheck` → `npm run build` → `npm run smoke <camelCase>` を通すこと。
build が通っても、`#app` が見つからない・モジュール解決に失敗するといった実行時の問題は build では拾えない。

---

## 並列作業のセットアップ（worktree）

**セッション内で worktree に入るのが基本。** `EnterWorktree` ツールを使うと、いま動いている
セッションの作業ディレクトリがそのまま `.claude/worktrees/<name>` に切り替わる。
別ターミナルで `claude` を起動し直す必要はない。`/new-scene` はこれを自動で行う。

```
EnterWorktree({ name: "<scene-name>" })   # .claude/worktrees/<name> を作ってそこへ移動
git branch -m scene/<scene-name>          # 作られるブランチ名は worktree-<name> なので改名する
ExitWorktree({ action: "keep" })          # 抜ける（"remove" で worktree ごと削除）
```

分岐元はローカルの現在の `main`（`.claude/settings.json` の `worktree.baseRef: "head"`）。
worktree には `node_modules` が無いので、入ったら `npm install` する。

複数ターミナルで本当に同時並行させたいときだけ、手動用のスクリプトを使う:

```bash
bash scripts/wt.sh new <scene-name>   # worktree を作り install まで行う
bash scripts/wt.sh list
bash scripts/wt.sh rm <scene-name>
```

この場合、各セッションは自分の worktree ディレクトリ（`.claude/worktrees/<name>`）で `claude` を起動する。
`.claude/worktrees/` は `.gitignore` に入れてあるため、親リポジトリ側の `git status` や
検索が他セッションの作業を拾うことはない。

---

## ディレクトリ構成

```
src/scenes/<name>.ts   各シーン（1 ファイル = 1 シーン = 1 セッションの担当範囲）
src/scenes/index.ts    シーンの自動収集と並び順（追加時に編集しない）
src/stage.ts           レンダラ / カメラ / ライト / ブルームの共通設定
src/palette.ts         全シーン共通の暖色パレット
src/audio.ts           Web Audio API による効果音（音声ファイルは持たない）
src/ui.ts              タブ・タイトル・キーボード操作
src/main.ts            シーン切替・カメラ補間・メインループ
templates/scene.ts     新規シーンの雛形
scripts/               new-scene.mjs / wt.sh / dev-smoke.sh / play.mjs / merge-scene.mjs
```

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

## Browser Automation

Use `agent-browser` for web automation. Run `agent-browser --help` for all commands.

Core workflow:
1. `agent-browser open <url>` - Navigate to page
2. `agent-browser snapshot -i` - Get interactive elements with refs (@e1, @e2)
3. `agent-browser click @e1` / `fill @e2 "text"` - Interact using refs
4. Re-snapshot after page changes

### サンドボックス環境での起動フラグ

Claude Code をサンドボックス（cage など）付きで動かしていると、`agent-browser open` が
`Auto-launch failed: CDP response channel closed` で失敗する。macOS の seatbelt サンドボックスは
入れ子にできず、Chrome が自前のサンドボックスを初期化できないためで、ディレクトリの
書き込み許可を足しても解消しない。

その場合は起動フラグを渡す:

```bash
export AGENT_BROWSER_ARGS="--no-sandbox,--disable-gpu,--disable-crash-reporter,--disable-breakpad"
```

- `--no-sandbox` … 入れ子サンドボックスの失敗を回避する（これが本体）
- `--disable-gpu` … GPU プロセス起動失敗による `GPU process isn't usable. Goodbye.` を避ける
- `--disable-crash-reporter` `--disable-breakpad` … Crashpad が
  `~/Library/Application Support/Google/Chrome for Testing/` に書けずに出すエラーを黙らせる

`~/.agent-browser`（セッション状態・ソケット・Chrome バイナリ）への書き込みは必須。
