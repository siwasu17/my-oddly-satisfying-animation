---
name: new-scene
description: src/scenes/ に新しいループアニメーションを 1 本追加する。worktree の用意 → 仕様決め → 雛形生成 → 実装 → 型/ビルド/dev 検証 → コミットまでを通しで行う。完成したシーンを main にマージして worktree ごと片付ける手順（Phase 9）も持つ。「新しいシーンを作って」「アニメーションを追加して」や /new-scene、作ったシーンについて「マージして」「後始末して」と言われたときに使う。
argument-hint: "[scene-name] [シーンのコンセプト]"
user-invocable: true
---

# /new-scene — 新しいシーンを 1 本作る

ユーザーの入力: `$ARGUMENTS`

第 1 トークンをシーン名（kebab-case）、残りをコンセプトとして扱う。どちらも省略可能。

このスキルは **Phase 0 から順に実行する**。特に Phase 0 と Phase 2 を飛ばすと `main` を汚す事故になる。

例外は **Phase 9（main へのマージと後始末）**。これは完成したシーンを取り込むフェーズなので、
「マージして」「後始末して」と言われたときに**単独で実行してよい**。

確認を挟まずに `main` へのマージまで通したい場合は `/new-scene-auto` を使う。
ただし**ユーザーが明示的にそう言ったときだけ**。このスキルは常に Phase 8 で止まって引き渡す。

---

## Phase 0 — 実行場所の確認（最初に必ず行う）

```bash
git rev-parse --git-dir
git rev-parse --git-common-dir
git status --porcelain
git rev-parse --abbrev-ref HEAD
```

判定:

- **`--git-dir` と `--git-common-dir` が異なる** → すでに worktree の中にいる。Phase 2 は**スキップ**する。
- **同じ（= 親リポジトリ、通常 `main`）** → Phase 2 で worktree に入る。**ここでシーンを作り始めない。**
- **`git status --porcelain` に出力がある** → 未コミットの変更がある。worktree には持ち込まれないので、
  先に片付けるようユーザーに促して停止する。

判定結果を覚えておくだけで、この時点では何も作らない。

---

## Phase 1 — シーン名を決める

- 引数の第 1 トークンを名前とみなす。
- kebab-case（`^[a-z][a-z0-9]*(-[a-z0-9]+)*$`）でなければ、コンセプトから候補を作って確認する。
  `scripts/new-scene.mjs` は同じ正規表現で弾くので、ここで揃えておく。
- `ls src/scenes/` で既存を確認する。同名があれば別名を提案する。

名前は 3 つの姿になる。混同しないこと。

| 使う場所 | 形 | 例 |
| --- | --- | --- |
| worktree / ブランチ / スクリプトの引数 | kebab-case | `koi-pond` → `scene/koi-pond` |
| ファイル名と export 名 | camelCase | `src/scenes/koiPond.ts` |
| タブの表示名（`SceneModule.name`） | Title Case | `Koi Pond` |

worktree 名にもなるので、ここで確定させてから Phase 2 へ進む。

---

## Phase 2 — worktree に入る

**Phase 0 で「親リポジトリにいる」と判定した場合のみ実行する。** すでに worktree 内なら飛ばす。

`EnterWorktree` ツールを使う。**このセッションの作業ディレクトリがそのまま worktree に切り替わる。**

```
EnterWorktree({ name: "<scene-name>" })
```

`.claude/worktrees/<scene-name>` が作られ、セッションがそこに移る。

入った直後に**必ずこの 2 つを行う**。

```bash
# 1. ブランチ名を規約に合わせる（既定では worktree-<scene-name> になる）
git branch -m scene/<scene-name>

# 2. 分岐元をローカルの main に揃える
git log --oneline -1        # いまの HEAD
git log --oneline -1 main   # ローカル main
```

**2 が重要。** worktree の分岐元は既定で `origin/<default-branch>` なので、`main` にコミットしただけで
push していない変更（共有ファイルの更新やこのスキル自身の修正）が入らない。
HEAD がローカル `main` と異なっていたら、作りたてで差分が無いことを確認したうえで揃える:

```bash
git status --porcelain      # 空であることを確認してから
git reset --hard main
```

`.claude/settings.json` に `worktree.baseRef: "head"` も入れてあるが、**設定はセッション起動時に
読まれるため、設定を変えた直後のセッションでは効かない。** 上の確認は毎回行うこと。

その他の注意点:

- worktree には `node_modules` が無い。Phase 4 の `npm install` は必須。
- 途中で中止する場合は `ExitWorktree({ action: "remove" })` で worktree ごと片付ける。
  作業を残したい場合は `action: "keep"`。ただし**ブランチを改名しているとブランチは残る**ので、
  不要なら `git branch -D scene/<scene-name>` も行う。
- **完成後の片付けは Phase 9 で行う。** そこで抜けるときは必ず `action: "keep"`。
  `remove` を使うとブランチごと消えて、マージ前のコミットを失う。
- worktree に入ったセッションでは、Bash に複雑なコマンド（`&&` や条件分岐を連ねたもの）を渡すと
  「worktree の外に出ないことを検証できない」として拒否される。**単純なコマンドに分けて実行する。**
- 同じ理由で **`cat > file <<'EOF'` によるファイル生成も拒否される。**
  新規ファイルは `Write`、部分修正は `Edit` を使う。シェルで書き出そうとして 1 往復無駄にしない。
- **ユーザーに「別ターミナルで起動し直してください」と案内する必要はない。** そのまま Phase 3 へ進む。

---

## Phase 3 — 仕様を固める

### コンセプトが引数にある場合

そのまま採用する。**曖昧な点だけを 1 回の `AskUserQuestion` にまとめて**確認する。何度も往復しない。
聞く価値があるのは通常この 3 つ:

- 動きの主役（面で見せるか、線で見せるか、粒で見せるか）
- ループの周期（数秒で一巡するか、数十秒かけて戻ってくるか）
- カメラ（俯瞰 / 見上げる / 水平）

引数から明らかに読み取れるものは聞かない。

### コンセプトが無い場合

`ls src/scenes/` と各ファイル冒頭のコメント（`head -20`）を読んで既存のシーンを把握し、
**それと動きの質がかぶらない案を 3〜4 個**、`AskUserQuestion` で提案する。
各案には次を 1 行ずつ添える: 何が動くか / 何が気持ちいいか / 音は何を鳴らすか。

案は「Three.js のプリミティブだけで作れて、1 画面で完結し、永久にループするもの」に限る。

### 仕様カード

決まったら次の形にまとめる。これを実装後に**シーンファイル冒頭のコメント**へ書く。

```
何が動くか:
気持ちよさの芯:
ループの周期:
カメラ:
音:
スコープ外:
```

**スコープの上限を必ず明示する。** 既定は以下。超える案は削るか「スコープ外」に落とす。
量産が目的なので 1 本に時間を溶かさない。

- 1 ファイルで完結する（300 行程度まで）
- 外部アセットを読み込まない（ジオメトリとマテリアルだけで作る）
- 共有ファイル（`stage.ts` / `palette.ts` / `audio.ts` / `ui.ts` など）を変更しない
- 依存を増やさない

---

## Phase 4 — 足場を作る

```bash
npm install
node scripts/new-scene.mjs <scene-name>
```

`src/scenes/<camelCase>.ts` に、動く最小のシーンができる。この時点で `npm run dev` を叩けば
タブの末尾に出るはず（`src/scenes/index.ts` が自動収集するので登録作業は無い）。

---

## Phase 5 — 実装する

**実装前に `references/recipes.md` を読む。** InstancedMesh・色・音・カメラ・乱数の定型と、
`SceneModule` / `palette` / `audio` / `stage` の API がそこに揃っている。毎回ゼロから書かない。

**`src/types.ts` / `palette.ts` / `audio.ts` / `stage.ts` を `cat` で開かない。**
必要なものは recipes.md の「共有ファイルの API」節にある。4 本読むだけで 12KB 以上を消費する。
それでも足りないと思ったら、足りなかったものを**ユーザーに報告する**（recipes.md に足すのはユーザーの判断）。

### 触ってよい範囲

編集してよいのは **`src/scenes/<camelCase>.ts` の 1 ファイルだけ**。

次のファイルは全セッションの共有物。変更が必要になったら**手を止めてユーザーに報告し、指示を仰ぐ**。
勝手に直さない。

- `src/stage.ts` / `src/palette.ts` / `src/audio.ts` / `src/ui.ts` / `src/main.ts` / `src/types.ts`
- `src/scenes/index.ts`（**シーン追加では絶対に編集しない**。自動収集される）
- `index.html` / `package.json` / `vite.config.ts` / `tsconfig.json`
- `README.md` / `CLAUDE.md` / `templates/` / `scripts/` / `.github/`

「palette にこの色があると便利だ」と思っても、まずは自分のシーン内に書く。共通化の判断はユーザーが行う。

### コードの約束

- `requestAnimationFrame` を直接呼ばない。ループは `main.ts` が回している
- 形は毎フレーム `t` から作り直す。差分を積み上げるものには必ず `dt` を掛ける
- `build()` はシーンを開くたびに呼ばれる。`ticker()` などの状態はここで作り直す
- `build(root)` の子だけに足す。dispose は書かない（`disposeGroup()` が回収する）
- 乱数は固定シード。`Math.random()` を build で使わない
- 色は `ember()` / `emberColor()` / `SURFACE` を通す。青い色相を使わない
- 音程は `tone()` を通す。`sound()` に映像へ影響する処理を書かない
- `import type` を使う
- **調整する数値はファイル冒頭の定数ブロックに集める。** カメラ位置・本数・間隔・太さ・
  周期のように、絵を見てから振り直すものを散らかさない。まとめてあれば `Edit` 1 回で
  何箇所でも同時に振れる。散らかっていると 1 つずつ書き換えることになり、
  そのたびに撮り直すはめになる

### 説明を書く

**README にシーン表は無い。** シーンの説明はこの 2 か所が全て:

- ファイル冒頭のコメント — Phase 3 の仕様カードを 3〜6 行の文章にして書く
- `SceneModule.desc` — タイトル下に出る 1 行。動きを言葉にする

---

## Phase 6 — 検証する

### 1. 機械で確かめる

この 3 つを順に実行し、**全部通るまで完了報告をしない**。

```bash
npm run typecheck
npm run build
npm run smoke <camelCase>
```

`npm run smoke` は dev サーバーを立てて index.html・モジュール解決・自分のシーンが
レジストリに載っていることを確認し、終了時に必ず落とす。**自分で `npm run dev` を立てっぱなしにしない。**
並列セッションのポートを食う。

型エラーを `any` や `!` で黙らせない。

### 2. 見た目を確かめる

```bash
npm run shot -- <camelCase>
```

**`agent-browser` を直接叩かない。** このコマンドが、シーンの通し番号を割り出して `#N` へ直行し、
960x600 で撮り、**ページ内の JS エラーがあれば非ゼロで終了する**。
`build()` の中で投げられた例外は typecheck も build も smoke も拾えないので、ここが唯一の網になる。

タブを `snapshot -i` して `click` で探しに行かないこと。ref は毎回振り直されるので、
`✗ Unknown ref` と再 snapshot の往復に落ちる。自動切替も既定 OFF なので押しに行く必要は無い。

出力されたパスを `Read` して、`references/recipes.md` の
**「見え方のセルフチェック」の 6 項目**に自分で答える。引っかかった項目は**まとめて**直して、
それから 1 枚撮り直す。1 つずつ当てずっぽうに撮り直さない。**撮るのは 3 枚まで。**
3 枚で決まらないときは、細部を詰めずに Phase 8 でユーザーへ渡して判断を仰ぐ。

> **省いてよい場合**: ユーザーが「実画面の確認はしなくていい」と明示したときだけ、
> このステップを飛ばしてよい。その場合も 1 の 3 つは省略しない。
> `/new-scene-auto` では**絶対に省略しない**（人間が見ないので、ここが最後の砦になる）。

---

## Phase 7 — コミットする

```bash
git rev-parse --abbrev-ref HEAD    # scene/<scene-name> であることを確認
git status --porcelain             # 差分が src/scenes/<camelCase>.ts だけであることを確認
```

`main` にいる場合はコミットせず停止して報告する。
`src/scenes/<camelCase>.ts` 以外に差分が出ていたら、その理由を確認してから進む
（共有ファイルを触っていたら、コミット前にユーザーへ報告する）。

```bash
git add src/scenes/<camelCase>.ts
```

コミットメッセージは日本語で、1 行サマリ + 仕様の要点。末尾に:

```
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

push はしない。ユーザーが行う。

---

## Phase 8 — 起動して引き渡す

**報告の前に dev サーバーを起動する。** ユーザーがブランチを移動してコマンドを打ち直さなくても、
URL をクリックするだけで見られる状態にして渡す。

```bash
npm run play -- --bg <scene-name>
```

`http://localhost:<port>/` が出力されるので、それを報告に載せる。ポートは自動採番なので、
出力された URL をそのまま使うこと（決め打ちしない）。自分のシーンはタブの末尾にある。

Phase 6 の `npm run shot` が既に立てているはずなので、たいていは
「すでに起動しています」と URL が出るだけになる。それで正しい。
**報告する URL には `#N` を付ける**（`shot` が出力した番号）。ユーザーがタブを探さずに済む。

Phase 6 の `smoke` とは役割が違う。あちらは「起動 → 検証 → 停止」で正しさを確かめるもの、
こちらは「起動したまま渡す」もの。両方行う。

> `CLAUDE.md` の「dev サーバーを立てっぱなしにしない」ルールは、**完成報告時にユーザーへ引き渡す
> この 1 本だけ例外**。作業中に立てたサーバーは従来どおり必ず落とすこと。

### 報告の内容

簡潔に、次を含めて報告する。

1. シーン名と 1〜2 行の説明
2. **見かた** — 上で出力された URL と、タブの何番目にあるか
   止め方も添える: `npm run play -- --stop <scene-name>`
3. 実装した内容の要点（動きの作り、工夫した点、音の鳴らし方）
4. 検証結果（typecheck / build / smoke がすべて通ったこと）
5. スコープ外にしたもの、残タスクがあれば

見た目の最終確認はユーザーに任せる。「ブラウザで開いて確認してください」と添える。

---

## Phase 9 — main にマージして後始末する

ユーザーに「マージして」「後始末して」と言われたときに実行する。
**このフェーズだけ単独で呼ばれることもある**（別セッションが作ったシーンを取り込む場合など）。

### 1. worktree の中にいるなら抜ける

```
ExitWorktree({ action: "keep" })
```

**`remove` は使わない。** ブランチごと消えて、マージ前のコミットを失う。
`main` は親リポジトリでチェックアウトされているので、worktree の中からはマージできない。

### 2. 親リポジトリで 1 コマンド

```bash
npm run merge-scene <scene-name>
```

dev サーバーの停止 → `--no-ff` マージ → `package-lock.json` の衝突解決 → マージ後の `main` での
検証（build）→ worktree とブランチの削除まで、このコマンドが行う。

- `npm run merge-scene <scene-name> -- --dry-run` — 実行するコマンドを並べるだけ
- `npm run merge-scene <scene-name> -- --keep` — マージと検証だけ。worktree とブランチは残す
- `npm run merge-scene -- --list` — マージできる `scene/*` ブランチの一覧

### 3. 出力をそのまま報告する

**push はしない。** ユーザーが行う。

### 止まったときの読み方

スクリプトは**何かおかしければ何も壊さずに止まる**。理由を読んで対処する。
**自分で `git merge` を叩き直さない。**

| メッセージ | 意味 | すること |
| --- | --- | --- |
| worktree の中では実行できません | 1 を飛ばした | `ExitWorktree({ action: "keep" })` してから再実行 |
| main に未コミットの変更があります | 他セッションの作業中かもしれない | 片付けるようユーザーに促す。勝手にコミットしない |
| worktree は locked です | 他セッションが使用中 | 触らずユーザーに報告する |
| このブランチは共有ファイルも変更しています | 担当範囲を越えている | 中身をユーザーに見せて判断を仰ぐ |
| マージが衝突しました | `package-lock.json` 以外が衝突した | マージは中断済み。衝突箇所を見てユーザーに相談する |
| 検証に失敗しました | マージ後の main で build が落ちた | `main` は自動で巻き戻り、worktree とブランチは残っている。直して再実行する |

シーンを 1 本足すだけなら、触るファイルは `src/scenes/<camelCase>.ts` の 1 つだけなので
**衝突は起きないのが正常**。衝突したら、担当範囲を越えていないか先に疑うこと。
