---
name: new-scene-auto
description: 新しいループアニメーションを 1 本、人間の確認を挟まずに main へマージするところまで通しで作る。仕様の確認・目視確認の待ち・マージ指示待ちをすべて省略する。「自動で」「確認なしで」「そのまま main まで入れて」「お任せで」とユーザーが明示したときだけ使う。単に「シーンを作って」と言われたときは必ず new-scene のほうを使うこと。
argument-hint: "[scene-name] [シーンのコンセプト]"
user-invocable: true
---

# /new-scene-auto — 確認を挟まずに main まで通す

ユーザーの入力: `$ARGUMENTS`

第 1 トークンをシーン名（kebab-case）、残りをコンセプトとして扱う。どちらも省略可能。

## このスキルの位置づけ

通常版 `/new-scene` は 3 か所で人間の手を止める（Phase 3 の仕様確認 / Phase 8 の目視確認待ち /
Phase 9 のマージ指示待ち）。このスキルはその 3 つの**待ち**を外して、`main` への取り込みまで
一息に進める。

**人間の判断は削るが、機械で検証できるゲートは削らない。** むしろ通常版より厳しくする。
`main` に自動で入れる以上、Phase 8.5 のゲートが最後の砦になる。

> **このスキルはユーザーが明示的に自動化を求めたときだけ使う。**
> 「新しいシーンを作って」だけなら `/new-scene` を使うこと。

---

## 前提 — 手順の本体は通常版にある

**まず `.claude/skills/new-scene/SKILL.md` を読むこと。**
Phase 0〜7 はそこに書かれたとおりに実行する。このファイルは**その差分だけ**を定義する。
手順をここに書き写さない（通常版を直したときに自動版だけ古くなる）。

`references/recipes.md` も通常版のもの（`.claude/skills/new-scene/references/recipes.md`）を読む。

差分の一覧:

| Phase | 通常版 | このスキル |
| --- | --- | --- |
| 0〜2 | 場所の確認 / 名前決め / worktree | 同じ |
| 3 | `AskUserQuestion` で仕様確認 | **聞かずに自分で決める** |
| 4 | 足場を作る | 同じ |
| 5 | 共有ファイルが要るならユーザーに相談 | **その案を捨てて自分のシーン内で完結させる** |
| 6 | 検証 3 種 + スクリーンショット | 同じ（**省略しない**） |
| 7 | コミット | 同じ |
| 8 | 起動して引き渡し、目視確認を待つ | **スキップ** |
| 8.5 | — | **新設: 自動マージのゲート** |
| 9 | ユーザーの指示を待って `merge-scene` | **ゲートを通ったらそのまま実行** |
| 10 | — | **新設: 報告と引き渡し** |

---

## Phase 3 の差分 — 仕様は自分で決める

**`AskUserQuestion` を呼ばない。** 1 回も。

### コンセプトが引数にある場合

そのまま採用し、曖昧な点は自分で決める。迷ったら次に倒す。

- 動きの主役 → 面で見せる
- ループの周期 → 数十秒かけてゆっくり戻ってくる
- カメラ → 俯瞰

### コンセプトが無い場合

`ls src/scenes/` と各ファイル冒頭のコメント（`head -20`）で既存のシーンを把握し、
**動きの質がかぶらない案を自分で 1 つ選ぶ。** シーン名（kebab-case）も自分で決める。
案は「Three.js のプリミティブだけで作れて、1 画面で完結し、永久にループするもの」に限る。

### 仕様カード

通常版と同じ形にまとめ、実装後にシーンファイル冒頭のコメントへ書く。

```
何が動くか:
気持ちよさの芯:
ループの周期:
カメラ:
音:
スコープ外:
```

**何を自分で決めたかは Phase 10 の報告に必ず載せる。** ユーザーは仕様を見ていないので、
あとから「そこは違う」と言える材料を渡す責任がこちらにある。

スコープの上限（1 ファイル 300 行程度 / 外部アセットなし / 共有ファイル不変更 / 依存追加なし）は
通常版と同じ。自動モードだからといって大作を狙わない。

---

## Phase 5 の差分 — 共有ファイルは絶対に触らない

通常版は「共有ファイルが必要になったら手を止めてユーザーに報告し、指示を仰ぐ」だが、
自動モードには聞く相手がいない。したがって:

- **その案を捨てて、`src/scenes/<camelCase>.ts` の中で完結する形に落とす。**
  「palette にこの色があると便利」なら自分のシーン内に定数を書く。
- 落とせない（シーンが成立しない）なら、**Phase 5 で停止してユーザーに報告する。**
  マージには進まない。worktree とブランチはそのまま残す。

`src/stage.ts` / `src/palette.ts` / `src/audio.ts` / `src/ui.ts` / `src/main.ts` / `src/types.ts` /
`src/scenes/index.ts` / `index.html` / `package.json` / `vite.config.ts` / `tsconfig.json` /
`README.md` / `CLAUDE.md` / `templates/` / `scripts/` / `.github/` は**編集しない**。

`npm install <package>` も**しない**。依存が要る案なら、その案自体を捨てる。

---

## Phase 6 の差分 — スクリーンショットを省略しない

検証 3 種は通常どおり、全部通るまで進まない。

```bash
npm run typecheck
npm run build
npm run smoke <camelCase>
```

**見た目の確認も省略しない。** 通常版ではユーザーが最終確認するが、自動モードではここが唯一の
「絵になっているか」のチェックになる。自動マージの前提条件なので、むしろここが要。

```bash
npm run play -- --bg <scene-name>
```

出力された URL を `agent-browser` で開き、タブの末尾にある自分のシーンでスクリーンショットを撮る。
**真っ黒でないこと・意図した形が出ていること**を自分の目で確かめる。
おかしければ直して撮り直す。型エラーを `any` や `!` で黙らせない。

サンドボックス下では先にこれを export する（`CLAUDE.md` の「Browser Automation」節）:

```bash
export AGENT_BROWSER_ARGS="--no-sandbox,--disable-gpu,--disable-crash-reporter,--disable-breakpad"
```

ここで起動した dev サーバーは Phase 9 の `merge-scene` が自動で停止する
（内部で `play.mjs --stop <name>` を呼ぶ）ので、自分で落とさなくてよい。

---

## Phase 8 の差分 — 引き渡しで止まらない

**スキップする。** dev サーバーは Phase 6 で起動済み。ここで報告して待たず、そのまま Phase 8.5 へ。

---

## Phase 8.5 — 自動マージのゲート（このスキルの本体）

`main` へ自動で入れてよいのは、**次が全部 ✓ のときだけ。**

1. `npm run typecheck` が通る
2. `npm run build` が通る
3. `npm run smoke <camelCase>` が通る
4. スクリーンショットで描画が確認できている（Phase 6）
5. `git rev-parse --abbrev-ref HEAD` が `scene/<scene-name>`
6. `git status --porcelain` が空（コミット済み）
7. `git diff --name-only main...scene/<scene-name>` が **`src/scenes/<camelCase>.ts` の 1 行だけ**

5〜7 はここで実行して確認する。

```bash
git rev-parse --abbrev-ref HEAD
git status --porcelain
git diff --name-only main...scene/<scene-name>
```

**7 が最重要。** `scripts/merge-scene.mjs` は共有ファイルの変更を黄色で警告するだけで**停止しない**。
その手前でこのスキルが止める役をする。出力が 2 行以上、または `src/scenes/<camelCase>.ts` 以外を
含んでいたら、**マージせずに中身をユーザーに見せて判断を仰ぐ。**

### ゲートに落ちたとき

- **マージしない。** `npm run merge-scene` を実行しない。
- worktree とブランチは**残す**。`ExitWorktree` するなら必ず `action: "keep"`。
  `remove` はブランチごと消えてマージ前のコミットを失う。
- 何が欠けたかを、その時点の出力をそのまま添えて報告し、そこで終わる。
- **自分で握りつぶさない。** 条件を緩めて通す、`git checkout` で差分を捨てる、といった小細工をしない。

---

## Phase 9 — マージを自動で実行する

ゲートが全部 ✓ のときだけ、ユーザーの指示を待たずにそのまま実行する。

```
ExitWorktree({ action: "keep" })
```

```bash
npm run merge-scene <scene-name>
```

`merge-scene.mjs` 側の停止条件（`main` が dirty / worktree が locked / 衝突 / マージ後の build 失敗）は
そのまま活きる。**止まったら通常版 SKILL.md の「止まったときの読み方」の表に従う。
自分で `git merge` を叩き直さない。**

検証に失敗した場合、`main` は `git reset --hard` で自動的に巻き戻り、worktree とブランチは残るので、
直してから再実行できる。

**push はしない。** ユーザーが行う（`.claude/settings.json` の `permissions.deny` でも禁止されている）。
ローカル `main` に入るだけなので、ユーザーは push 前に `git log` / `git show` で最終確認できる。

---

## Phase 10 — 報告して引き渡す

マージが成功したら、`main` 側で 1 本だけ dev サーバーを起動して渡す。

```bash
npm run play -- --bg
```

（引数なしはリポジトリ本体 = `main`。worktree はもう消えている。）

報告に含めるもの:

1. シーン名と 1〜2 行の説明
2. **自分で決めた仕様** — 動きの主役 / ループ周期 / カメラ / 音。
   ユーザーは仕様を見ていないので、違和感を持てるように具体的に書く
3. 出力された URL と、タブの何番目にあるか。止め方 `npm run play -- --stop`
4. 検証結果 — typecheck / build / smoke / スクリーンショットと、ゲート 7 項目が全部通ったこと
5. `merge-scene` の出力 — マージコミットの短縮 SHA、`package-lock.json` 再生成の有無、
   削除した worktree とブランチ
6. **まだ push していないこと**と、気に入らなければ
   `git reset --hard <マージ前の SHA>` で `main` を戻せること（SHA も書く）
