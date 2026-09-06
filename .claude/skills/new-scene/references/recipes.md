# シーンの定型

既存 16 本から抜き出した「毎回書くもの」。ゼロから考えず、まずここを見る。
以下の断片はすべて `src/scenes/<name>.ts` の中だけで完結する。

## 骨格

```ts
import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, ticker } from '../audio.ts';
import { SURFACE, ember, drift } from '../palette.ts';

const COUNT = 64;          // 数はすべて名前付き定数にする（意味がコメントで残る）

const dummy = new THREE.Object3D();   // 行列を作るための使い回し。毎フレーム new しない
const color = new THREE.Color();

let mesh: THREE.InstancedMesh;        // build で作り直すので let

/** 何をしているかを 2〜4 行で。README にシーン表は無いので、ここが説明になる。 */
export const sceneName: SceneModule = {
  name: 'Scene Name',
  desc: 'タイトル下に出る 1 行。動きを言葉にする。',
  camera: { pos: [0, 14, 26], target: [0, 1, 0] },
  build(root) { /* ... */ },
  update(t, dt) { /* ... */ },
  sound(t, dt, sfx) { /* ... */ },
};
```

`export` する `SceneModule` は **1 ファイルに 1 つだけ**。`src/scenes/index.ts` が
ディレクトリを自動収集するので、登録作業は無い（`index.ts` は編集しない）。

## 共有ファイルの API（これで足りる。`cat` で読み直さない）

シーンから触れるのはこれだけ。`types.ts` / `palette.ts` / `audio.ts` / `stage.ts` を
開いて確かめる必要は無い（読むだけで毎回 12KB 以上を消費する）。

```ts
// types.ts — export するのはこの形ちょうど 1 つ
interface SceneModule {
  name: string;                                        // タブに出る Title Case
  desc: string;                                        // タイトル下の 1 行
  camera: { pos: [number, number, number]; target: [number, number, number] };
  build(root: THREE.Group): void;                      // 開くたびに呼ばれる
  update(t: number, dt: number): void;                 // t = このシーンの経過秒（切替で 0 に戻る）
  sound?(t: number, dt: number, sfx: Sfx): void;       // 音が ON のときだけ呼ばれる
}

// palette.ts
const BG: number;                                      // 背景。シーン側で使うことはない
const SURFACE: number;                                 // 床・支柱など光らないもの
function ember(out: THREE.Color, n: number, shift?: number, glow?: number): THREE.Color;
function emberColor(n: number, shift?: number, glow?: number): THREE.Color;
function drift(t: number, speed?: number, amount?: number): number;   // 既定 0.05 / 0.03

// audio.ts
function tone(n: number): number;                      // 0 = A2。ペンタトニックなので濁らない
function ticker(): (phase: number) => number;          // 位相が整数をまたいだ回数
function tickers(n: number): ((phase: number) => number)[];

interface VoiceOpt { gain?: number; decay?: number; pan?: number }   // pan は -1..1
sfx.pluck(freq, opt?)                       // 既定 gain 0.5 / decay 1.6 / pan 0
sfx.drop(freq, opt? & { bend?: number })    // 既定 gain 0.5 / decay 0.5 / bend 0.55
sfx.air(opt? & { freq?; q?; sweep? })       // 既定 gain 0.4 / decay 1.2 / freq 700 / q 1.4
sfx.drone(freq: number | null, gain?)       // null で止まる。毎フレーム呼んでよい
```

`ember()` の引数の効き方:

- `n` … 0 = 暗い薔薇（HSL 0.925 / 0.55 / 0.11）〜 1 = 明るい琥珀（0.11 / 0.34 / 0.55）
- `shift` … 色相のずらし幅。**±0.04 程度まで**。それ以上ずらすと帯からはみ出して青が混じる
- `glow` … 明度への加算。強調したいところだけ少し持ち上げる

### stage.ts が既に用意しているもの

**シーン側でライトを足す前に、ここを読む。** たいていの場合は足す必要が無い。

- `HemisphereLight(0xffd0a8, 0x140d0c, 0.9)` と `DirectionalLight(0xffd9b4, 1.25)`（右上手前から）
- リムライトの `PointLight` が 2 つ（左奥に橙、右手前に薄紅）
- `ACESFilmicToneMapping` / `toneMappingExposure = 0.92`（全体に暗め）
- `UnrealBloomPass(strength 0.42, radius 0.85, threshold 0.28)` —
  **明度 0.28 を超えたところが滲む。** 光らせたいものだけ `glow` を持ち上げれば、
  自分で発光マテリアルを作らなくてよい
- 縦長画面ではカメラが自動で後ろへ下がる（`fitScale()`）。画面比を気にしなくてよい
- 放置すると `OrbitControls` がゆっくり自動回転する。真正面固定を前提にしない

自分のシーンで光源を足すのは「ランプの中身のように、その物体自体が光っている」場合だけにする。

## InstancedMesh — 同じ形をたくさん出す

ドローコール 1 回で数百個まで出せる。バーでも板でも珠でも、まずこれを検討する。

```ts
build(root) {
  const geo = new THREE.BoxGeometry(0.42, 1, 0.42);
  geo.translate(0, 0.5, 0);   // 原点を底面へ移すと、Y スケールだけで「伸びる」
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.32, metalness: 0.45 });

  mesh = new THREE.InstancedMesh(geo, mat, COUNT);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);   // 毎フレーム書き換えるので必須
  root.add(mesh);
},

update(t) {
  for (let i = 0; i < COUNT; i++) {
    dummy.position.set(x, y, z);
    dummy.rotation.y = a;
    dummy.scale.set(1, h, 1);
    dummy.updateMatrix();              // 忘れると 1 フレーム前の姿勢が入る
    mesh.setMatrixAt(i, dummy.matrix);

    ember(color, n, drift(t));         // n は 0..1
    mesh.setColorAt(i, color);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;   // 初回は null
}
```

回転の順番が要るときは `dummy.rotation.order = 'YXZ'` を先に設定する
（「向きを決めてから、その軸まわりに倒す」がこれで書ける）。

## 色

```ts
ember(color, n, shift, glow)   // 既存の Color に書き込む（update 用）
emberColor(n, shift, glow)     // 新しい Color を返す（build 用）
drift(t)                       // 数十秒かけて往復する色相のゆらぎ。shift に渡す
SURFACE                        // 床・支柱など光らないものの色
```

`n` は 0（暗い薔薇）〜1（明るい琥珀）。**HSL を直に組み立てない。**
青い色相を混ぜないこと。就寝前に眺める前提で、画面から青い光を抜いてある。

床を敷くと被写体が映り込んで奥行きが出る:

```ts
const floor = new THREE.Mesh(
  new THREE.CircleGeometry(R * 1.6, 96),
  new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.25, metalness: 0.9 }),
);
floor.rotation.x = -Math.PI / 2;
floor.position.y = -0.02;
root.add(floor);
```

## 形は t から作り直す

差分を積み上げると、タブを離れて戻ったときや開き直したときに絵が変わる。

```ts
update(t) {
  const w = Math.sin(a * 3 - t * 1.6);   // ○ t の関数
  const n = 0.5 + 0.5 * w;               // 0..1 に正規化してから ember へ
}
```

どうしても積み上げたいもの（ゆっくり回る親グループなど）だけ `dt` を掛ける:

```ts
update(t, dt) {
  pivot.rotation.y += dt * 0.03;   // 視点がわずかに流れて、同じ絵が続かない
}
```

周期の違う波を重ねるときは、周期を整数比にしないと同じ形が周期的に戻ってくる。

## 乱数は固定シード

`Math.random()` を使うと開き直すたびに違う絵になる。既存シーンはこの漸化式を使っている。

```ts
let s = 0.731;
const rnd = (): number => (s = (s * 9301 + 0.49297) % 1);
```

配置は build で 1 度だけ決め、`Float32Array` に詰めて update から読む:

```ts
/** 泡ごとの [x, z, 半径, 速さ, 位相] */
const bubbles = new Float32Array(COUNT * 5);
```

## 音

`sound(t, dt, sfx)` は音が ON のときだけ、`update` と同じ `t` で呼ばれる。
**ここに映像へ影響する処理を書かない。**

```ts
let tick = ticker();      // build で作り直す
let step = 0;

build(root) {
  tick = ticker();        // 開き直すたびに位相を 0 へ戻す
  step = 0;
},

sound(t, _dt, sfx) {
  // t * 1.6 が整数をまたいだ回数 = 鳴らすべき回数
  for (let k = tick(t * 1.6); k > 0; k--) {
    step++;
    sfx.pluck(tone(7 + (step % 5)), { gain: 0.3, decay: 2.2, pan: Math.sin(step * 1.1) * 0.5 });
  }
}
```

列や群れには `tickers(n)` で人数分まとめて作る。`ticks[i](phase)` で引く。

使える音は 4 つだけ:

| 音 | 使いどころ |
| --- | --- |
| `sfx.pluck(freq, opt)` | 珠・ドミノ・板が当たる |
| `sfx.drop(freq, opt)` | 雨だれ、泡が水面へ抜ける |
| `sfx.air(opt)` | 風、衣ずれ、輪が通り過ぎる |
| `sfx.drone(freq \| null, gain)` | 持続する低い響き。毎フレーム呼んでよい |

音程は必ず `tone(n)` を通す（ペンタトニックなので、どう重なっても濁らない）。
密なシーン（84 枚のドミノなど）は **数本おきにしか鳴らさない**。全部鳴らすと団子になる。

## カメラ

`camera: { pos, target }` は 16:9 で見たときの定位置。縦長画面では `main.ts` が
自動で後ろへ引くので、こちらで画面比を気にする必要はない。目安:

- 俯瞰して全体を見せる: `pos: [0, 18, 30]`, `target: [0, 1, 0]`
- 低い位置から見上げる: `pos: [0, 3, 31]`, `target: [0, 1.5, 0]`
- 少し斜めから: `pos: [8, 19, 30]`

放置すると `OrbitControls` がゆっくり自動回転する。真正面固定を前提にしないこと。

## 後始末

`build(root)` の子として足したものは、切替時に `disposeGroup()` が geometry と material を
まとめて破棄する。**自分で dispose を書かない。** root の外（`scene` 直下）には何も足さない。

## シェーダを差し込む

標準マテリアルの一部だけを書き換えたいときは `onBeforeCompile` を使う。
`koiPond.ts` が水面・水底・浮き葉で 1 つの式を共有している例なので、必要になったらそれを読む。
ただし **まずは CPU 側で形を作れないか考える**。ほとんどの動きはそれで足りている。

## 見た目を確認する

```bash
npm run shot -- <camelCase>
```

これ 1 本で済む。**`agent-browser` を直接叩かない。**

- シーンの通し番号を `src/scenes/index.ts` と同じ規則で割り出し、`<url>#N` へ直行する。
  タブを `snapshot -i` して `click` で探す必要は無い（ref は毎回振り直されるので、
  探しに行くと `✗ Unknown ref` で往復することになる）
- dev サーバーが立っていなければ背面で起動する。worktree ごとにポートもブラウザセッションも
  分かれるので、並列セッションと取り合わない
- `AGENT_BROWSER_ARGS` の `export` は要らない（`.claude/settings.json` の `env` にある）
- 960x600 で撮る。大きく撮ると読み込む画像もその分重くなる
- **ページ内で JS エラーが出ていたら非ゼロで終了する。**
  `build()` の中の例外は `typecheck` も `build` も `smoke` も拾えない。ここが唯一の網

出力されたパスを `Read` して、自分の目で見る。

```bash
npm run shot -- <camelCase> --wait 4000        # 遅い周期のシーンで、動きが乗った瞬間を撮る
npm run shot -- <camelCase> --out /path/a.png  # 変更前後を並べたいとき
```

### 見え方のセルフチェック

撮った画像を見て、自分で答える。**ここで拾えなかったものは、必ずユーザーから指摘される。**
過去に実際に指摘された内容がそのまま並んでいる。

```
□ 意図した被写体だと一目で分かるか（シルエットが別物に見えていないか）
□ 騒がしくないか。同時に動くものを減らせないか
□ 明るすぎないか。光っているのは主役だけか（就寝前に眺める前提）
□ 手前の構造物が主役を隠していないか
□ 画角は適切か。寄りすぎ・引きすぎになっていないか
□ ページ内 JS エラーがゼロか（npm run shot が判定する）
```

**撮るのは 3 枚まで。** 1 枚が文脈におよそ 1,000 トークン積み上がる。
3 枚で決まらないときは、細部を詰めずにユーザーへ渡して判断を仰ぐほうが早い。

調整は**当てずっぽうで 1 つずつ撮り直さない**。チェックに引っかかった項目を全部拾って
定数ブロックをまとめて書き換え、それから 1 枚撮る。
