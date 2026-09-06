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
