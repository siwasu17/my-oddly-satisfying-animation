---
name: archive-scene
description: 出来がいまいちなシーンをタブから外して src/scenes/_archive/ へ退避する。対象の確定 → 退避 → ORDER の掃除 → 型/ビルド/見た目の検証 → コミットまでを通しで行う。消さないので後から戻せる。「アーカイブして」「このシーンは外して」「いまいちだから消して」「タブから外して」や /archive-scene と言われたときに使う。戻す手順（Phase 7）も持つ。
argument-hint: "[scene-name]"
user-invocable: true
---

# /archive-scene — いまいちなシーンをアーカイブする

ユーザーの入力: `$ARGUMENTS`

第 1 トークンをシーン名として扱う。省略可能（Phase 1 で一覧から選ばせる）。

**どれをアーカイブするかを決めるのはユーザー。** このスキルが勝手に候補を選んだり、
「これはいまいちだと思います」と評価したりしない。頼まれていない棚卸しを始めない。
スキルが担保するのは**手順の正しさ**だけ。

やることは 1 行で言うと `src/scenes/<name>.ts` を `src/scenes/_archive/<name>.ts` へ動かすこと。
**消さない。** ファイルは残るので、いつでも Phase 7 で戻せる。

「戻して」「復活させて」と言われたときは **Phase 7 だけを単独で実行してよい**。

---

## なぜ移動するだけでタブから消えるのか

先に仕組みを押さえておくこと。ここを誤解すると余計なファイルを触る。

| 仕組み | 該当箇所 | `_archive/` に置いたときの挙動 |
| --- | --- | --- |
| シーン収集 | `src/scenes/index.ts` の `import.meta.glob('./*.ts')` | **同階層のみ・非再帰**。サブディレクトリは拾わない → タブから消える |
| 通し番号 `#N` | `scripts/shot.mjs` の `readdirSync(...).filter(f => f.endsWith('.ts'))` | ディレクトリ `_archive` は `.ts` で終わらないので除外される → 番号の計算がずれない |
| バンドル | `vite build` | どこからも import されないので `dist/` に入らない |
| 型検査 | `tsconfig.json` の `include: ["src"]` | **型検査の対象には残る** → 相対 import の直しが要る（Phase 2） |

`src/main.ts` と `src/ui.ts` は `SCENES.length` から全部を導くので **修正不要**。
本数が減っても `initialIndex()` が範囲外の `#N` を先頭へ落とす。

---

## Phase 0 — 実行場所の確認（最初に必ず行う）

```bash
git rev-parse --git-dir
git rev-parse --git-common-dir
git status --porcelain
git rev-parse --abbrev-ref HEAD
```

判定:

- **`--git-dir` と `--git-common-dir` が異なる** → worktree の中にいる。
  `ExitWorktree({ action: "keep" })` で親リポジトリへ戻ってから続ける。
  **`remove` は使わない**（他セッションの作業が消える）。
- **`git status --porcelain` に出力がある** → 未コミットの変更がある。
  他セッションが作業中かもしれない。**止めて**ユーザーに片付けを促す。**勝手にコミットしない。**
- **`HEAD` が `main` でない** → どこで作業するつもりか確認してから進む。

このスキルは `main` の上で直接行う。**worktree は作らない**し、`npm run merge-scene` も使わない
（あれは `src/scenes/<camelCase>.ts` 1 本だけを足すシーン追加のための道具で、
`index.ts` を触るこの作業では必ず「共有ファイルも変更しています」の警告に当たる）。

---

## Phase 1 — 対象を確定する

引数は kebab-case（`lazy-river`）でも camelCase（`lazyRiver`）でも受ける。
どちらで来ても `src/scenes/<camelCase>.ts` に直して存在を確かめる。

```bash
ls src/scenes/
```

- **見つからない** → 候補を並べて確認する。**似ている名前を勝手に選ばない。**
- **引数が無い** → 現在のシーンを一覧にして選んでもらう。

  ```bash
  grep -H "desc:" src/scenes/*.ts
  ```

  `name` と `desc` を並べて出す。**全ファイルを `cat` しない**（20 本超あるのでトークンの無駄）。

対象が決まったら、その `name` と `desc` を 1 行で読み上げて、これで合っているか**一度だけ**確認する。

見た目を思い出せないと言われたときだけ撮る（既定では撮らない）:

```bash
npm run shot -- <camelCase>
```

---

## Phase 2 — 退避する

```bash
mkdir -p src/scenes/_archive
git mv src/scenes/<camelCase>.ts src/scenes/_archive/<camelCase>.ts
```

### 相対 import を 1 階層ぶん深くする

**これを飛ばすと Phase 4 の `typecheck` が必ず落ちる。** 1 階層下がったので `../` では届かない。

| 移動前 | 移動後 |
| --- | --- |
| `'../palette.ts'` | `'../../palette.ts'` |
| `'../audio.ts'` | `'../../audio.ts'` |
| `'../types.ts'` | `'../../types.ts'` |
| `'../stage.ts'` | `'../../stage.ts'` |

`'three'` のようなパッケージ名の import は**触らない**。

```bash
sed -i '' "s|from '\.\./|from '../../|g" src/scenes/_archive/<camelCase>.ts
grep -n "^import" src/scenes/_archive/<camelCase>.ts
```

`grep` の出力を目で確かめること。シーン本体のコードは**一切書き換えない**。

### `_archive/README.md`（初回だけ）

`src/scenes/_archive/README.md` がまだ無ければ作る。`.md` なので収集にも型検査にも影響しない。

> # アーカイブ
>
> 出来がいまいちで、タブから外したシーンを置いてある。消してはいない。
>
> `src/scenes/index.ts` は同じ階層の `.ts` だけを集めるので、ここに置いたファイルは
> 一覧に出てこない。相対 import が 1 階層深い（`'../../palette.ts'`）のはそのため。
>
> 戻したくなったら `/archive-scene` に「<名前> を戻して」と言えばよい。

---

## Phase 3 — `ORDER` から名前を消す

`src/scenes/index.ts` の `ORDER` に対象名があれば、**その 1 行だけ**を削る。無ければ何もしない。

```bash
grep -n "<camelCase>" src/scenes/index.ts
sed -i '' "/^  '<camelCase>',$/d" src/scenes/index.ts
git diff --stat src/scenes/index.ts
```

`git diff` が **1 行削除だけ**になっていることを確かめる。それ以外が動いていたら巻き戻す。

`index.ts` は本来ユーザー管轄の共有ファイルで、`CLAUDE.md` も他のスキルも
「シーンを足すときに触るな」と言っている。**このスキルはこの 1 行削除に限って例外**として触ってよい。
`ORDER` の並びを保ったまま 1 行消すだけなので、他セッションのシーン追加とはぶつからない。

**やらないこと**: `ORDER` の並べ替え、追記、他の名前の掃除。
（実在しない名前が `ORDER` に残っていても `indexOf` が `-1` を返すだけで無害。
気づいても直さない。ユーザーの管轄。）

---

## Phase 4 — 検証する

```bash
npm run typecheck
npm run build
npm run shot -- <残っているシーンのどれか 1 本>
```

- `typecheck` は Phase 2 の import 修正が正しいことを見る。`_archive/` も型検査の対象なので、
  ここが通れば退避したファイルは腐っていない。
- `shot` は残ったシーンの通し番号が崩れていないか、JS エラーが出ていないかを見る。
  終了コードが 0 であること。撮れた PNG は**自分で `Read` しない**（このスキルでは見た目の講評は不要）。
- アーカイブしたシーン自体は `✗ src/scenes/<name>.ts が見つかりません` で撮れない。**それが正常。**
  同じ理由で `npm run smoke <archivedName>` も落ちる。打たないこと。

落ちたら**直してから先へ進む**。落ちたままコミットしない。

---

## Phase 5 — コミットする

```bash
git status --porcelain
git add src/scenes/_archive src/scenes/index.ts
git status --porcelain
```

差分が `src/scenes/_archive/` と `src/scenes/index.ts` だけであることを確かめる。
それ以外が混じっていたら**止めてユーザーに見せる**。

メッセージは既存の履歴に合わせた日本語 1 行 + 理由の本文（`git log` を見れば形式が分かる）。

```
<Title Case 名> をアーカイブした

<なぜいまいちだったか。ユーザーが言った言葉を残す>

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: <このセッションの URL>
```

**push はしない。** ユーザーが行う。

---

## Phase 6 — 報告する

- アーカイブしたシーンの名前と、退避先のパス
- 残っているシーンの本数（`ls src/scenes/*.ts | wc -l` から `index.ts` を引いた数）
- 検証の結果（typecheck / build / shot）
- **戻すときは「<名前> を戻して」と言えばよい**こと
- push はしていないこと

既存の `#N` ブックマークが指すシーンは全部ずれる。`index.ts` の冒頭コメントが
すでに「URL の番号は固定されないものとして扱うこと」と言っているので、
これは想定内。改めて謝る必要はないが、報告には 1 行入れておく。

---

## Phase 7 — アーカイブから戻す

「戻して」「復活させて」と言われたときに**単独で実行してよい**フェーズ。Phase 2〜5 の逆。

Phase 0 の確認は同じように行う。

```bash
ls src/scenes/_archive/
git mv src/scenes/_archive/<camelCase>.ts src/scenes/<camelCase>.ts
sed -i '' "s|from '\.\./\.\./|from '../|g" src/scenes/<camelCase>.ts
grep -n "^import" src/scenes/<camelCase>.ts
```

```bash
npm run typecheck
npm run build
npm run shot -- <camelCase>
```

**`ORDER` には追記しない。** 書かれていないシーンは `rank()` が `-1` を返して最新扱いになるので、
戻したシーンはタブの先頭に現れる。並びを固定したくなったらユーザーが `ORDER` に足す。

コミットは `<Title Case 名> をアーカイブから戻した`。push はしない。

---

## 触らないもの

`src/stage.ts` / `src/palette.ts` / `src/audio.ts` / `src/ui.ts` / `src/main.ts` / `src/types.ts` /
`scripts/` / `package.json` / `tsconfig.json` / `vite.config.ts` / `index.html` / `README.md` /
`CLAUDE.md` は**一切変更しない**。`src/scenes/index.ts` も Phase 3 の 1 行削除だけ。

新しい npm スクリプトも足さない。このスキルは既存の `typecheck` / `build` / `shot` だけで完結する。

アーカイブしたシーンの**中身を直さない**。直したくなったならアーカイブではなく手直しであって、
それは別の作業。ユーザーに確認する。
