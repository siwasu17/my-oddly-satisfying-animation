import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, tickers } from '../audio.ts';
import { SURFACE, ember, emberColor, drift } from '../palette.ts';

/**
 * エスプレッソの面に、ラテアートのリーフが一枚描き上がるまで。
 * まず中心へ落として下地を作り、そこから注ぎ口を向こう側へ移して、
 * 左右に振りながら手前へ引いてくる。振りの折り返しごとに白い弧が 1 枚ずつ置かれ、
 * あとから来たミルクに押されて奥へ詰みながら羽の列になる。最後に細い筋を
 * 手前から奥へ通すと、列が中心で断ち切られて軸が生まれ、リーフになる。
 * しばらく保ったあと、縁の側から色が引いてまたクレマ一色へ戻る。
 * 液面は極座標グリッドの円盤 1 枚。白い形は「置かれた弧の集まり」を毎フレーム
 * t から引き直しているだけで、うねりと波紋だけが高さと法線を持つ。
 * ループ 36 秒 / 俯瞰 / 注ぐ水音と、弧が置かれるたびに左右へ振れる粒。
 */

// ---- 調整する数値 ----------------------------------------------------------
const R = 9;              // 液面の半径
const RINGS = 72;         // 液面の半径方向の分割数
const SECTORS = 256;      // 液面の円周方向の分割数。弧の輪郭はここで解像する
const CYCLE = 36;         // 1 周の秒数
// 進行（秒）。注ぐ → 下地 → 振りながら引く → 軸を通す → 保つ → 沈む
const POUR_AT = 0.4;      // ミルクが着水する時刻
const BASE_TO = 6.4;      // 下地を注ぎ終える時刻
const WIG_FROM = 7.0;     // 振りはじめ
const WIG_TO = 22.4;      // 振り終わり
const STEM_FROM = 23.2;   // 軸を通しはじめる
const STEM_TO = 26.4;     // 通し終えて注ぎ止め
const SETTLE_AT = 30.6;   // ここから元の色へ沈む
const SINK_W = 0.42;      // 沈みの front の幅（R 比）。縁から中心へ色が引いていく

const NRIB = 11;          // 置かれる弧の枚数 = 振りの折り返しの回数
const Z0 = -R * 0.4;     // 振りはじめの注ぎ口（奥）
const Z1 = R * 0.62;       // 振り終わりの注ぎ口（手前）= リーフの下の先端
const ZFAR = -R * 0.8;   // 軸を抜く先（奥の縁）
const OSC = 0.62;         // 左右の振り幅。弧の中心がこれだけ交互にずれる
const WMIN = 1.9;         // 弧の羽の長さ（最初と最後）
const WMAX = 6.2;         // 弧の羽の長さ（いちばん張るところ）
const CURV = 0.062;       // 弧の反り。羽の先ほど奥へ流れる
const STEM_CURL = 0.45;   // 軸を通すときに羽が引かれて反りが増す量
const PUSH = 1.5;         // 置いた弧が後続に押されて奥へ詰む距離
const RIB_TH = 0.32;      // 弧の太さ（中央）
const RIB_TIP = 0.38;     // 羽の先が尖りはじめる位置（羽の長さ比）
const RIB_SOFT = 0.38;    // 弧の縁のやわらかさ。格子の目より広く取らないと輪郭がぎざつく
const RIB_IN = 0.045;     // 弧が置かれきるまでの時間（振り全体に対する比）
const BLUR = 1.1;         // 描き上がってからにじむ量
const STEM_W = 0.3;       // 軸の太さ
const STEM_SOFT = 0.32;   // 軸の縁のやわらかさ
const BASE_R = 0.52;      // 下地の広がり（R 比）
const BASE_F = 0.3;       // 下地の白さ。クレマがわずかに明るくなる程度
const BASE_SOFT = 2.0;    // 下地の縁のやわらかさ（ワールド）
const POOL_R = 0.85;      // 着水点にできる白い溜まり
const POOL_SOFT = 0.6;
const TONE_CREMA = 0.17;  // エスプレッソのクレマ
const TONE_MILK = 0.97;   // ミルク
const EDGE_DARK = 0.4;    // カップに接するところを落とす量
const RIP_A = 0.16;       // 着水の波紋の高さ
const RIP_K = 1.9;        // 波紋の細かさ
const RIP_W = 4.2;        // 波紋が広がる速さ
const RIP_D = 0.26;       // 波紋の減衰
const RING_A = 0.4;       // 着水の輪を色でも見せる量
// うねり 3 本 [kx, kz, 振幅, 角速度]。振幅 × 波数が斜面になるので、ここが液面らしさの正体。
// 角速度は 1 周でちょうど整数回になるよう選んであり、ループの継ぎ目ができない
const W1 = [0.75, 0.42, 0.13, (Math.PI * 2 * 3) / CYCLE];
const W2 = [-0.31, 0.68, 0.11, (Math.PI * 2 * 4) / CYCLE];
const W3 = [1.6, -1.1, 0.055, (Math.PI * 2 * 7) / CYCLE];
const STREAM_R = 0.3;     // ミルクの筋の太さ
const STREAM_H = 7;       // ミルクの筋の長さ。実際の長さは注ぎ口の高さで決まる
const POUR_HI = 6.3;      // 下地を注ぐ高さ
const POUR_LO = 2.8;      // 振っている間の高さ。ピッチャーを液面すれすれまで落とす
const POUR_MID = 3.4;     // 軸を通すときの高さ
const WALL_H = 1.7;       // カップの深さ
const CAM = { pos: [0, 19, 9] as [number, number, number], target: [0, 0, 0] as [number, number, number] };

const PHASE_DEBUG = 0;    // 検証で後半の位相を撮るときだけ動かす。通常は 0
const TAU = Math.PI * 2;

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

/** 液面の頂点ごとの値。うねりも波紋の中心も動かないので、空間項は build で持っておく */
let vx = new Float32Array(0);
let vz = new Float32Array(0);
let vd = new Float32Array(0);    // 中心からの距離
let vw1 = new Float32Array(0);   // うねり 3 本の空間位相
let vw2 = new Float32Array(0);
let vw3 = new Float32Array(0);
let ved = new Float32Array(0);   // 縁の落とし込み
let vrn = new Float32Array(0);   // 正規化半径。沈みの front はこれで引く

/**
 * 弧 1 枚ぶんの値。u（振りの進み）で置かれ、あとは押されて奥へ動くだけなので、
 * 置かれる場所・左右のずれ・羽の長さは動かない。毎フレーム変わるのは下の 5 本。
 */
const rU = new Float32Array(NRIB);    // 置かれる u
const rCzb = new Float32Array(NRIB);  // 置かれたときの z
const rOx = new Float32Array(NRIB);   // 左右のずれ
const rWb = new Float32Array(NRIB);   // 羽の長さ
const rCz = new Float32Array(NRIB);
const rW = new Float32Array(NRIB);
const rTh = new Float32Array(NRIB);
const rZl = new Float32Array(NRIB);   // この弧が届く z の範囲。頂点ごとの足切りに使う
const rZh = new Float32Array(NRIB);

for (let i = 0; i < NRIB; i++) {
  const q = (i + 0.5) / NRIB;
  rU[i] = q;
  rCzb[i] = Z0 + (Z1 - Z0) * q;
  rOx[i] = OSC * (i % 2 === 0 ? 1 : -1);
  // 羽は序盤から中盤にかけていちばん張り、先端へ向かって短くなる
  rWb[i] = WMIN + (WMAX - WMIN) * Math.pow(Math.sin(Math.PI * Math.pow(q, 0.72)), 0.8);
}

let ticks = tickers(3);
let step = 0;
let rib = 0;

/** 極座標グリッドの円盤。位置・法線・色を毎フレーム書き換える */
function buildDisc(): THREE.BufferGeometry {
  const v = (RINGS + 1) * SECTORS;
  const pos = new Float32Array(v * 3);
  const nor = new Float32Array(v * 3);
  const col = new Float32Array(v * 3);
  vx = new Float32Array(v);
  vz = new Float32Array(v);
  vd = new Float32Array(v);
  vw1 = new Float32Array(v);
  vw2 = new Float32Array(v);
  vw3 = new Float32Array(v);
  ved = new Float32Array(v);
  vrn = new Float32Array(v);

  for (let i = 0; i <= RINGS; i++) {
    // 羽はカップの外周まで届くので、半径方向は等間隔に取る
    const rn = i / RINGS;
    const r = rn * R;
    for (let j = 0; j < SECTORS; j++) {
      const k = i * SECTORS + j;
      const th = (j / SECTORS) * TAU;
      const x = Math.cos(th) * r;
      const z = Math.sin(th) * r;
      vx[k] = x;
      vz[k] = z;
      vd[k] = r + 1e-4;
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

/** カップ。液面より下だけに置いて、上から覗いたときに縁が細く光る */
function buildCup(root: THREE.Group): void {
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

  // カップの外は受け皿の幅だけに留め、つやも落としてある。広く磨いた床を敷くと
  // stage のリムライトの写り込みが脇に丸く浮いて、主役より光ってしまう
  const saucer = new THREE.Mesh(
    new THREE.CircleGeometry(R * 1.3, 96),
    new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.78, metalness: 0.22 }),
  );
  saucer.rotation.x = -Math.PI / 2;
  saucer.position.y = -WALL_H - 0.02;
  root.add(saucer);
}

export const latteLeaf: SceneModule = {
  name: 'Latte Leaf',
  desc: 'ミルクを振りながら引いて、エスプレッソの上にリーフが一枚描き上がる',
  camera: CAM,

  build(root) {
    ticks = tickers(3);
    step = 0;
    rib = 0;

    buildCup(root);

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
        // わずかに自発光させる。カップの外は暗いので、素のままだと液体ではなく棒に見える
        emissive: emberColor(0.88, 0, 0.1),
        emissiveIntensity: 0.32,
        roughness: 0.3,
        metalness: 0.05,
        side: THREE.DoubleSide,
      }),
    );
    stream.visible = false;
    root.add(stream);
  },

  update(t) {
    const tc = (t + PHASE_DEBUG) % CYCLE;   // サイクル内の秒
    const tp = tc - POUR_AT;                // 着水からの秒。負なら注ぐ前
    const sh = drift(t);

    const u = clamp01((tc - WIG_FROM) / (WIG_TO - WIG_FROM));   // 振りの進み
    const s = clamp01((tc - STEM_FROM) / (STEM_TO - STEM_FROM));// 軸の進み
    const hold = clamp01((tc - STEM_TO) / (SETTLE_AT - STEM_TO));
    const sink = clamp01((tc - SETTLE_AT) / (CYCLE - SETTLE_AT)) * (1 + SINK_W);
    const ripple = tp < 0 ? 0 : Math.min(1, tp * 2.5) * Math.exp(-tp / 4);

    // 注ぎ口。中心 → 奥へ移動 → 振りながら手前へ → 軸を引いて奥へ抜ける
    let px = 0;
    let pz = 0;
    if (tc >= WIG_FROM) {
      px = OSC * Math.sin(Math.PI * NRIB * u);   // 折り返しがちょうど弧の枚数になる
      pz = Z0 + (Z1 - Z0) * u;
    } else if (tc > BASE_TO) {
      pz = Z0 * smooth01((tc - BASE_TO) / (WIG_FROM - BASE_TO));
    }
    if (s > 0) {
      px = 0;
      pz = Z1 + (ZFAR - Z1) * s;
    }

    // 描き上がってからは縁がにじみ、軸を通す間は羽が引かれて反りが増す
    const soft = RIB_SOFT * (1 + BLUR * hold);
    const curv = CURV * (1 + STEM_CURL * s);

    for (let k = 0; k < NRIB; k++) {
      const age = u - rU[k];
      if (age <= 0) {
        rW[k] = 0;
        continue;
      }
      const g = smooth01(age / RIB_IN);
      rW[k] = rWb[k] * (0.55 + 0.45 * g);
      rCz[k] = rCzb[k] - PUSH * age;   // あとから来たミルクに押されて奥へ詰む
      rTh[k] = RIB_TH * g;
      rZh[k] = rCz[k] + rTh[k] + soft;
      rZl[k] = rCz[k] - curv * rW[k] * rW[k] - rTh[k] - soft;
    }

    const baseR = R * BASE_R * smooth01(tp / 4.2);
    const pool = tp < 0 || tc > STEM_TO ? 0 : POOL_R * (s > 0 ? 0.45 : 1);

    ember(colA, TONE_CREMA, sh);
    ember(colB, TONE_MILK, sh, 0.05);
    const dr = colB.r - colA.r;
    const dg = colB.g - colA.g;
    const db = colB.b - colA.b;

    const pos = surfPos.array as Float32Array;
    const nor = surfNor.array as Float32Array;
    const col = surfCol.array as Float32Array;

    const q1t = -RIP_W * tp;
    const w1t = tc * W1[3];
    const w2t = tc * W2[3];
    const w3t = tc * W3[3];

    for (let i = 0; i < vx.length; i++) {
      const x = vx[i];
      const z = vz[i];

      // --- うねりと波紋。高さと法線を式から作る ---
      const d = vd[i];
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
      const gx = g * (x / d) + W1[0] * c1 + W2[0] * c2 + W3[0] * c3;
      const gz = g * (z / d) + W1[1] * c1 - W2[1] * c2 + W3[1] * c3;
      const inv = 1 / Math.sqrt(gx * gx + 1 + gz * gz);
      nor[i * 3] = -gx * inv;
      nor[i * 3 + 1] = inv;
      nor[i * 3 + 2] = -gz * inv;

      // --- 白の濃さ。下地・着水の溜まり・弧の列・軸のいちばん濃いものを採る ---
      let f = BASE_F * (1 - smooth01((d - baseR) / BASE_SOFT));

      if (pool > 0) {
        const ax = x - px;
        const az = z - pz;
        const pv = 1 - smooth01((Math.sqrt(ax * ax + az * az) - pool) / POOL_SOFT);
        if (pv > f) f = pv;
      }

      for (let k = 0; k < NRIB; k++) {
        const w = rW[k];
        if (w <= 0 || z > rZh[k] || z < rZl[k]) continue;
        const dx = x - rOx[k];
        const adx = dx < 0 ? -dx : dx;
        if (adx >= w) continue;
        const dz = z - (rCz[k] - curv * dx * dx);   // 弧は奥へ反った放物線
        // 太さは途中まで保って、先だけ尖らせる。均等に細らせると羽が櫛の歯に見える
        const e = smooth01((1 - adx / w) / RIB_TIP);
        const dd = (dz < 0 ? -dz : dz) - rTh[k] * e;
        if (dd >= soft) continue;
        const v = 1 - smooth01(dd / soft);
        if (v > f) f = v;
      }

      if (s > 0) {
        // 軸は通した先ほど細く、抜ける手前で尖って終わる
        const sw = STEM_W * smooth01((z - pz) / 1.5);
        const sv =
          (1 - smooth01((Math.abs(x) - sw) / STEM_SOFT)) * (1 - smooth01((z - Z1) / 0.5));
        if (sv > f) f = sv;
      }

      f += RING_A * env * (sq > 0 ? sq : 0) * (1 - u);   // 着水の輪を色でも見せる
      if (f > 1) f = 1;
      f *= 1 - smooth01((sink - (1 - vrn[i])) / SINK_W);

      const ed = ved[i];
      col[i * 3] = (colA.r + dr * f) * ed;
      col[i * 3 + 1] = (colA.g + dg * f) * ed;
      col[i * 3 + 2] = (colA.b + db * f) * ed;
    }
    surfPos.needsUpdate = true;
    surfNor.needsUpdate = true;
    surfCol.needsUpdate = true;

    // 筋は注ぎ口を追う。下地は高いところから太く、振る間は液面すれすれまで下ろし、
    // 軸を通すときは細く落とす。高さを position.y に入れて、先端は常に液面で止める
    const hi =
      POUR_HI +
      (POUR_LO - POUR_HI) * smooth01((tc - BASE_TO) / 0.6) +
      (POUR_MID - POUR_LO) * smooth01((tc - WIG_TO) / 0.8);
    const len = clamp01(tp / 0.35) - clamp01((tc - STEM_TO) / 0.5);
    stream.visible = len > 0.01;
    stream.position.set(px, hi, pz);
    stream.scale.y = (hi / STREAM_H) * (len > 0.01 ? len : 0.01);
    const thin = 1 - 0.2 * smooth01((tc - BASE_TO) / 0.6) - 0.45 * smooth01((tc - WIG_TO) / 0.8);
    stream.scale.x = thin;
    stream.scale.z = thin;
  },

  sound(t, _dt, sfx) {
    const tt = t + PHASE_DEBUG;
    const tc = tt % CYCLE;
    sfx.drone(tone(0), 0.05);

    // 下地を注いでいる間の細かい水音
    for (let k = ticks[0](t * 3); k > 0; k--) {
      step++;
      if (tc >= POUR_AT && tc <= BASE_TO) {
        sfx.drop(tone(7 + (step % 5)), { gain: 0.15, decay: 0.8, pan: Math.sin(step * 1.7) * 0.3 });
      }
    }

    // 弧が 1 枚置かれるたび。振りに合わせて左右へ振れる
    const u = clamp01((tc - WIG_FROM) / (WIG_TO - WIG_FROM));
    for (let k = ticks[1](Math.floor(tt / CYCLE) * NRIB + u * NRIB + 0.5); k > 0; k--) {
      rib++;
      sfx.pluck(tone(3 + (rib % 4)), { gain: 0.13, decay: 1.1, pan: rib % 2 ? -0.42 : 0.42 });
    }

    // 軸を通し終えた瞬間にひと息
    for (let k = ticks[2](tt / CYCLE + (1 - STEM_TO / CYCLE)); k > 0; k--) {
      sfx.air({ gain: 0.2, decay: 2.4, freq: 430, q: 1.0, sweep: -0.3 });
    }
  },
};
