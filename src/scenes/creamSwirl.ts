import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, tickers } from '../audio.ts';
import { SURFACE, ember, emberColor, drift } from '../palette.ts';

/**
 * 一色の液体を張った浅い器に、太いミルクの筋が落ちる。着水した白い溜まりは
 * 輪を広げながら、中心ほど速く回る渦と、少しずれた場所にあるもう一つの弱い渦に
 * 引かれて、長い時間をかけてゆっくり巻き取られていく。細く伸びた筋はやがて溶けて
 * 消え、器全体がひとつの新しい色に変わる。そこからは静かに元の色へ沈み、また注がれる。
 * 液面は極座標グリッドの円盤 1 枚。渦は座標を巻き戻して元の配置を引き直すだけだが、
 * うねりと波紋は高さと法線を式から作るので、光の筋が水面のようにずっと動いている。
 * ループ 40 秒 / 俯瞰やや斜め / 注ぐ間の水音と、混ざりきる瞬間のひと息。
 */

// ---- 調整する数値 ----------------------------------------------------------
const R = 9;              // 液面の半径
const RINGS = 80;         // 液面の半径方向の分割数。らせんの筋はここで解像する
const SECTORS = 128;      // 液面の円周方向の分割数
const CYCLE = 40;         // 注がれてから元の色へ戻るまでの秒数
const POUR_AT = 0.35;     // ミルクが着水する時刻（秒）。開いた直後に注ぎが見える
const POUR_SEC = 4.2;     // 筋が落ちている長さ（秒）
const BLOB_GROW = 1.6;    // 溜まりが広がりきるまでの秒数
const SWIRL = 24;         // 中心での総ねじれ（rad）。1 周かけてここまで巻く
const SWIRL2 = 7;         // 副渦の強さ（rad）。筋を蛇行させて円運動から外す
const V2_POS = 0.44;      // 副渦の位置（R 比）
const V2_SIG = 0.36;      // 副渦の効く範囲（R 比）
const BLOB_POS = 0.34;    // ミルクが落ちる場所（R 比。x 方向）
const BLOB_R = 0.5;       // 溜まりの広がり（R 比）
const BLOB_SOFT = 1.0;    // 溜まりの縁のやわらかさ（ワールド）
const SOFT_TW = 0.34;     // ねじれるほど縁がにじむ量
const WOBBLE = 0.6;       // 筋の縁の乱れ。まっすぐな輪郭を崩す
const WOB_END = 0.45;     // 乱れが消えるねじれ量（SWIRL 比）
const MILK = 0.4;         // 混ざりきったときのミルクの比率 = 新しい単色
const MIX_FROM = 0.3;     // 筋が溶けはじめる位相
const MIX_TO = 0.78;      // 全面が新しい単色になる位相
const SETTLE = 0.86;      // ここから元の色へ沈む位相
const SINK_W = 0.42;      // 沈みの front の幅（R 比）。縁から中心へ色が引いていく
const TONE_BASE = 0.1;    // 元の液体（暗い薔薇）
const TONE_MILK = 0.98;   // ミルク（明るい琥珀）
const EDGE_DARK = 0.4;    // 器に接するところを落とす量。液面の縁を硬く見せない
const RIP_A = 0.16;       // 着水の波紋の高さ
const RIP_K = 1.9;        // 波紋の細かさ
const RIP_W = 4.2;        // 波紋が広がる速さ
const RIP_D = 0.26;       // 波紋の減衰
const RING_A = 0.45;      // 着水の輪を色でも見せる量
// うねり 3 本 [kx, kz, 振幅, 角速度]。振幅 × 波数が斜面になるので、ここが液面らしさの正体。
// 角速度は 1 周でちょうど整数回になるよう選んであり、ループの継ぎ目ができない
const W1 = [0.75, 0.42, 0.13, (Math.PI * 2 * 3) / CYCLE];
const W2 = [-0.31, 0.68, 0.11, (Math.PI * 2 * 4) / CYCLE];
const W3 = [1.6, -1.1, 0.055, (Math.PI * 2 * 7) / CYCLE];
const STREAM_R = 0.3;     // ミルクの筋の太さ
const STREAM_H = 7;       // ミルクの筋の長さ
const WALL_H = 1.7;       // 器の深さ
const CAM = { pos: [0, 18, 12.5] as [number, number, number], target: [0, 0, 0] as [number, number, number] };

const PHASE_DEBUG = 0;    // 検証で後半の位相を撮るときだけ動かす。通常は 0
const TAU = Math.PI * 2;
const PX = R * BLOB_POS;  // 着水点
const PZ = R * 0.12;

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth01 = (x: number): number => {
  const u = clamp01(x);
  return u * u * (3 - 2 * u);
};

const colA = new THREE.Color();
const colB = new THREE.Color();

let surface: THREE.Mesh;
let surfPos: THREE.BufferAttribute;
let surfNor: THREE.BufferAttribute;
let surfCol: THREE.BufferAttribute;
let stream: THREE.Mesh;

/** 液面の頂点ごとの値。着水点もうねりも動かないので、空間項は build で持っておく */
let vx = new Float32Array(0);
let vz = new Float32Array(0);
let vdp = new Float32Array(0);   // 着水点からの距離
let vnx = new Float32Array(0);   // 着水点から見た向き（単位ベクトル）
let vnz = new Float32Array(0);
let vw1 = new Float32Array(0);   // うねり 3 本の空間位相
let vw2 = new Float32Array(0);
let vw3 = new Float32Array(0);
let ved = new Float32Array(0);   // 縁の落とし込み
let vrn = new Float32Array(0);   // 正規化半径。沈みの front はこれで引く

let ticks = tickers(2);
let step = 0;

/** 極座標グリッドの円盤。位置・法線・色を毎フレーム書き換える */
function buildDisc(): THREE.BufferGeometry {
  const v = (RINGS + 1) * SECTORS;
  const pos = new Float32Array(v * 3);
  const nor = new Float32Array(v * 3);
  const col = new Float32Array(v * 3);
  vx = new Float32Array(v);
  vz = new Float32Array(v);
  vdp = new Float32Array(v);
  vnx = new Float32Array(v);
  vnz = new Float32Array(v);
  vw1 = new Float32Array(v);
  vw2 = new Float32Array(v);
  vw3 = new Float32Array(v);
  ved = new Float32Array(v);
  vrn = new Float32Array(v);

  for (let i = 0; i <= RINGS; i++) {
    // 中心付近を細かく取ると、いちばんねじれる場所の筋が潰れない
    const rn = (i / RINGS) ** 1.35;
    const r = rn * R;
    for (let j = 0; j < SECTORS; j++) {
      const k = i * SECTORS + j;
      const th = (j / SECTORS) * TAU;
      const x = Math.cos(th) * r;
      const z = Math.sin(th) * r;
      vx[k] = x;
      vz[k] = z;
      const dx = x - PX;
      const dz = z - PZ;
      const d = Math.sqrt(dx * dx + dz * dz) + 1e-4;
      vdp[k] = d;
      vnx[k] = dx / d;
      vnz[k] = dz / d;
      vw1[k] = W1[0] * x + W1[1] * z;
      vw2[k] = W2[0] * x + W2[1] * z;
      vw3[k] = W3[0] * x + W3[1] * z;
      ved[k] = 1 - EDGE_DARK * smooth01((rn - 0.9) / 0.1);
      vrn[k] = rn;
      pos[k * 3] = x;
      pos[k * 3 + 2] = z;
      nor[k * 3 + 1] = 1;
    }
  }

  const idx = new Uint16Array(RINGS * SECTORS * 6);
  let o = 0;
  for (let i = 0; i < RINGS; i++) {
    for (let j = 0; j < SECTORS; j++) {
      const j2 = (j + 1) % SECTORS;
      const a = i * SECTORS + j;
      const b = i * SECTORS + j2;
      const c = (i + 1) * SECTORS + j;
      const d = (i + 1) * SECTORS + j2;
      idx[o++] = a; idx[o++] = b; idx[o++] = c;
      idx[o++] = b; idx[o++] = d; idx[o++] = c;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  return geo;
}

/** 器。液面より下だけに置いて、上から覗いたときに縁が細く光る */
function buildBowl(root: THREE.Group): void {
  const metal = { color: SURFACE, roughness: 0.44, metalness: 0.7 };

  const wall = new THREE.Mesh(
    new THREE.CylinderGeometry(R * 1.015, R * 0.94, WALL_H, 96, 1, true),
    new THREE.MeshStandardMaterial({ ...metal, side: THREE.DoubleSide }),
  );
  wall.position.y = -WALL_H / 2;
  root.add(wall);

  const rim = new THREE.Mesh(
    new THREE.TorusGeometry(R * 1.015, 0.15, 10, 120),
    new THREE.MeshStandardMaterial({ ...metal, roughness: 0.42 }),
  );
  rim.rotation.x = -Math.PI / 2;
  rim.position.y = 0.02;
  root.add(rim);

  const base = new THREE.Mesh(
    new THREE.CircleGeometry(R * 0.94, 96),
    new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.5, metalness: 0.6 }),
  );
  base.rotation.x = -Math.PI / 2;
  base.position.y = -WALL_H + 0.01;
  root.add(base);

  // 器の外は鍔の幅だけに留め、つやも落としてある。広く磨いた床を敷くと
  // stage のリムライトの写り込みが器の脇に丸く浮いて、主役より光ってしまう
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(R * 1.3, 96),
    new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.78, metalness: 0.22 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -WALL_H - 0.02;
  root.add(floor);
}

export const creamSwirl: SceneModule = {
  name: 'Cream Swirl',
  desc: '注がれたミルクがゆっくり渦に巻かれ、器ぜんぶがひとつの新しい色に溶ける',
  camera: CAM,

  build(root) {
    ticks = tickers(2);
    step = 0;

    buildBowl(root);

    surface = new THREE.Mesh(
      buildDisc(),
      // つるりとさせて、うねりの斜面がハイライトの筋として出るようにする
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.17, metalness: 0.06 }),
    );
    surface.frustumCulled = false;   // 高さを書き換えるので境界球は当てにしない
    root.add(surface);
    surfPos = surface.geometry.getAttribute('position') as THREE.BufferAttribute;
    surfNor = surface.geometry.getAttribute('normal') as THREE.BufferAttribute;
    surfCol = surface.geometry.getAttribute('color') as THREE.BufferAttribute;

    // 注がれるミルクの筋
    // 落ちるほど細る。上端を原点にしてあるので scale.y だけで伸び縮みする
    const sgeo = new THREE.CylinderGeometry(STREAM_R, STREAM_R * 0.72, STREAM_H, 12, 1, true);
    sgeo.translate(0, -STREAM_H / 2, 0);
    stream = new THREE.Mesh(
      sgeo,
      new THREE.MeshStandardMaterial({
        color: emberColor(TONE_MILK, 0, 0.06),
        // わずかに自発光させる。器の外は暗いので、素のままだと液体ではなく棒に見える
        emissive: emberColor(0.88, 0, 0.1),
        emissiveIntensity: 0.32,
        roughness: 0.3,
        metalness: 0.05,
        side: THREE.DoubleSide,
      }),
    );
    stream.position.set(PX, STREAM_H, PZ);
    stream.visible = false;
    root.add(stream);
  },

  update(t) {
    const tc = (t + PHASE_DEBUG) % CYCLE;   // サイクル内の秒
    const p = tc / CYCLE;
    const tp = tc - POUR_AT;                // 着水からの秒。負なら注ぐ前
    const sh = drift(t);

    // 注ぎ → 巻き取り → 溶けきり → 沈む
    const blob = R * BLOB_R * smooth01(tp / BLOB_GROW);
    const tw = SWIRL * clamp01((tc - POUR_AT) / (CYCLE * MIX_TO - POUR_AT));
    const mix = smooth01((p - MIX_FROM) / (MIX_TO - MIX_FROM));
    // 沈みは一様に薄れるのではなく、器の縁から中心へ色が引いていく。
    // ここを一様にすると、次に注がれるまで平らな円盤を眺める時間になってしまう
    const sink = clamp01((p - SETTLE) / (1 - SETTLE)) * (1 + SINK_W);
    const soft = BLOB_SOFT + SOFT_TW * tw;
    // 乱れは巻き戻した座標で引くので、ねじれるほど頂点間で位相が飛んでギザつく。
    // 縁が十分にじむ頃には役目が終わっているので、そこまでに消しておく
    const wob = WOBBLE * (1 - clamp01(tw / (SWIRL * WOB_END)));
    const ripple = tp < 0 ? 0 : Math.min(1, tp * 2.5) * Math.exp(-tp / 5);

    // 副渦は液面をゆっくり一周する。渦がひとつだと筋が同心円に揃ってしまう
    const v2a = p * TAU;
    const v2x = Math.cos(v2a) * R * V2_POS;
    const v2z = Math.sin(v2a) * R * V2_POS;
    const v2s = 1 / (R * V2_SIG * (R * V2_SIG));
    const q1t = -RIP_W * tp;
    const w1t = tc * W1[3];
    const w2t = tc * W2[3];
    const w3t = tc * W3[3];

    ember(colA, TONE_BASE, sh);
    ember(colB, TONE_MILK, sh, 0.05);
    const dr = colB.r - colA.r;
    const dg = colB.g - colA.g;
    const db = colB.b - colA.b;

    const pos = surfPos.array as Float32Array;
    const nor = surfNor.array as Float32Array;
    const col = surfCol.array as Float32Array;

    for (let i = 0; i < vx.length; i++) {
      const x = vx[i];
      const z = vz[i];

      // --- うねりと波紋。高さと法線を式から作る ---
      const d = vdp[i];
      const q1 = RIP_K * d + q1t;
      const sq = Math.sin(q1);
      const env = ripple * Math.exp(-d * RIP_D);
      const p1 = vw1[i] + w1t;
      const p2 = vw2[i] - w2t;
      const p3 = vw3[i] + w3t;

      pos[i * 3 + 1] =
        RIP_A * env * sq + W1[2] * Math.sin(p1) + W2[2] * Math.sin(p2) + W3[2] * Math.sin(p3);
      const g = RIP_A * env * (RIP_K * Math.cos(q1) - RIP_D * sq);
      const c1 = W1[2] * Math.cos(p1);
      const c2 = W2[2] * Math.cos(p2);
      const c3 = W3[2] * Math.cos(p3);
      const gx = g * vnx[i] + W1[0] * c1 + W2[0] * c2 + W3[0] * c3;
      const gz = g * vnz[i] + W1[1] * c1 - W2[1] * c2 + W3[1] * c3;
      const inv = 1 / Math.sqrt(gx * gx + 1 + gz * gz);
      nor[i * 3] = -gx * inv;
      nor[i * 3 + 1] = inv;
      nor[i * 3 + 2] = -gz * inv;

      // --- 渦を巻き戻して、注がれた直後の配置を引き直す ---
      const dx = x - v2x;
      const dz = z - v2z;
      const a2 = -SWIRL2 * (tw / SWIRL) * Math.exp(-(dx * dx + dz * dz) * v2s);
      const ca2 = Math.cos(a2);
      const sa2 = Math.sin(a2);
      const x1 = v2x + dx * ca2 - dz * sa2;
      const z1 = v2z + dx * sa2 + dz * ca2;

      const rr = (x1 * x1 + z1 * z1) / (R * R);
      const a1 = -tw * (1 - (rr > 1 ? 1 : rr));   // 中心ほど速く、縁は器に張り付く
      const ca1 = Math.cos(a1);
      const sa1 = Math.sin(a1);
      const x0 = x1 * ca1 - z1 * sa1;
      const z0 = x1 * sa1 + z1 * ca1;

      const bx = x0 - PX;
      const bz = z0 - PZ;
      // 縁をわずかに乱してから引くと、輪郭が版画のように硬くならない
      const bd = Math.sqrt(bx * bx + bz * bz) + wob * Math.sin(bx * 1.25) * Math.sin(bz * 1.05);
      const c0 = 1 - smooth01((bd - blob + soft) / soft);
      const settle = smooth01((sink - (1 - vrn[i])) / SINK_W);
      let f = (c0 + (MILK - c0) * mix) * (1 - settle);
      f += RING_A * env * (sq > 0 ? sq : 0) * (1 - mix);   // 着水の輪を色でも見せる
      if (f > 1) f = 1;

      const e = ved[i];
      col[i * 3] = (colA.r + dr * f) * e;
      col[i * 3 + 1] = (colA.g + dg * f) * e;
      col[i * 3 + 2] = (colA.b + db * f) * e;
    }
    surfPos.needsUpdate = true;
    surfNor.needsUpdate = true;
    surfCol.needsUpdate = true;

    // 落ちてきて、注ぎ終わりに上へ引き上げられる
    const len = clamp01(tp / 0.35) - clamp01((tp - POUR_SEC + 0.7) / 0.7);
    stream.visible = len > 0.01;
    stream.scale.y = len > 0.01 ? len : 0.01;
  },

  sound(t, _dt, sfx) {
    const tc = (t + PHASE_DEBUG) % CYCLE;
    const tp = tc - POUR_AT;
    sfx.drone(tone(0), 0.05);

    // 注いでいる間だけ、細かい水音を落とす
    for (let k = ticks[0](t * 3); k > 0; k--) {
      step++;
      if (tp >= 0 && tp <= POUR_SEC) {
        sfx.drop(tone(7 + (step % 5)), { gain: 0.16, decay: 0.8, pan: Math.sin(step * 1.7) * 0.35 });
      }
    }

    // 全面が新しい単色になる瞬間に、ひと息だけ
    for (let k = ticks[1](t / CYCLE + (1 - MIX_TO)); k > 0; k--) {
      sfx.air({ gain: 0.22, decay: 2.6, freq: 460, q: 1.0, sweep: -0.35 });
    }
  },
};
