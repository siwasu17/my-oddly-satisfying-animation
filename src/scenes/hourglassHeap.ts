import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, ticker } from '../audio.ts';
import { SURFACE, ember, emberColor, drift } from '../palette.ts';

/**
 * Hourglass Heap。
 *
 * ガラスの砂時計の首を、砂が細い一筋になって落ち続ける。下の室では円錐の山が
 * 安息角を保ったまま太り、壁に届くと裾を広げて盛り上がる。上の室では真ん中が
 * すり鉢状にくぼみ、そのまま水位が下がって首の中へ消えていく。
 * 落ちきると砂時計はふわりと持ち上がって 180° 返り、下にあった山が首のほうへ
 * 崩れ落ちて平らな面になり、また流れ始める。20 秒で 1 巡。
 *
 * 砂は各室 1 枚の回転体。断面の輪郭を毎フレーム t から組み直し、上下の体積の和が
 * 一定になるよう山の高さと水位を二分法で解いている。
 * 音は流れている間の細いさらさら音と低い持続音、最初の粒が底に着く音、
 * 返し終えて卓に置く音。
 */

// --- 形 -------------------------------------------------------------------

/** 首から各室の端までの高さ */
const H = 3.4;
/** 首の内径 */
const RN = 0.14;
/** 室のいちばん太いところの内径 */
const RMAX = 2.0;
/** 室の輪郭が太りきる位置（首からの割合）。そこから端へ少しすぼまる */
const BULGE = 0.62;
/** 端でのすぼまり（RMAX に対する割合） */
const TAPER = 0.14;
/** ガラスの厚み（砂の外側に置く） */
const GLASS_T = 0.05;
/** 両端の木の円盤の厚みと半径 */
const CAP_H = 0.32;
const CAP_R = RMAX + 0.7;
/**
 * 支柱の太さと置き方。左右に 2 本ずつ、真横から ±PILLAR_SPREAD ずらして立てる。
 * 正面から見てガラスの膨らみより外に出るので、一筋も砂山の裾も隠さない。
 */
const PILLAR_R = 0.075;
const PILLAR_AT = CAP_R - 0.18;
const PILLAR_SPREAD = 0.42;
/** 上の室のすり鉢の深さと、水位がこれを下回ったらくぼみを平らへ戻し始める高さ */
const DIP = 0.45;
const DIP_FADE = 0.55;
/** ガラスの濃さ。色を乗せすぎると、室が液体で満ちているように見える */
const GLASS_OPACITY = 0.05;
const GLASS_TINT = 0.3; // ember の glow。持ち上げるほど白っぽく色が抜ける
/** 砂の色（ember の n） */
const SAND_N = 0.7;

/** 砂の量（片側の室の容積に対する割合） */
const FILL = 0.34;
/** 安息角の傾き（tan 33°） */
const K = Math.tan((33 * Math.PI) / 180);

// --- 時間 -----------------------------------------------------------------

/** 1 巡の秒数 */
const CYCLE = 20;
/** 砂が流れている秒数 */
const FLOW = 15;
/** 落ちきってから返し始めるまでの間 */
const PAUSE = 0.8;
/** 返すのにかける秒数 */
const FLIP = 3.2;
/** 重力の強さ（落ちる一筋の先端と末尾の速さ） */
const G = 18;
/** 返すときに持ち上げる余裕 */
const LIFT = 0.35;

// --- 粒 -------------------------------------------------------------------

/** 一筋の中を落ちる粒の数 */
const STREAM_GRAINS = 26;
/** 山の斜面を転がり落ちる粒の数 */
const ROLL_GRAINS = 14;
const GRAIN_R = 0.045;
const STREAM_R = 0.035;
/** 粒が一筋を 1 本下りきる速さ（本/秒） */
const STREAM_SPEED = 1.7;
const ROLL_SPEED = 0.42;

// --- 音 -------------------------------------------------------------------

/** さらさら音の 1 秒あたりの回数 */
const HISS_RATE = 2.6;

// --- 回転体の分解能 -------------------------------------------------------

const P = 56; // 輪郭の点数
const SEG = 72; // 周方向の分割
const WALL_SAMPLES = 18;

// --- 床とカメラ -----------------------------------------------------------

const HALF = H + CAP_H; // 砂時計の中心から端までの高さ
const FLOOR_Y = -HALF - 0.01;

const dummy = new THREE.Object3D();
const color = new THREE.Color();

let pivot: THREE.Group;
let topSand: THREE.Mesh;
let lowSand: THREE.Mesh;
let sandMat: THREE.MeshStandardMaterial;
let stream: THREE.Mesh;
let streamMat: THREE.MeshStandardMaterial;
let grains: THREE.InstancedMesh;

/** 全体の砂の体積 */
let vTotal = 1;
/** 流れ始めの上の室の水位（平ら） */
let lStart = 1;
/** 落ちきった山の高さ */
let aFinal = 1;
/** 返すときに補間する 2 つの輪郭（落ちきった山 → 流れ始めの平らな面） */
const profHeapEnd = new Float32Array(P * 2);
const profTopStart = new Float32Array(P * 2);
const profScratch = new Float32Array(P * 2);
const poly: number[] = [];

let tickHiss = ticker();
let tickLand = ticker();
let tickSet = ticker();
let hissStep = 0;

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (x: number): number => {
  const c = clamp01(x);
  return c * c * (3 - 2 * c);
};
const frac = (x: number): number => x - Math.floor(x);

/** 首からの高さ h における室の内径。首では細い管、中ほどで太り、端で少しすぼまる。 */
function wallR(h: number): number {
  const u = clamp01(h / H);
  const s =
    u < BULGE
      ? (1 - Math.cos((Math.PI * u) / BULGE)) / 2
      : 1 - TAPER * ((u - BULGE) / (1 - BULGE)) ** 2;
  return RN + (RMAX - RN) * s;
}

/** 回転体の体積。輪郭 (r, h) の折れ線を軸で閉じたものとして数える。 */
function volume(pts: number[]): number {
  let v = 0;
  const n = pts.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const r0 = pts[i * 2]!;
    const h0 = pts[i * 2 + 1]!;
    const r1 = pts[j * 2]!;
    const h1 = pts[j * 2 + 1]!;
    v += (r0 * r0 + r0 * r1 + r1 * r1) * (h1 - h0);
  }
  return Math.abs((v * Math.PI) / 3);
}

/** 条件を満たす最大の r を二分法で探す（lo は満たし、hi は満たさない）。 */
function edge(lo: number, hi: number, inside: (r: number) => boolean): number {
  for (let i = 0; i < 24; i++) {
    const m = (lo + hi) / 2;
    if (inside(m)) lo = m;
    else hi = m;
  }
  return lo;
}

/**
 * 下の室の山。首からの高さで表し、底は h = H。高さ a の円錐が安息角で立ち、
 * 裾が壁に届いたら壁沿いに盛り上がる。輪郭は「底の軸 → 底 → 壁 → 斜面 → 頂」の順。
 * 返り値は裾の半径（転がる粒が止まる位置）。
 */
function heapPoly(a: number, out: number[]): number {
  out.length = 0;
  if (a <= 1e-4) {
    out.push(0, H, 0, H);
    return 0;
  }
  const base = a / K;
  if (base <= wallR(H)) {
    out.push(0, H, base, H, 0, H - a);
    return base;
  }
  const surf = (r: number): number => H - a + r * K;
  const rE = edge(0, base, (r) => r <= wallR(surf(r)));
  const hE = surf(rE);
  out.push(0, H, wallR(H), H);
  for (let s = 1; s <= WALL_SAMPLES; s++) {
    const h = H + ((hE - H) * s) / WALL_SAMPLES;
    out.push(wallR(h), h);
  }
  out.push(0, H - a);
  return rE;
}

/**
 * 上の室の砂。水位 L の平らな面の真ん中に、安息角のすり鉢が浅くくぼむ。
 * 漏斗の壁は安息角より急なので、すり鉢を首まで掘ると砂が壁に張り付く薄膜になって
 * 見えなくなる。くぼみは DIP までにとどめ、水位が首に近づいたら平らに戻す。
 * dip は 0..1（流れ始めにくぼみが育つ割合）。
 * 輪郭は「面の軸 → すり鉢 → 平らな面 → 壁 → 首」の順（heapPoly と同じ向き）。
 */
function topPoly(l: number, dip: number, out: number[]): void {
  out.length = 0;
  if (l <= 1e-4) {
    out.push(0, 0, 0, 0);
    return;
  }
  const yc = l - DIP * dip * smooth((l - DIP_FADE) / DIP_FADE);
  const surf = (r: number): number => Math.min(l, yc + r * K);
  const rE = edge(0, RMAX + 0.5, (r) => r <= wallR(surf(r)));
  const hE = surf(rE);
  out.push(0, surf(0));
  const rc = (l - yc) / K; // すり鉢の縁
  if (rc > 0 && rc < rE) out.push(rc, l);
  out.push(rE, hE);
  for (let s = 1; s <= WALL_SAMPLES; s++) {
    const h = hE * (1 - s / WALL_SAMPLES);
    out.push(wallR(h), h);
  }
  out.push(0, 0);
}

/** 体積 v になる山の高さ */
function solveHeap(v: number): number {
  let lo = 0;
  let hi = H * 0.95;
  for (let i = 0; i < 28; i++) {
    const m = (lo + hi) / 2;
    heapPoly(m, poly);
    if (volume(poly) < v) lo = m;
    else hi = m;
  }
  return (lo + hi) / 2;
}

/** 体積 v になる上の室の水位 */
function solveTop(v: number, dip: number): number {
  let lo = 0;
  let hi = H;
  for (let i = 0; i < 28; i++) {
    const m = (lo + hi) / 2;
    topPoly(m, dip, poly);
    if (volume(poly) < v) lo = m;
    else hi = m;
  }
  return (lo + hi) / 2;
}

/** 折れ線を弧長で P 点に打ち直す。点の数を揃えると、形どうしを補間できる。 */
function resample(pts: number[], out: Float32Array): void {
  const n = pts.length / 2;
  let total = 0;
  for (let i = 1; i < n; i++) {
    total += Math.hypot(pts[i * 2]! - pts[i * 2 - 2]!, pts[i * 2 + 1]! - pts[i * 2 - 1]!);
  }
  let seg = 1;
  let acc = 0;
  let segLen = n > 1 ? Math.hypot(pts[2]! - pts[0]!, pts[3]! - pts[1]!) : 0;
  for (let k = 0; k < P; k++) {
    const target = (k / (P - 1)) * total;
    while (seg < n - 1 && acc + segLen < target) {
      acc += segLen;
      seg++;
      segLen = Math.hypot(pts[seg * 2]! - pts[seg * 2 - 2]!, pts[seg * 2 + 1]! - pts[seg * 2 - 1]!);
    }
    const w = segLen > 1e-9 ? clamp01((target - acc) / segLen) : 0;
    const i0 = Math.max(0, seg - 1);
    const i1 = Math.min(n - 1, seg);
    out[k * 2] = pts[i0 * 2]! + (pts[i1 * 2]! - pts[i0 * 2]!) * w;
    out[k * 2 + 1] = pts[i0 * 2 + 1]! + (pts[i1 * 2 + 1]! - pts[i0 * 2 + 1]!) * w;
  }
}

/** 輪郭を回した面。頂点の並びは固定で、位置だけを毎フレーム書き換える。 */
function makeLathe(): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  const pos = new THREE.BufferAttribute(new Float32Array((SEG + 1) * P * 3), 3);
  pos.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', pos);
  const idx: number[] = [];
  for (let i = 0; i < SEG; i++) {
    for (let j = 0; j < P - 1; j++) {
      const a = i * P + j;
      const b = (i + 1) * P + j;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  geo.setIndex(idx);
  return geo;
}

/** 輪郭を回転体に書き込む。sign は室の向き（+1 で局所座標の上側）。 */
function writeLathe(mesh: THREE.Mesh, prof: Float32Array, sign: number): void {
  const geo = mesh.geometry;
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const arr = pos.array as Float32Array;
  for (let i = 0; i <= SEG; i++) {
    const phi = (i / SEG) * Math.PI * 2;
    const c = Math.cos(phi);
    const s = Math.sin(phi);
    for (let j = 0; j < P; j++) {
      const o = (i * P + j) * 3;
      const r = prof[j * 2]!;
      arr[o] = r * c;
      arr[o + 1] = sign * prof[j * 2 + 1]!;
      arr[o + 2] = r * s;
    }
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
}

/** その巡のどこにいるか */
function phaseOf(t: number): { cyc: number; tc: number; flip: number } {
  const cyc = Math.floor(t / CYCLE);
  const tc = t - cyc * CYCLE;
  const flip = smooth((tc - FLOW - PAUSE) / FLIP);
  return { cyc, tc, flip };
}

/** 流れている間、まだ落ちている途中のぶんも含めた流量が 0 でないか */
const flowing = (tc: number): boolean => tc > 0 && tc < FLOW + Math.sqrt((2 * H) / G);

export const hourglassHeap: SceneModule = {
  name: 'Hourglass Heap',
  desc: '砂時計の首を細い一筋が落ち、下の山は同じ角度のまま太っていく。落ちきると静かに返る。',
  camera: { pos: [0, 1.2, 15.5], target: [0, -0.4, 0] },

  build(root) {
    tickHiss = ticker();
    tickLand = ticker();
    tickSet = ticker();
    hissStep = 0;

    // 片側の室の容積から砂の量を決め、始まりと終わりの形を先に解いておく
    poly.length = 0;
    poly.push(0, H, wallR(H), H);
    for (let s = 1; s <= 60; s++) {
      const h = H * (1 - s / 60);
      poly.push(wallR(h), h);
    }
    poly.push(0, 0);
    vTotal = volume(poly) * FILL;
    lStart = solveTop(vTotal, 0);
    aFinal = solveHeap(vTotal);
    heapPoly(aFinal, poly);
    resample(poly, profHeapEnd);
    topPoly(lStart, 0, poly);
    resample(poly, profTopStart);

    pivot = new THREE.Group();
    root.add(pivot);

    // 砂。1 枚の回転体を室ごとに 1 つ
    sandMat = new THREE.MeshStandardMaterial({
      roughness: 0.92,
      metalness: 0.05,
      side: THREE.DoubleSide,
    });
    topSand = new THREE.Mesh(makeLathe(), sandMat);
    lowSand = new THREE.Mesh(makeLathe(), sandMat);
    topSand.frustumCulled = false;
    lowSand.frustumCulled = false;
    pivot.add(topSand, lowSand);

    // ガラス。薄く色を乗せ、奥の砂が透けて見えるようにする
    const glassPts: THREE.Vector2[] = [];
    for (let s = 0; s <= 96; s++) {
      const h = -H + (2 * H * s) / 96;
      glassPts.push(new THREE.Vector2(wallR(Math.abs(h)) + GLASS_T, h));
    }
    const glass = new THREE.Mesh(
      new THREE.LatheGeometry(glassPts, 72),
      new THREE.MeshStandardMaterial({
        color: emberColor(1, 0, GLASS_TINT),
        transparent: true,
        opacity: GLASS_OPACITY,
        roughness: 0.05,
        metalness: 0.3,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    glass.renderOrder = 2;
    pivot.add(glass);

    // 枠。両端の円盤と支柱（正面の中心軸を避けて 45° ずらす）
    const wood = new THREE.MeshStandardMaterial({
      color: emberColor(0.16, 0.01),
      roughness: 0.55,
      metalness: 0.15,
    });
    for (const side of [1, -1]) {
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(CAP_R, CAP_R, CAP_H, 64), wood);
      cap.position.y = side * (H + CAP_H / 2);
      pivot.add(cap);
    }
    const pillarGeo = new THREE.CylinderGeometry(PILLAR_R, PILLAR_R, 2 * H, 12);
    for (const phi of [
      PILLAR_SPREAD,
      -PILLAR_SPREAD,
      Math.PI + PILLAR_SPREAD,
      Math.PI - PILLAR_SPREAD,
    ]) {
      const pillar = new THREE.Mesh(pillarGeo, wood);
      pillar.position.set(Math.cos(phi) * PILLAR_AT, 0, Math.sin(phi) * PILLAR_AT);
      pivot.add(pillar);
    }

    // 落ちる一筋。上端を原点にして、Y スケールで長さを変える
    const sGeo = new THREE.CylinderGeometry(STREAM_R, STREAM_R, 1, 10, 1, true);
    sGeo.translate(0, -0.5, 0);
    streamMat = new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0.1 });
    stream = new THREE.Mesh(sGeo, streamMat);
    root.add(stream);

    // 一筋の中を落ちる粒と、山の斜面を転がる粒
    grains = new THREE.InstancedMesh(
      new THREE.SphereGeometry(GRAIN_R, 8, 6),
      new THREE.MeshStandardMaterial({ roughness: 0.7, metalness: 0.1 }),
      STREAM_GRAINS + ROLL_GRAINS,
    );
    grains.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    grains.frustumCulled = false;
    root.add(grains);

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(12, 96),
      new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.25, metalness: 0.9 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = FLOOR_Y;
    root.add(floor);
  },

  update(t) {
    const d = drift(t);
    const { cyc, tc, flip } = phaseOf(t);
    const sTop = cyc % 2 === 0 ? 1 : -1; // いま上にある室の向き（局所座標）

    // 返す: 角を通るときに卓へ当たらないぶんだけ持ち上げる
    const th = Math.PI * flip;
    const reach = HALF * Math.abs(Math.cos(th)) + CAP_R * Math.abs(Math.sin(th));
    const lift = Math.max(0, reach - HALF) + LIFT * Math.sin(th);
    pivot.rotation.z = Math.PI * (cyc + flip);
    pivot.position.y = lift;

    // 砂の受け渡し。流量は一定
    const f = clamp01(tc / FLOW);
    let heapEdge = 0;
    let apex = 0;
    if (tc < FLOW + PAUSE) {
      // 上の室: 最初の 1 秒ほどですり鉢がくぼみ、あとは水位が下がる
      const vTop = vTotal * (1 - f);
      const dip = smooth(f / 0.07);
      const l = solveTop(vTop, dip);
      topPoly(l, dip, poly);
      resample(poly, profScratch);
      writeLathe(topSand, profScratch, sTop);
      topSand.visible = vTop > vTotal * 1e-3;

      // 下の室: 山
      const vLow = vTotal * f;
      apex = solveHeap(vLow);
      heapEdge = heapPoly(apex, poly);
      resample(poly, profScratch);
      writeLathe(lowSand, profScratch, -sTop);
      lowSand.visible = vLow > vTotal * 1e-3;
    } else {
      // 返している間: 下にあった山が首のほうへ崩れて、平らな面になる
      topSand.visible = false;
      const m = smooth((flip - 0.4) / 0.55);
      for (let k = 0; k < P * 2; k++) {
        profScratch[k] = profHeapEnd[k]! + (profTopStart[k]! - profHeapEnd[k]!) * m;
      }
      writeLathe(lowSand, profScratch, -sTop);
      lowSand.visible = true;
    }
    ember(color, SAND_N, d);
    sandMat.color.copy(color);

    // 一筋。先端は首から自由落下し、流れが止まると末尾が同じように落ちていく
    const fallFront = 0.5 * G * tc * tc;
    const fallTail = tc > FLOW ? 0.5 * G * (tc - FLOW) ** 2 : 0;
    const top = -fallTail;
    const heapTop = -(H - apex);
    const bottom = Math.max(-fallFront, heapTop);
    const showStream = tc < FLOW + PAUSE && top > bottom + 1e-3;
    stream.visible = showStream;
    if (showStream) {
      stream.position.set(0, top, 0);
      stream.scale.set(1, top - bottom, 1);
    }
    ember(color, 0.8, d, 0.07);
    streamMat.color.copy(color);

    // 一筋の中の粒: 決まった間隔で上から下へ流れ、見えている範囲だけ出す
    for (let i = 0; i < STREAM_GRAINS; i++) {
      const u = frac(t * STREAM_SPEED + i / STREAM_GRAINS);
      const y = -u * (H - apex);
      const on = showStream && y <= top && y >= bottom;
      const a = i * 2.39996;
      dummy.position.set(Math.cos(a) * STREAM_R * 1.2, y, Math.sin(a) * STREAM_R * 1.2);
      dummy.scale.setScalar(on ? 1 : 0);
      dummy.updateMatrix();
      grains.setMatrixAt(i, dummy.matrix);
      ember(color, 0.86, d, 0.1);
      grains.setColorAt(i, color);
    }

    // 斜面を転がる粒: 頂から裾へ、ゆっくり加速しながら
    const rolling = tc > 0.6 && tc < FLOW && heapEdge > 0.05;
    for (let i = 0; i < ROLL_GRAINS; i++) {
      const ph = t * ROLL_SPEED + i * 0.618;
      const p = frac(ph);
      const a = i * 2.39996 + Math.floor(ph) * 1.3;
      const r = p * p * heapEdge;
      const h = H - apex + r * K;
      dummy.position.set(Math.cos(a) * r, -h + GRAIN_R, Math.sin(a) * r);
      dummy.scale.setScalar(rolling && p < 0.96 ? 1 - p * 0.4 : 0);
      dummy.updateMatrix();
      grains.setMatrixAt(STREAM_GRAINS + i, dummy.matrix);
      ember(color, 0.7, d, 0.02);
      grains.setColorAt(STREAM_GRAINS + i, color);
    }
    grains.instanceMatrix.needsUpdate = true;
    if (grains.instanceColor) grains.instanceColor.needsUpdate = true;
  },

  sound(t, _dt, sfx) {
    const { tc } = phaseOf(t);
    const on = flowing(tc);

    // 低い持続音。流れている間だけ
    sfx.drone(on ? tone(0) : null, 0.035);

    // さらさら音: 帯域の高いノイズを細かく置く
    for (let k = tickHiss(t * HISS_RATE); k > 0; k--) {
      if (!on) continue;
      hissStep++;
      sfx.air({
        gain: 0.05,
        decay: 0.55,
        freq: 2600 + (hissStep % 3) * 400,
        q: 0.9,
        pan: Math.sin(hissStep * 1.7) * 0.25,
      });
    }

    // 最初の粒が底に着く
    const land = Math.sqrt((2 * H) / G);
    for (let k = tickLand((t - land) / CYCLE); k > 0; k--) {
      sfx.drop(tone(9), { gain: 0.28, decay: 0.6 });
    }

    // 返し終えて卓に置く
    for (let k = tickSet((t - (FLOW + PAUSE + FLIP)) / CYCLE); k > 0; k--) {
      sfx.pluck(tone(2), { gain: 0.32, decay: 0.5 });
      sfx.pluck(tone(7), { gain: 0.14, decay: 0.9 });
    }
  },
};
