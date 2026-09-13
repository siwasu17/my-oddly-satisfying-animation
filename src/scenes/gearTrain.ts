import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { SceneModule } from '../types.ts';
import { tone, tickers } from '../audio.ts';
import { SURFACE, ember, emberColor, drift } from '../palette.ts';

/**
 * Gear Train。
 *
 * 何が動くか: 硝子の立方体の中が、46 枚の歯車で埋まっている。六つの面の内側に
 * 35 枚が貼り付き、面から離れた宙に 7 枚、面と面をつなぐ折れ目に 4 枚のかさ歯車。
 * 軸の向きは三つある。背面と前面は奥行き方向、底面と上面は上下方向、左面と
 * 右面は左右方向。立方体を端から端まで貫く長い軸が 3 本あり、奥から手前へ、
 * 右から左へ、底から上へ回転を運ぶ。背面の大歯車から始まった回転は、
 * かさ歯車で 90 度折れるたびに軸の向きを変えながら、46 枚すべてに行き渡る。
 * 気持ちよさの芯: これだけ詰まっているのに、どこを覗いても歯が 1 枚ぶんも
 * ずれずに噛み合っていること。箱を回すと、さっきまで奥にいた歯車が手前に出てくる。
 * ループの周期: 36 秒。この 1 周期で 46 枚すべてが寸分違わず初期姿勢へ戻る。
 * カメラ: 立方体の右上手前から、箱がちょうど画面に収まる距離。自動回転で六面が順に見える。
 * 音: 大きい歯車が 1 回転するたびに 1 音。低いほど大きい歯車。底に機械のうなり。
 * スコープ外: 物理演算、外部アセット、遊星機構、内歯車、はすば歯車。
 *
 * 噛み合いの式。歯車ごとに右手系の局所枠 (ex, ey, n) を持たせ、回転角 θ を n まわりの
 * 右ねじ角とする。接触点の方向を親の枠で測った角を a_P、子の枠で測った角を a_C とすると、
 *   θ_C = εk·θ_P + a_C − π/N_C − εk·a_P     （k = N_P/N_C）
 * で「親の歯山が来たところに子の歯谷が来る」。ε は回転の向きで、平歯車の外接は −1、
 * かさ歯車は円錐の伸びる向き s（±1）を使って ε = −s_P·s_C。
 * θ_P が時刻の一次式なので θ_C も一次式になり、係数と定数を先に畳んでおけば
 * update は rotation.z への代入 1 行で済む。
 */

// ---- 調整する数値 ----
const H = 3.6; // 立方体の半辺
const S = 2.75; // 平歯車を並べる面の位置（立方体の内側の面の少し手前）
const MODULE = 0.09; // 歯 1 枚ぶんの大きさ。ピッチ円の半径 = MODULE * 歯数 / 2
const BASE = 144; // 回転比の基準。CYCLE 秒で 1 周させたい歯数の最小公倍数
const CYCLE = 36; // 全部の歯車が初期姿勢へ戻るまでの秒数
const THICK = 0.46; // 平歯車の厚み
const BACKLASH = 0.44; // 歯の太さ。0.5 でぴったり、それ未満が遊び
const CONE_MIN = 0.4; // かさ歯車の円錐を、頂点からこの割合まで削り落とす
const SHAFT_R = 0.075; // 軸の太さ
const STUB = 0.3; // 壁に届かない側の軸の出しろ
const SPOKE_MIN = 24; // これ以上の歯数の平歯車には腕を入れる
const SPOKES = 5; // 腕の本数
const SOUND_MIN = 24; // これ以上の歯数の歯車だけが音を出す
const EDGE = 0.075; // 立方体の稜の太さ

type Axis = readonly [number, number, number];
const AX: Axis = [1, 0, 0];
const AY: Axis = [0, 1, 0];
const AZ: Axis = [0, 0, 1];

/**
 * 歯車のつなぎ方。
 * - root  : 起点。位置と軸を直に置く。
 * - spur  : 親と同軸・同一平面の平歯車。a は親の枠で測った配置方向。
 * - shaft : 親と同じ軸に刺さり、同じ速さで回る段付き歯車。d は軸方向の距離。
 * - bevel : 親（かさ歯車）と円錐の頂点を共有し、軸が直交するかさ歯車。
 * s は円錐が頂点から伸びる向き（軸ベクトルに対して ±1）。
 */
type Spec =
  | { t: number; k: 'root'; axis: Axis; pos: readonly [number, number, number] }
  | { t: number; k: 'spur'; from: number; a: number }
  | { t: number; k: 'shaft'; from: number; d: number; s?: 1 | -1 }
  | { t: number; k: 'bevel'; from: number; axis: Axis; s: 1 | -1 };

// 位置は連結の指定から導かれる。1 つ角度を振ると、離れた場所の 2 枚が食い込む。
// 変えたら全ペアの隙間・箱からのはみ出し・軸が他の歯車を貫いていないかを確かめること。
// 面に貼り付く歯車は、その面の軸を持つ列から spur で伸ばし、面をまたぐときだけ
// かさ歯車で折る。宙に浮いている歯車は、長い軸の途中に刺さった段付き歯車。
const SPEC: Spec[] = [
  { t: 36, k: 'root', axis: AZ, pos: [-1.05, 0.85, -S] }, //  0 背面・大歯車
  { t: 12, k: 'spur', from: 0, a: -0.75 }, //                  1 背面
  { t: 18, k: 'spur', from: 1, a: 0.2 }, //                    2 背面
  { t: 16, k: 'shaft', from: 1, d: 2 * S }, //                 3 前面（長い軸で奥から手前へ）
  { t: 24, k: 'spur', from: 3, a: 2.35 }, //                   4 前面
  { t: 16, k: 'spur', from: 4, a: 0.95 }, //                   5 前面
  { t: 16, k: 'shaft', from: 1, d: 3.0, s: 1 }, //             6 かさ歯車 A
  { t: 24, k: 'bevel', from: 6, axis: AY, s: -1 }, //          7 かさ歯車 A'（上下の軸へ折れる）
  { t: 24, k: 'shaft', from: 7, d: -2.13 }, //                 8 底面
  { t: 16, k: 'spur', from: 8, a: -2.4 }, //                   9 底面
  { t: 16, k: 'shaft', from: 5, d: -1.65, s: 1 }, //          10 かさ歯車 B
  { t: 24, k: 'bevel', from: 10, axis: AX, s: -1 }, //        11 かさ歯車 B'（左右の軸へ折れる）
  { t: 24, k: 'shaft', from: 11, d: -3.07 }, //               12 左面（長い軸で右から左へ）
  { t: 16, k: 'spur', from: 12, a: -1.117 }, //               13 左面
  { t: 18, k: 'spur', from: 0, a: 4.42 }, //                 14 背面
  { t: 18, k: 'spur', from: 0, a: 0.52 }, //                 15 背面
  { t: 24, k: 'spur', from: 2, a: 4.78 }, //                 16 背面
  { t: 24, k: 'spur', from: 3, a: 5.585 }, //                17 前面
  { t: 18, k: 'spur', from: 4, a: 3.229 }, //                18 前面
  { t: 18, k: 'spur', from: 5, a: 0.175 }, //                19 前面
  { t: 18, k: 'spur', from: 8, a: 0.663 }, //                20 底面
  { t: 18, k: 'spur', from: 8, a: 5.585 }, //                21 底面
  { t: 24, k: 'spur', from: 13, a: 4.939 }, //               22 左面
  { t: 18, k: 'spur', from: 12, a: 0.14 }, //                23 左面
  { t: 18, k: 'shaft', from: 21, d: 5.5 }, //                 24 上面（底から上へ貫く軸）
  { t: 24, k: 'shaft', from: 13, d: 5.52 }, //               25 右面（左から右へ貫く軸）
  { t: 18, k: 'spur', from: 25, a: 1.152 }, //               26 右面
  { t: 18, k: 'spur', from: 25, a: 5.044 }, //               27 右面
  { t: 16, k: 'spur', from: 25, a: 3.142 }, //               28 右面
  { t: 18, k: 'spur', from: 24, a: 3.124 }, //               29 上面
  { t: 24, k: 'shaft', from: 1, d: 1.35 }, //                 30 中間の層
  { t: 18, k: 'spur', from: 30, a: 0.7 }, //                  31 中間の層
  { t: 18, k: 'spur', from: 30, a: 3.3 }, //                  32 中間の層
  { t: 16, k: 'spur', from: 29, a: 1.99 }, //                 33 上面
  { t: 24, k: 'shaft', from: 21, d: 3.8 }, //                 34 中間の層（上下の軸）
  { t: 18, k: 'shaft', from: 13, d: 4.6 }, //                 35 中間の層（左右の軸）
  { t: 16, k: 'spur', from: 34, a: 1.274 }, //                36 中間の層
  { t: 16, k: 'spur', from: 35, a: 3.403 }, //                37 中間の層
  { t: 18, k: 'spur', from: 18, a: 4.869 }, //                38 前面
  { t: 18, k: 'spur', from: 18, a: 1.431 }, //                39 前面
  { t: 18, k: 'spur', from: 15, a: 0.262 }, //                40 背面
  { t: 16, k: 'spur', from: 27, a: 3.7 }, //                  41 右面
  { t: 16, k: 'spur', from: 22, a: 3.787 }, //                42 左面
  { t: 16, k: 'spur', from: 22, a: 5.515 }, //                43 左面
  { t: 16, k: 'spur', from: 14, a: 5.655 }, //                44 背面
  { t: 16, k: 'spur', from: 20, a: 2.199 }, //                45 底面
];

interface Gear {
  teeth: number;
  /** 回転軸（右ねじ） */
  n: THREE.Vector3;
  /** 平歯車は円盤の中心、かさ歯車は円錐の頂点 */
  c: THREE.Vector3;
  ex: THREE.Vector3;
  ey: THREE.Vector3;
  /** 回転角 = spin * t + phase */
  spin: number;
  phase: number;
  /** かさ歯車なら円錐の伸びる向き（±1）。平歯車は 0。 */
  s: number;
  /** かさ歯車の相手の歯数。円錐角と軸方向の長さがこれで決まる。 */
  mate: number;
}

interface Shaft {
  n: THREE.Vector3;
  base: THREE.Vector3;
  lo: number;
  hi: number;
}

/** ピッチ円の半径 */
const radiusOf = (teeth: number): number => (MODULE * teeth) / 2;

/** 軸ベクトルから、右手系になる局所枠を 1 つ選ぶ。 */
function frameOf(n: THREE.Vector3): [THREE.Vector3, THREE.Vector3] {
  const up = new THREE.Vector3(0, Math.abs(n.y) < 0.9 ? 1 : 0, Math.abs(n.y) < 0.9 ? 0 : 1);
  const ex = up.cross(n).normalize();
  const ey = n.clone().cross(ex).normalize();
  return [ex, ey];
}

const GEARS: Gear[] = [];
const SHAFTS: Shaft[] = [];

{
  /** 同じ軸に刺さっている歯車をまとめる番号 */
  const group: number[] = [];
  let groups = 0;

  for (const sp of SPEC) {
    if (sp.k === 'root') {
      const n = new THREE.Vector3(...sp.axis);
      const [ex, ey] = frameOf(n);
      GEARS.push({
        teeth: sp.t,
        n,
        c: new THREE.Vector3(...sp.pos),
        ex,
        ey,
        spin: ((Math.PI * 2) / CYCLE) * (BASE / sp.t),
        phase: 0,
        s: 0,
        mate: 0,
      });
      group.push(groups++);
      continue;
    }

    const p = GEARS[sp.from]!;
    if (sp.k === 'shaft') {
      GEARS.push({
        teeth: sp.t,
        n: p.n,
        c: p.c.clone().addScaledVector(p.n, sp.d),
        ex: p.ex,
        ey: p.ey,
        spin: p.spin,
        phase: p.phase,
        s: sp.s ?? 0,
        mate: 0,
      });
      group.push(group[sp.from]!);
      continue;
    }

    let n: THREE.Vector3;
    let ex: THREE.Vector3;
    let ey: THREE.Vector3;
    let c: THREE.Vector3;
    let aP: number; // 接触方向を親の枠で測った角
    let aC: number; // 同じ方向を子の枠で測った角
    let eps: number; // 回転の向き
    let s = 0;
    let mate = 0;

    if (sp.k === 'spur') {
      n = p.n;
      ex = p.ex;
      ey = p.ey;
      const dir = ex.clone().multiplyScalar(Math.cos(sp.a)).addScaledVector(ey, Math.sin(sp.a));
      c = p.c.clone().addScaledVector(dir, radiusOf(p.teeth) + radiusOf(sp.t));
      aP = Math.atan2(dir.dot(p.ey), dir.dot(p.ex));
      aC = Math.atan2(-dir.dot(ey), -dir.dot(ex));
      eps = -1;
    } else {
      // 円錐どうしは頂点を共有する。接触線を互いの回転面へ落とすと、
      // 親から見れば相手の円錐が伸びる向き、子から見れば親の伸びる向きになる。
      n = new THREE.Vector3(...sp.axis);
      [ex, ey] = frameOf(n);
      c = p.c.clone();
      const dirP = p.n.clone().multiplyScalar(p.s);
      const dirC = n.clone().multiplyScalar(sp.s);
      aP = Math.atan2(dirC.dot(p.ey), dirC.dot(p.ex));
      aC = Math.atan2(dirP.dot(ey), dirP.dot(ex));
      eps = -p.s * sp.s;
      s = sp.s;
      mate = p.teeth;
      p.mate = sp.t;
    }

    const k = p.teeth / sp.t;
    GEARS.push({
      teeth: sp.t,
      n,
      c,
      ex,
      ey,
      spin: eps * k * p.spin,
      phase: eps * k * p.phase + aC - Math.PI / sp.t - eps * k * aP,
      s,
      mate,
    });
    group.push(groups++);
  }

  /** 歯車が軸方向に占める区間 */
  const spanOf = (g: Gear): [number, number] => {
    const t = g.c.dot(g.n);
    if (!g.s) return [t - THICK / 2, t + THICK / 2];
    const h = radiusOf(g.mate);
    return g.s > 0 ? [t + h * CONE_MIN, t + h] : [t - h, t - h * CONE_MIN];
  };

  for (let gi = 0; gi < groups; gi++) {
    const idx = group.map((g, i) => (g === gi ? i : -1)).filter((i) => i >= 0);
    if (!idx.length) continue;
    const n = GEARS[idx[0]!]!.n;

    let lo = Infinity;
    let hi = -Infinity;
    for (const i of idx) {
      const [a, b] = spanOf(GEARS[i]!);
      lo = Math.min(lo, a);
      hi = Math.max(hi, b);
    }
    // 壁が近い側は壁まで伸ばして軸受けにする。遠い側は少し出すだけ。
    lo = lo + H < 1.2 ? -H : lo - STUB;
    hi = H - hi < 1.2 ? H : hi + STUB;

    // かさ歯車の頂点の向こうに用が無ければ、軸は円錐の大端で止める。
    // そうしないと相手のかさ歯車の軸と、頂点で必ずぶつかる。
    for (const i of idx) {
      const g = GEARS[i]!;
      if (!g.s) continue;
      const t = g.c.dot(n);
      if (idx.some((j) => j !== i && (GEARS[j]!.c.dot(n) - t) * g.s < 0)) continue;
      const h = radiusOf(g.mate);
      if (g.s > 0) lo = Math.max(lo, t + h);
      else hi = Math.min(hi, t - h);
    }

    SHAFTS.push({ n, base: GEARS[idx[0]!]!.c, lo, hi });
  }
}

/** CYCLE 秒あたりの回転数。4〜12 に収まる。 */
const turnsOf = (g: Gear): number => (Math.abs(g.spin) * CYCLE) / (Math.PI * 2);
/** 速い歯車ほど明るい琥珀へ寄せる。 */
const TINT = GEARS.map((g) => 0.3 + 0.42 * ((turnsOf(g) - 4) / 8));

const dummy = new THREE.Object3D();
const color = new THREE.Color();
const mat4 = new THREE.Matrix4();
const vU = new THREE.Vector3();
const vT = new THREE.Vector3();
const vW = new THREE.Vector3();
const vP = new THREE.Vector3();
const quat = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);

const spinners: THREE.Group[] = [];
const bodyMats: THREE.MeshStandardMaterial[] = [];
const toothMats: THREE.MeshStandardMaterial[] = [];
let edgeMat: THREE.MeshStandardMaterial;

/**
 * 音を出す歯車。
 *
 * 歯数の多いものほど回転が遅く、拍の間隔があく。40 枚すべてを鳴らすと
 * 秒に 2 つ近く鳴って騒がしいので、大きいものをさらに 1 つおきに選ぶ。
 * 残りは黙って回る。
 */
const VOICED: number[] = [];
for (let i = 0, n = 0; i < GEARS.length; i++) {
  if (GEARS[i]!.teeth >= SOUND_MIN && n++ % 2 === 0) VOICED.push(i);
}

/** 歯車ごとに「1 回転した回数」を数える */
let ticks = tickers(GEARS.length);

/** 硝子の箱と、その 12 本の稜。稜は動かないので 1 つに畳む。 */
function addCube(root: THREE.Group): void {
  const glass = new THREE.MeshPhysicalMaterial({
    color: emberColor(0.5),
    transparent: true,
    opacity: 0.045,
    roughness: 0.1,
    metalness: 0,
    side: THREE.DoubleSide,
    // 奥の面も透けて見えるように、深度は書かない
    depthWrite: false,
  });
  root.add(new THREE.Mesh(new THREE.BoxGeometry(H * 2, H * 2, H * 2), glass));

  edgeMat = new THREE.MeshStandardMaterial({
    color: emberColor(0.44),
    roughness: 0.38,
    metalness: 0.55,
  });
  const bars: THREE.BufferGeometry[] = [];
  for (let axis = 0; axis < 3; axis++) {
    for (let q = 0; q < 4; q++) {
      const u = (q & 1 ? 1 : -1) * H;
      const v = (q & 2 ? 1 : -1) * H;
      const bar = new THREE.BoxGeometry(
        axis === 0 ? H * 2 + EDGE : EDGE,
        axis === 1 ? H * 2 + EDGE : EDGE,
        axis === 2 ? H * 2 + EDGE : EDGE,
      );
      if (axis === 0) bar.translate(0, u, v);
      else if (axis === 1) bar.translate(u, 0, v);
      else bar.translate(u, v, 0);
      bars.push(bar);
    }
  }
  root.add(new THREE.Mesh(mergeGeometries(bars)!, edgeMat));
}

/**
 * 歯車 1 枚を、地と歯の 2 つの材質を持つ 1 メッシュに畳む。
 *
 * 素直に組むと 1 枚が円盤・腹・軸受け・腕 5 本で 8 メッシュになる。40 枚を
 * 超えると、それだけで描画の呼び出しが 300 を上回ってしまう。位置と向きは
 * ジオメトリに焼き込めるので、まとめてから 1 度で描く。色を変えたいところが
 * 2 つ（地と軸受け）あるので、groups を持たせて材質を配列で渡す。
 */
function addSolid(
  inner: THREE.Group,
  body: THREE.BufferGeometry[],
  hub: THREE.BufferGeometry,
  bodyMat: THREE.MeshStandardMaterial,
  toothMat: THREE.MeshStandardMaterial,
): void {
  const merged = mergeGeometries([mergeGeometries(body)!, hub], true)!;
  inner.add(new THREE.Mesh(merged, [bodyMat, toothMat]));
}

/** 平歯車の中身。円盤・軸受け・腕・歯。 */
function addSpur(
  inner: THREE.Group,
  g: Gear,
  bodyMat: THREE.MeshStandardMaterial,
  toothMat: THREE.MeshStandardMaterial,
): void {
  const r = radiusOf(g.teeth) - MODULE * 0.9;
  const seg = Math.max(28, g.teeth * 2);
  const body: THREE.BufferGeometry[] = [];

  // 縁。両端の蓋を持たない筒にすると、内側が窪んで輪に見える。
  body.push(new THREE.CylinderGeometry(r, r, THICK, seg, 1, true).rotateX(Math.PI / 2));
  body.push(
    new THREE.CylinderGeometry(r * 0.995, r * 0.995, THICK * 0.34, seg).rotateX(Math.PI / 2),
  );

  const hubR = Math.max(0.17, r * 0.26);
  const hub = new THREE.CylinderGeometry(hubR, hubR, THICK * 1.35, 18).rotateX(Math.PI / 2);

  // 腕。大きい歯車だけに入れる。歯だけだと回転の向きが読み取りにくい。
  if (g.teeth >= SPOKE_MIN) {
    const armLen = r - hubR;
    for (let s = 0; s < SPOKES; s++) {
      const a = (s / SPOKES) * Math.PI * 2;
      const arm = new THREE.BoxGeometry(armLen, MODULE * 1.6, THICK * 0.6).rotateZ(a);
      arm.translate(Math.cos(a) * (hubR + armLen / 2), Math.sin(a) * (hubR + armLen / 2), 0);
      body.push(arm);
    }
  }
  addSolid(inner, body, hub, bodyMat, toothMat);

  const pitch = radiusOf(g.teeth);
  const teeth = new THREE.InstancedMesh(
    new THREE.BoxGeometry(MODULE * 2, MODULE * Math.PI * BACKLASH, THICK),
    toothMat,
    g.teeth,
  );
  for (let k = 0; k < g.teeth; k++) {
    const a = (k / g.teeth) * Math.PI * 2;
    dummy.position.set(Math.cos(a) * pitch, Math.sin(a) * pitch, 0);
    dummy.rotation.set(0, 0, a);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    teeth.setMatrixAt(k, dummy.matrix);
  }
  teeth.instanceMatrix.needsUpdate = true;
  inner.add(teeth);
}

/**
 * かさ歯車の中身。
 *
 * 頂点を原点に置き、円錐を局所 +Z の s 側へ伸ばす。円錐の開き角 γ は
 * tanγ = 自分の歯数 / 相手の歯数 で、母線の長さ R = hypot(自分の半径, 相手の半径)。
 * 歯は母線に沿った箱を、ピッチ円錐の上へ等間隔に並べて作る。
 */
function addBevel(
  inner: THREE.Group,
  g: Gear,
  bodyMat: THREE.MeshStandardMaterial,
  toothMat: THREE.MeshStandardMaterial,
): void {
  const r = radiusOf(g.teeth);
  const h = radiusOf(g.mate);
  const R = Math.hypot(r, h);
  const sg = r / R; // sin γ
  const cg = h / R; // cos γ

  // 本体はピッチ円錐を、円錐の法線方向へ歯たけの半分だけ内側へずらした円錐。
  // 半径だけを縮めると母線の傾きが変わって歯が宙に浮くので、軸方向も一緒にずらす。
  const d = MODULE * 0.95;
  const uNear = R * CONE_MIN;
  const rNear = sg * uNear - d * cg;
  const rFar = sg * R - d * cg;
  const zNear = g.s * (cg * uNear + d * sg);
  const zFar = g.s * (cg * R + d * sg);
  const len = Math.abs(zFar - zNear);
  const zMid = (zNear + zFar) / 2;

  // 円錐の大端（半径の大きいほう）が s の側へ向くように倒す
  const cone = new THREE.CylinderGeometry(
    rFar,
    rNear,
    len,
    Math.max(28, g.teeth * 2),
  ).rotateX((g.s > 0 ? 1 : -1) * (Math.PI / 2));
  cone.translate(0, 0, zMid);

  const hubR = Math.max(0.15, r * 0.2);
  const hub = new THREE.CylinderGeometry(hubR, hubR, len * 1.25, 18).rotateX(Math.PI / 2);
  hub.translate(0, 0, zMid);

  addSolid(inner, [cone], hub, bodyMat, toothMat);

  const mid = (1 + CONE_MIN) / 2; // 歯を置く母線上の位置（R に対する割合）
  const geo = new THREE.BoxGeometry(
    R * (1 - CONE_MIN) * 0.9, // 歯幅（母線方向）
    Math.PI * MODULE * mid * BACKLASH, // 歯の厚み（回転方向）
    MODULE * 1.9, // 歯たけ（円錐の法線方向）
  );
  // 円錐の歯は頂点へ向かって細る。箱のままだと頂点寄りで隣の歯と食い込むので、
  // 母線上の位置に比例して厚みと歯たけを絞り、くさびにする。
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const f = (mid * R + pos.getX(i)) / (mid * R);
    pos.setY(i, pos.getY(i) * f);
    pos.setZ(i, pos.getZ(i) * f);
  }
  geo.computeVertexNormals();

  const teeth = new THREE.InstancedMesh(geo, toothMat, g.teeth);
  for (let k = 0; k < g.teeth; k++) {
    const a = (k / g.teeth) * Math.PI * 2;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    vU.set(sg * ca, sg * sa, g.s * cg); // 母線方向
    vT.set(-sa, ca, 0); // 回転方向
    vW.crossVectors(vU, vT); // 円錐の法線方向
    mat4.makeBasis(vU, vT, vW).setPosition(vU.x * R * mid, vU.y * R * mid, vU.z * R * mid);
    teeth.setMatrixAt(k, mat4);
  }
  teeth.instanceMatrix.needsUpdate = true;
  inner.add(teeth);
}

export const gearTrain: SceneModule = {
  name: 'Gear Train',
  desc: '硝子の立方体を 46 枚の歯車が埋めている。かさ歯車で 90 度ずつ折れ、六面へ伝わる。',
  camera: { pos: [4.88, 3.76, 13.99], target: [0, 0, 0] },

  build(root) {
    ticks = tickers(GEARS.length);
    spinners.length = 0;
    bodyMats.length = 0;
    toothMats.length = 0;

    addCube(root);

    const steelMat = new THREE.MeshStandardMaterial({
      color: SURFACE,
      roughness: 0.45,
      metalness: 0.5,
    });

    // 軸。壁から壁へ渡したものと、途中で終わるものがある。
    // どれも動かないので、歯車と同じように 1 つのメッシュへ畳む。
    const rods: THREE.BufferGeometry[] = [];
    for (const sh of SHAFTS) {
      quat.setFromUnitVectors(UP, sh.n);
      const along = sh.base.dot(sh.n);
      const place = (at: number): THREE.Matrix4 =>
        mat4
          .makeRotationFromQuaternion(quat)
          .setPosition(vP.copy(sh.base).addScaledVector(sh.n, at - along));

      const rod = new THREE.CylinderGeometry(SHAFT_R, SHAFT_R, sh.hi - sh.lo, 12);
      rods.push(rod.applyMatrix4(place((sh.lo + sh.hi) / 2)));
      // 軸受けの輪。壁ぎわで軸が終わっているように見せる。
      for (const end of [sh.lo, sh.hi]) {
        const collar = new THREE.CylinderGeometry(SHAFT_R * 2.1, SHAFT_R * 2.1, 0.14, 14);
        rods.push(collar.applyMatrix4(place(end)));
      }
    }
    root.add(new THREE.Mesh(mergeGeometries(rods)!, steelMat));

    for (const g of GEARS) {
      // 外側は姿勢だけを持ち、内側が軸まわりに回る。
      const outer = new THREE.Group();
      outer.position.copy(g.c);
      outer.quaternion.setFromRotationMatrix(mat4.makeBasis(g.ex, g.ey, g.n));
      root.add(outer);

      const inner = new THREE.Group();
      outer.add(inner);
      spinners.push(inner);

      const tint = TINT[spinners.length - 1]!;
      const bodyMat = new THREE.MeshStandardMaterial({
        color: emberColor(tint),
        roughness: 0.46,
        metalness: 0.36,
      });
      const toothMat = new THREE.MeshStandardMaterial({
        color: emberColor(tint, 0, 0.12),
        roughness: 0.32,
        metalness: 0.44,
      });
      bodyMats.push(bodyMat);
      toothMats.push(toothMat);

      if (g.s) addBevel(inner, g, bodyMat, toothMat);
      else addSpur(inner, g, bodyMat, toothMat);
    }
  },

  update(t) {
    const shift = drift(t);
    for (let i = 0; i < GEARS.length; i++) {
      const g = GEARS[i]!;
      spinners[i]!.rotation.z = g.spin * t + g.phase;

      const tint = TINT[i]!;
      ember(color, tint, shift);
      bodyMats[i]!.color.copy(color);
      ember(color, tint, shift, 0.12);
      toothMats[i]!.color.copy(color);
    }
    ember(color, 0.44, shift);
    edgeMat.color.copy(color);
  },

  sound(t, _dt, sfx) {
    for (const i of VOICED) {
      const g = GEARS[i]!;
      // 1 回転を 1 拍として数える。向きは符号で入っているので絶対値で見る。
      const turns = (Math.abs(g.spin) * t) / (Math.PI * 2);
      for (let k = ticks[i]!(turns); k > 0; k--) {
        sfx.pluck(tone(Math.round(20 - g.teeth * 0.28)), {
          gain: 0.1 + (0.18 * g.teeth) / 36,
          decay: 1.4 + (2.2 * g.teeth) / 36,
          pan: Math.max(-1, Math.min(1, g.c.x / H)),
        });
      }
    }
    sfx.drone(tone(-7), 0.035 + 0.012 * Math.sin(t * 0.6));
  },
};
