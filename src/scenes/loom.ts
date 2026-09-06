import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, ticker } from '../audio.ts';
import { SURFACE, ember, emberColor, drift } from '../palette.ts';

/**
 * 織り機。
 *
 * 経糸が一本おきに上下へ分かれて開口をつくり、その隙間をシャトルが横切って
 * 緯糸を一本置く。筬がそれを織り口まで押し込むと布が一段だけ手前へ進み、
 * 開口が入れ替わって次の一越が始まる。何もない空間から布が一段ずつ生まれ続ける。
 *
 * 物理演算は使わない。一越を 0..1 の位相 p に割り当て、開口・シャトル・筬・
 * 布の送りをすべて同じ p から作るので、糸と装置は永久にずれない。
 * 布の緯糸は 28 本を使い回していて、手前の端まで流れた糸が織り口へ戻ってくる。
 * 縞の周期が 28 を割り切るようにしてあるため、戻ってきた糸の色は元のままで、
 * 模様は継ぎ目なく続く。
 */

const WARP = 44; // 経糸の本数
const W = 13; // 布の幅
const PICKS = 28; // 布として見えている緯糸の本数
const GAP = 0.36; // 緯糸の間隔。布の目の細かさ
const TH = 0.14; // 経糸の太さ。緯糸はこれより太くして、横縞が主役に見えるようにする
const CRIMP = 0.06; // 緯糸が経糸を潜って上下する量。布に織り目が出る

const PICK = 1.7; // 一越（シャトルが片道を走り、打ち込まれるまで）の秒数
const BACK = 9.5; // 織り口からワープビームまでの距離
const HEDDLE = 4.2; // 織り口から綜絖までの距離
const SHED = 1.6; // 開口の半分の高さ
const FRONT = PICKS * GAP; // 織り上がった布の長さ

const BEAM = 0.78; // 経糸を送り出す／布を巻き取るビームの半径
const SHUTTLE_Z = -2.2; // シャトルが走る位置。開口の中ほど
/** 開口は綜絖で最大、織り口で 0 の三角形。シャトルの位置での開き具合。 */
const SHUTTLE_F = -SHUTTLE_Z / HEDDLE;
const REED_REST = -3.5; // 筬の待機位置。シャトルより奥で待つ

/** 一越の中での出来事の割り当て。位相 0..1 の上に順に並べている。 */
const OPEN_END = 0.16; // 開口が開ききる
const RUN_START = 0.22; // シャトル発進
const RUN_END = 0.58; // シャトル到着
const BEAT_IN = 0.6; // 筬が動き出す
const BEAT_HIT = 0.74; // 筬が織り口に届く（＝布が一段進む）
const BEAT_OUT = 0.92; // 筬が戻りきる
const CLOSE_END = 0.96; // 開口が閉じきる

const dummy = new THREE.Object3D();
const color = new THREE.Color();

let warp: THREE.InstancedMesh; // 経糸。1 本を 3 区間の折れ線で描く
let weft: THREE.InstancedMesh; // 織り上がった布の緯糸
let live: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>; // 置かれつつある緯糸
let shuttle: THREE.Group;
let reed: THREE.Group;
let heddleA: THREE.Mesh; // 偶数の経糸を上下させる綜絖枠
let heddleB: THREE.Mesh;
let warpBeam: THREE.Group;
let clothBeam: THREE.Group;

/** 打ち込みの回数と、シャトルの発進回数 */
let tickBeat = ticker();
let tickRun = ticker();

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (x: number): number => x * x * (3 - 2 * x);

/** 開口の開き具合（0..1）。閉じきった瞬間に上下が入れ替わる。 */
function shedAmount(p: number): number {
  if (p < OPEN_END) return smooth(p / OPEN_END);
  if (p < BEAT_HIT) return 1;
  if (p < CLOSE_END) return 1 - smooth((p - BEAT_HIT) / (CLOSE_END - BEAT_HIT));
  return 0;
}

/** 布が一段進む進み具合（0..1）。加速したまま止まるので、打ち込みが効いて見える。 */
function beatIn(p: number): number {
  if (p <= BEAT_IN) return 0;
  if (p >= BEAT_HIT) return 1;
  const u = (p - BEAT_IN) / (BEAT_HIT - BEAT_IN);
  return u * u;
}

/** 縦縞。6 本おきに明るい線を入れて、開口が扇状に色分かれして見えるようにする。 */
function warpTone(i: number): number {
  return 0.3 + 0.26 * Math.sin((i / WARP) * Math.PI * 2 * 3) + (i % 6 === 0 ? 0.34 : 0);
}

/** 横縞。周期 14 と 28 を重ねる。どちらも PICKS を割り切るので、使い回しても繋がる。 */
function weftTone(j: number): number {
  const a = Math.sin((j / 14) * Math.PI * 2);
  const b = Math.sin((j / PICKS) * Math.PI * 2 + 1.1);
  return 0.36 + 0.24 * a + 0.16 * b + (j % 7 === 0 ? 0.26 : 0);
}

/** 折れ線の 1 区間を、細長い箱として idx 番目のインスタンスに焼く。 */
function segment(
  mesh: THREE.InstancedMesh,
  idx: number,
  x: number,
  z0: number,
  y0: number,
  z1: number,
  y1: number,
): void {
  const dz = z1 - z0;
  const dy = y1 - y0;
  dummy.position.set(x, (y0 + y1) / 2, (z0 + z1) / 2);
  dummy.rotation.set(-Math.atan2(dy, dz), 0, 0);
  dummy.scale.set(1, 1, Math.hypot(dz, dy));
  dummy.updateMatrix();
  mesh.setMatrixAt(idx, dummy.matrix);
}

/** 木部の材。ほとんど沈ませ、縁のハイライトだけで輪郭が読めるようにする。 */
function timber(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.42, metalness: 0.7 });
}

/** 織り機。開口・緯入れ・筬打ちを繰り返し、布が一段ずつ生まれて手前へ流れる。 */
export const loom: SceneModule = {
  name: 'Loom',
  desc: '経糸が開き、シャトルが緯糸を置き、筬が打ち込む。布が一段ずつ生まれて手前へ流れていく。',
  camera: { pos: [7.5, 8, 22.5], target: [0, 0.4, 0.5] },

  build(root) {
    tickBeat = ticker();
    tickRun = ticker();

    // 経糸。1 本を「ビーム→綜絖」「綜絖→織り口」「織り口→布の端」の 3 区間で折る
    warp = new THREE.InstancedMesh(
      new THREE.BoxGeometry(TH, TH, 1),
      new THREE.MeshStandardMaterial({ roughness: 0.42, metalness: 0.3 }),
      WARP * 3,
    );
    warp.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    root.add(warp);

    // 緯糸。スロットを使い回すので、色はスロット番号だけで決まる
    weft = new THREE.InstancedMesh(
      new THREE.BoxGeometry(W, TH * 1.9, TH * 1.9),
      new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.32 }),
      PICKS,
    );
    weft.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    root.add(weft);

    // 置かれつつある緯糸。シャトルが進んだぶんだけ横に伸びる
    live = new THREE.Mesh(
      new THREE.BoxGeometry(1, TH * 1.9, TH * 1.9),
      new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.32 }),
    );
    root.add(live);

    // シャトル。紡錘形にして、走る向きへ長く見せる
    shuttle = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.SphereGeometry(0.3, 20, 12),
      new THREE.MeshStandardMaterial({
        color: emberColor(0.72),
        emissive: emberColor(0.5),
        emissiveIntensity: 0.55,
        roughness: 0.35,
        metalness: 0.5,
      }),
    );
    body.scale.set(3.1, 0.66, 0.9);
    shuttle.add(body);
    root.add(shuttle);

    // 筬。経糸の間に落ちる歯と、それを挟む上下の枠
    reed = new THREE.Group();
    const teeth = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.05, 3.2, 0.16),
      timber(),
      WARP + 1,
    );
    for (let i = 0; i <= WARP; i++) {
      dummy.position.set(((i - 0.5) / (WARP - 1) - 0.5) * W, 0, 0);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      teeth.setMatrixAt(i, dummy.matrix);
    }
    reed.add(teeth);
    for (const y of [1.68, -1.68]) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(W + 1.2, 0.16, 0.26), timber());
      bar.position.y = y;
      reed.add(bar);
    }
    root.add(reed);

    // 綜絖枠。開口の頂点をそのまま持ち上げる横木として置く
    const frameGeo = new THREE.BoxGeometry(W + 1.2, 0.18, 0.26);
    heddleA = new THREE.Mesh(frameGeo, timber());
    heddleB = new THREE.Mesh(frameGeo, timber());
    heddleA.position.z = -HEDDLE;
    heddleB.position.z = -HEDDLE;
    root.add(heddleA, heddleB);

    // 経糸を送り出すビームと、布を巻き取るビーム。どちらも送りに合わせて回る
    warpBeam = new THREE.Group();
    warpBeam.position.set(0, -BEAM, -BACK - 0.4);
    const wRoll = new THREE.Mesh(new THREE.CylinderGeometry(BEAM, BEAM, W + 0.9, 24), timber());
    wRoll.rotation.z = Math.PI / 2;
    warpBeam.add(wRoll);
    root.add(warpBeam);

    clothBeam = new THREE.Group();
    clothBeam.position.set(0, -BEAM, FRONT + 0.9);
    const cRoll = new THREE.Mesh(new THREE.CylinderGeometry(BEAM, BEAM, W + 0.9, 24), timber());
    cRoll.rotation.z = Math.PI / 2;
    clothBeam.add(cRoll);
    root.add(clothBeam);

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(21, 96),
      new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.28, metalness: 0.85 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -2.9;
    root.add(floor);
  },

  update(t) {
    const hue = drift(t);
    const phase = t / PICK;
    const k = Math.floor(phase); // 何越目か
    const p = phase - k; // 一越の中の位相
    const amount = shedAmount(p);
    const s = k % 2 === 0 ? 1 : -1; // 上下どちらの組が持ち上がっているか
    const advance = k + beatIn(p); // 布が進んだ段数（連続値）

    // 経糸。折れ線の頂点は「ビーム(0) → 綜絖(±開口) → 織り口(0) → 布の端(0)」
    for (let i = 0; i < WARP; i++) {
      const x = (i / (WARP - 1) - 0.5) * W;
      const yh = (i % 2 === 0 ? -1 : 1) * s * SHED * amount;
      const b = i * 3;
      segment(warp, b, x, -BACK, 0, -HEDDLE, yh);
      segment(warp, b + 1, x, -HEDDLE, yh, 0, 0);
      segment(warp, b + 2, x, 0, 0, FRONT, 0);

      // 持ち上がっている糸ほど明るく。開口が開くたびに縦縞が浮かび上がる
      ember(color, warpTone(i), hue, (Math.abs(yh) / SHED) * 0.07);
      warp.setColorAt(b, color);
      warp.setColorAt(b + 1, color);
      warp.setColorAt(b + 2, color);
    }
    warp.instanceMatrix.needsUpdate = true;
    if (warp.instanceColor) warp.instanceColor.needsUpdate = true;

    // 緯糸。スロット j は織り口から手前へ流れ、端まで行くと織り口へ戻ってくる
    for (let j = 0; j < PICKS; j++) {
      const age = ((((advance - j) % PICKS) + PICKS) % PICKS);
      const fade = clamp01(PICKS - age); // 手前の端では細らせて、巻き取られたことにする
      dummy.position.set(0, (j % 2 === 0 ? -1 : 1) * CRIMP, age * GAP);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, fade, fade);
      dummy.updateMatrix();
      weft.setMatrixAt(j, dummy.matrix);

      ember(color, weftTone(j), hue);
      weft.setColorAt(j, color);
    }
    weft.instanceMatrix.needsUpdate = true;
    if (weft.instanceColor) weft.instanceColor.needsUpdate = true;

    // シャトル。開口の底の糸をなぞるように滑る
    const run = clamp01((p - RUN_START) / (RUN_END - RUN_START));
    const dir = k % 2 === 0 ? 1 : -1;
    const edge = W / 2 + 1.3;
    const sx = dir * (smooth(run) * 2 - 1) * edge;
    shuttle.position.set(sx, -SHED * amount * SHUTTLE_F + 0.24, SHUTTLE_Z);
    shuttle.rotation.z = Math.sin(run * Math.PI) * 0.05 * dir;

    // 置かれつつある緯糸。シャトルの出発点から現在位置までを埋め、筬に押されて前へ出る
    const push = beatIn(p);
    const x0 = -dir * (W / 2);
    const x1 = Math.max(-W / 2, Math.min(W / 2, sx));
    live.position.set((x0 + x1) / 2, 0, SHUTTLE_Z * (1 - push));
    // 打ち込みきった瞬間に布の緯糸へ引き渡すので、そこで消す
    live.scale.set(p < BEAT_HIT ? Math.max(Math.abs(x1 - x0), 0.001) : 0.001, 1, 1);
    ember(color, weftTone((k + 1) % PICKS), hue);
    live.material.color.copy(color);

    // 筬は待機位置から織り口まで出て、ゆっくり戻る
    let rz = REED_REST;
    if (p > BEAT_IN && p < BEAT_HIT) rz = REED_REST * (1 - push);
    else if (p >= BEAT_HIT && p < BEAT_OUT)
      rz = REED_REST * smooth((p - BEAT_HIT) / (BEAT_OUT - BEAT_HIT));
    reed.position.z = rz;

    heddleA.position.y = -s * SHED * amount;
    heddleB.position.y = s * SHED * amount;

    // 送りぶんだけビームが回る。布が本当に巻き取られているように見える
    warpBeam.rotation.x = (advance * GAP) / BEAM;
    clothBeam.rotation.x = (advance * GAP) / BEAM;
  },

  sound(t, _dt, sfx) {
    const phase = t / PICK;

    // 筬が織り口を叩く「コトン」。その一越で入った緯糸の色で音程を選ぶ
    for (let n = tickBeat(phase - BEAT_HIT); n > 0; n--) {
      const j = (Math.floor(phase - BEAT_HIT) + 1) % PICKS;
      sfx.pluck(tone(1 + Math.round(weftTone(j) * 7)), { gain: 0.34, decay: 1.5 });
    }

    // シャトルが開口へ飛び込む音。走り出す側から鳴らす
    for (let n = tickRun(phase - RUN_START); n > 0; n--) {
      const dir = Math.floor(phase - RUN_START) % 2 === 0 ? 1 : -1;
      sfx.air({ gain: 0.2, decay: 0.6, pan: -dir * 0.65, freq: 820, sweep: 1.6 });
    }
  },
};
