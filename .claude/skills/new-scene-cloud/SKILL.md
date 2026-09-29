---
name: new-scene-cloud
description: クラウドのセッション（Claude Code on the web）で、新しいループアニメーションを 1 本、人間の確認を挟まずに作り、main にはマージせず GitHub に PR を出して終える。撮影は Playwright（scripts/shot-pw.mjs）で行う。/new-scene-cloud と呼ばれたとき、またはクラウドで「PR まで作って」「PR を出して完了に」と明示されたときだけ使う。ローカルで main まで入れたいときは new-scene-auto、確認を挟みたいときは new-scene を使うこと。
argument-hint: "[scene-name] [シーンのコンセプト]"
user-invocable: true
---

# /new-scene-cloud — 確認を挟まずに PR まで出す

ユーザーの入力: `$ARGUMENTS`

第 1 トークンをシーン名（kebab-case）、残りをコンセプトとして扱う。どちらも省略可能。

## このスキルの位置づけ

`/new-scene-auto` のクラウド版。違いは 2 つだけ。

- **終わり方**: ローカルの `main` へマージせず、**GitHub に PR を出して終える**。
  クラウドのコンテナは使い捨てで、ローカルの `main` に入れても残らないため。
- **撮影**: **`scripts/shot-pw.mjs`（Playwright）で撮る**。

人間の確認を挟まないこと、機械で検証できるゲートを削らないことは `/new-scene-auto` と同じ。

---

## 前提 — 手順の本体は他の 2 本にある

**まず次の 2 つを読むこと。**

1. `.claude/skills/new-scene/SKILL.md` — Phase 0〜7 の手順の本体
2. `.claude/skills/new-scene-auto/SKILL.md` — 確認を省く差分（Phase 3 / 5 / 6）とゲート（Phase 8.5）

このファイルは **`new-scene-auto` からの差分だけ**を定義する。手順をここに書き写さない。
`references/recipes.md` も通常版のもの（`.claude/skills/new-scene/references/recipes.md`）を読む。

差分の一覧:

| Phase | new-scene-auto | このスキル |
| --- | --- | --- |
| 0 | 親リポジトリの `main` にいる前提 | **PR 用のブランチ名を控える**（下記） |
| 1〜3 | 名前 / worktree / 仕様は自分で決める | 同じ |
| 4 | `npm install` | **`npm ci`**（lockfile を書き換えない） |
| 5 | 共有ファイルは触らない | 同じ |
| 6 | `npm run shot` + 講評 | **`node scripts/shot-pw.mjs`** + 講評 |
| 7 | コミット | 同じ |
| 8.5 | ゲート 8 項目 | 5 番だけ差し替え（下記） |
| 9 | `npm run merge-scene` | **push し、プレビューを Artifact に公開して PR を作る。** |
| 10 | `play --bg` で main を起動して報告 | **プレビューと PR の URL、スクショを渡して報告** |

---

## Phase 0 の差分 — PR 用のブランチ名を控える

クラウドのセッションでは、親リポジトリは `main` ではなく、セッションに割り当てられた
`claude/...` ブランチにいることが多い。これは異常ではないので止まらない。

- システムプロンプトに「このブランチで開発して push する」と指定されたブランチがあれば、
  **それを PR のブランチ名として控える**（例: `claude/relaxed-carson-nb309j`）。
- 指定が無ければ `claude/scene-<scene-name>` を使う。
- **`main` や `scene/*` へは push しない。** push できるのは `claude/` で始まるブランチだけ
  （`.claude/settings.json` の許可がそうなっている）。

`git status --porcelain` が空であること、ローカルの `main` が `origin/main` と同じであることを確かめる。
worktree の分岐元は通常版の Phase 2 どおりローカルの `main` に揃える。

---

## Phase 4 の差分 — `npm install` ではなく `npm ci`

```bash
npm ci
```

`npm install` は npm のバージョン差で `package-lock.json` を書き換えることがある。
`npm ci` は lockfile を書き換えない。

それでも `git status --porcelain` に `package-lock.json` が出たら、**コミットせずに戻す**。

```bash
git restore package-lock.json
```

---

## Phase 6 の差分 — `shot-pw.mjs` で撮る

**`npm run shot` を呼ばない。**
代わりにこれを使う:

```bash
node scripts/shot-pw.mjs <camelCase> --at <秒> --at <秒>
```

- `--at` は**シーン内の秒数**。複数渡せる。Playwright の時計を止めて 1 フレーム（0.05 秒）ずつ
  進めるので、描画が遅い環境でも**毎回同じ瞬間**が撮れる。実時間で待つ必要は無い。
- 実行には、撮る秒数 1 秒あたり 4 秒ほどかかる（10 秒目なら 40 秒前後）。タイムアウトは長めに取る。
- ページ内の JS エラーがあれば非ゼロで終了する（`favicon.ico` の 404 は除外済み）。
- 画像は `.claude/.play/shots/<worktree名>-<camelCase>-<秒>s.png` に出る。

**撮る瞬間は仕様カードの時刻表から選ぶ。** 1 回に 2 枚撮る:

1. **動きの途中**（例: 折っている最中、波が立ち上がっている最中）— 講評の本判定に使う
2. **決めの状態**（例: 閉じた箱、揃った瞬間）— 講評の参考に使う

開いた直後（0〜1 秒）はカメラの補間が終わっていないので避ける。

講評は通常版の手順どおり `scene-critic` エージェントに渡す。**PNG を自分で `Read` しない。**
1 枚目を本判定、2 枚目を「参考（〈状態〉のはず）」と書き添えて渡す。
撮り直しは 5 回まで。2 回目以降は `SendMessage` で同じエージェントに渡す。

---

## Phase 8.5 の差分 — ゲート

`new-scene-auto` のゲート 8 項目をそのまま使う。**5 番だけ差し替える:**

5. **`node scripts/shot-pw.mjs` がページ内 JS エラーを報告していない**（終了コード 0）

8 番（差分が `src/scenes/<camelCase>.ts` の 1 行だけ）は、ここでも最重要。
`package-lock.json` が混ざっていたら Phase 4 の手順で戻してから確かめ直す。

ゲートに落ちたら push も PR もしない。worktree とブランチを残して、欠けたものを報告して終える。

---

## Phase 9 — push して PR を作る（マージしない）

`npm run merge-scene` は**実行しない**。worktree の中のまま進めてよい。

### 1. push する

```bash
git push -u origin HEAD:<Phase 0 で控えたブランチ名>
```

ネットワークエラーで失敗したときだけ、2 / 4 / 8 / 16 秒あけて最大 4 回やり直す。

> **push が権限で拒否されたら、そこで止まってユーザーに報告する。**
> GitHub MCP の `push_files` / `create_or_update_file` で中身を上げるといった**別の道具での回避をしない。**
> 拒否されるのは `.claude/settings.json` に許可が無いということで、それを決めるのはユーザー。

push したら、リモートとローカルの中身が一致していることを確かめる:

```bash
git fetch origin <ブランチ名>
git diff --stat HEAD origin/<ブランチ名>    # 何も出なければ一致
git diff --name-only origin/main...origin/<ブランチ名>   # src/scenes/<camelCase>.ts の 1 行だけ
```

### 2. プレビューを Artifact に公開する

静止画だけでは動きの良し悪しが分からない。ビルド結果をそのまま Artifact（claude.ai の非公開ページ）に
上げて、人間がスマホからでもリンク 1 つで実物を見られるようにする。

**1 セッション = 1 Artifact。** 並列で動く他のセッションと 1 つの URL を共有して上書きしない
（最後に公開した版しか残らず、他のシーンが消える）。

1. 履歴を全部取ってからビルドする。クラウドの clone は浅く、そのままだとタブの並びが崩れる。

   ```bash
   [ "$(git rev-parse --is-shallow-repository)" = true ] && git fetch --unshallow origin
   npm run build    # 出力に [scene-order] の shallow 警告が出ていないこと
   ```

2. `dist/` をスクラッチパッドの `preview-<scene-name>/` にコピーし、コピー側の `index.html` の
   `<title>` を `Preview: <Title Case>` に書き換える（Artifact の一覧でどのシーンか見分けるため）。
   **リポジトリの `index.html` は触らない。**
3. `Artifact` の publish で公開する。`file_path` はコピーした `index.html`、`root` はそのディレクトリ、
   `files` には `assets/index-*.js`・`icons/*`・`manifest.webmanifest` を実際のファイル名で並べる。
   `icon` は `animation`。
   - **`sw.js` は載せない。** オフライン用のキャッシュに古い版が残り、直した版が見えなくなる。
   - `#N` の指定は要らない。`#N` が無いと先頭のタブから始まり、PR ブランチでは
     このシーンが最新なので必ず先頭に来る（Artifact は枠の中で表示されるので `#N` は届かない）。
4. 返ってきた URL を控える。報告に載せる（**PR 本文には載せない**）。

公開に失敗したら、プレビュー無しで PR へ進む（ゲートではない）。報告でその旨を伝える。

### 3. PR を作る

GitHub MCP の `create_pull_request` を使う（`gh` は無い）。`base` は `main`、`head` は上のブランチ名。

**タイトル:** `<Title Case の名前> を追加: <desc を短くしたもの>`

**本文は次の形に固定する:**

```markdown
## 概要

新シーン **<Title Case>**（`src/scenes/<camelCase>.ts`）を追加します。変更はこの 1 ファイルだけです。`/new-scene-cloud` で作りました。

<何が起きるかを 2〜3 文で>

## 自動で決めた仕様

| 項目 | 内容 |
| --- | --- |
| 何が動くか | |
| 気持ちよさの芯 | |
| ループの周期 | |
| カメラ | |
| 音 | |
| スコープ外 | |

## 検証

- `npm run typecheck` / `npm run build` / `npm run smoke <camelCase>`：すべて通過
- `node scripts/shot-pw.mjs`：ページ内 JS エラーなし（<撮った秒数> 秒目）
- 講評エージェント（scene-critic）：<N> 枚目で 6 項目すべて ○
- ゲート：ブランチ差分は `src/scenes/<camelCase>.ts` の 1 行だけ

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

本文の決まり:

- **「Generated with Claude Code」は最後の 1 行だけ。** `---` と `_Generated by ..._` の形のフッターは
  書かない（サーバーがこの形を付け足したり取り除いたりして、重複や消失の元になる）。
- **claude.ai の URL を載せない。** セッションの URL（`https://claude.ai/code/session_...`）も、
  Artifact の URL（`https://claude.ai/artifact/...`）も書かない。プレビューの URL は報告でだけ伝える。
- **画像は貼らない。** GitHub MCP には画像を添付する手段が無い。画像ファイルをリポジトリに
  コミットして貼る、といった回り道もしない（差分がシーン 1 ファイルでなくなる）。

### 4. 本文を読み直す

`pull_request_read`（`method: "get"`）で作った PR を読み、次を確かめる。
違っていたら `update_pull_request` で本文を丸ごと出し直し、もう一度読む。

- `Generated with` がちょうど 1 回
- `claude.ai/code/session_` も `claude.ai/artifact/` も含まない

---

## Phase 10 — 報告して引き渡す

作業中に立てた dev サーバーを止める。クラウドでは起動したまま渡しても見られないので、
`play --bg` での引き渡しはしない。

```bash
npm run play -- --stop <scene-name>
```

**worktree とブランチは残す。** マージしていないので、`ExitWorktree` するなら `action: "keep"`。

報告に含めるもの:

1. シーン名と 1〜2 行の説明
2. **プレビューの URL**（Artifact）と **PR の URL**（`owner/repo#N` 形式のリンク）。
   プレビューは非公開で、開けるのはユーザー本人だけだと添える
3. 残した worktree とブランチ。PR のマージかクローズをこのセッションに指示すれば、
   あわせてプレビューの Artifact を消すこと。プレビューにコメントすればこのセッションに届くことも伝える

### 直したあと — プレビューを同じ URL に上書きする

プレビューへのコメントや PR のレビューでシーンを直したら、ゲートを通して push したあと、
Phase 9 の 2 の手順でビルドし直して**最初に控えた URL へ上書き公開する**（`url` にその URL を渡す）。
JS のファイル名はビルドごとに変わるので、前回の `assets/index-*.js` は `files` で `null` にして消す。
PR 本文には URL を載せていないので、書き直しは要らない。

### PR のマージかクローズを指示されたら — 閉じて片付ける

ユーザーから **「マージして」「クローズして」** と指示されたら、次を通しで行う。
指示が無いうちは PR にも Artifact にも手を付けない。

1. `pull_request_read`（`method: "get"`）で PR の状態を確かめる。
   - 既にマージ／クローズ済みなら 2 は飛ばして 3 へ進む。
2. 指示どおりに閉じる。
   - マージ: GitHub MCP の `merge_pull_request` でマージする。コンフリクトや CI の失敗で
     マージできなければ、そこで止まって理由を報告する（Artifact も消さない）。
   - クローズ: `update_pull_request` で `state: "closed"` にする。
3. `Artifact` の `delete` に、控えた Artifact の URL を渡して消す。
   消すのはこのセッションで公開した 1 つだけ。他のセッションの Artifact には触らない。
4. ユーザーに 1〜2 行で報告する（PR をマージ／クローズしたこと、プレビューを消したこと）。
