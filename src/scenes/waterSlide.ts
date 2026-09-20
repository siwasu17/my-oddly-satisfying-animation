import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, tickers } from '../audio.ts';
import { ember, emberColor, drift } from '../palette.ts';

/**
 * Water Slide。
 *
 * 空中に浮いた 3 本のらせんの樋を、水の粒が束になって滑り降りる。樋は上が開いた
 * U 字なので中の粒が隠れない。下へ行くほど速くなるので束は流れながら伸び、
 * 出口から放り出されてプールへ落ち、着水した場所から光の輪が広がって消える。
 *
 * 束は 3 本 × 3 つで 9 つあり、12 秒のループの中を 1.3 秒おきに順ぐりに落ちていく。
 * 粒の位置はすべて経過秒から作り直しているので、いつ開いても同じ流れになる。
 */

/* ── 調整する数値 ───────────────────────────────────────── */

/** 粒が入口から着水するまで（秒）。ループの周期そのもの */
const PERIOD = 12;
/** コースの入口の高さ */
const TOP = 13.4;
/** 樋の出口の高さ */
const EXIT_Y = 2.4;
/** 水面の高さ */
const WATER_Y = 0;
/** プールの半径。大きくしすぎると画面下半分が平面に食われる */
const POOL_R = 9.5;
/** 樋の太さ（U 字の半径） */
const TUBE_R = 0.75;
/** 樋の断面の半角（ラジアン）。π で全周、小さいほど浅い皿になる */
const TROUGH_OPEN = 2;
/** 水の粒の基準の大きさ */
const DROP_R = 0.3;
/** 1 本あたりの粒の数 */
const PER_LANE = 60;
/** 1 本あたりの束の数 */
const CLUSTERS = 3;
/** 束の広がり（ループ位相）。小さいほど固まって流れる */
const CLUSTER_SPREAD = 0.075;
/** 樋を出る進み具合（0..1）。ここから先は落下 */
const S_EXIT = 0.84;
/** 樋の中での加速。1 より大きいほど下で速くなる */
const GLIDE_EASE = 1.4;
/** 出口から水平に飛び出す距離 */
const FALL_SPREAD = 1.8;
/** 落下のどこから粒が溶け始めるか（0..1） */
const FADE_AT = 0.84;
/** 波紋が広がりきるまでのループ位相。長いほど同時に見える輪が増える */
const RING_LIFE = 0.22;
/** 波紋の最大半径 */
const RING_R = 3.6;
/** 全体がゆっくり回る速さ（ラジアン／秒） */
const SPIN = 0.016;
/** 樋の長さ方向・断面方向の分割数 */
const TROUGH_SEG = 200;
const TROUGH_ARC = 12;

/** らせん 1 本。半径は下へ行くほど縮み、内側の本ほど多く巻く */
interface Lane {
  r0: number;
  r1: number;
  turns: number;
  phase: number;
}
const LANES: Lane[] = [
  { r0: 8.9, r1: 6.4, turns: 1.4, phase: 0.0 },
  { r0: 6.4, r1: 4.3, turns: 1.8, phase: 2.2 },
  { r0: 4.1, r1: 2.3, turns: 2.25, phase: 4.3 },
];

const TAU = Math.PI * 2;
const TOTAL = LANES.length * PER_LANE;
const RINGS = LANES.length * CLUSTERS;

const frac = (x: number): number => x - Math.floor(x);

const dummy = new THREE.Object3D();
const color = new THREE.Color();

/** 粒ごとの [レーン番号, ループ位相のずれ, 樋の中の横ずれ, 上下ずれ, 大きさ] */
const drops = new Float32Array(TOTAL * 5);
/** 束ごとのループ位相のずれ。波紋と着水音もこれに乗る */
const clusterOff = new Float32Array(RINGS);
/** 束ごとの着水地点 [x, z] */
const splash = new Float32Array(RINGS * 2);

let pivot: THREE.Group;
let dropMesh: THREE.InstancedMesh;
let ringMesh: THREE.InstancedMesh;

let ticks = tickers(RINGS);
let step = 0;

/** らせんの u（0..1）の位置。樋のジオメトリと粒で同じ式を使う */
function lanePoint(lane: Lane, u: number, out: THREE.Vector3): THREE.Vector3 {
  const a = lane.phase + u * lane.turns * TAU;
  const r = lane.r0 + (lane.r1 - lane.r0) * u;
  return out.set(Math.cos(a) * r, TOP + (EXIT_Y - TOP) * u, Math.sin(a) * r);
}

/**
 * らせんに沿って、上が開いた U 字の樋を張る。
 * 断面の「上」は常にワールドの上。管にすると中の粒が見えなくなるので使わない。
 */
function troughGeometry(lane: Lane): THREE.BufferGeometry {
  const cols = TROUGH_ARC + 1;
  const pos = new Float32Array((TROUGH_SEG + 1) * cols * 3);
  const idx: number[] = [];
  const p = new THREE.Vector3();
  const ahead = new THREE.Vector3();
  const tan = new THREE.Vector3();
  const side = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const du = 1 / TROUGH_SEG;

  let o = 0;
  for (let i = 0; i <= TROUGH_SEG; i++) {
    const u = i * du;
    lanePoint(lane, u, p);
    // 進行方向。端では手前の点との差で代用する
    if (u < 1 - du) {
      lanePoint(lane, u + du, ahead);
      tan.subVectors(ahead, p);
    } else {
      lanePoint(lane, u - du, ahead);
      tan.subVectors(p, ahead);
    }
    tan.normalize();
    side.crossVectors(tan, up).normalize(); // 水平方向の横。up との外積なので必ず水平

    for (let j = 0; j < cols; j++) {
      const a = -TROUGH_OPEN + (2 * TROUGH_OPEN * j) / TROUGH_ARC;
      const s = Math.sin(a) * TUBE_R;
      pos[o++] = p.x + side.x * s;
      pos[o++] = p.y - Math.cos(a) * TUBE_R;
      pos[o++] = p.z + side.z * s;
    }
  }
  for (let i = 0; i < TROUGH_SEG; i++) {
    for (let j = 0; j < TROUGH_ARC; j++) {
      const a = i * cols + j;
      const b = a + cols;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

export const waterSlide: SceneModule = {
  name: 'Water Slide',
  desc: 'らせんの樋を水の粒が束で滑り落ち、プールへ着水して輪が広がる。',
  camera: { pos: [0, 12.6, 26], target: [0, 4.8, 0] },

  build(root) {
    ticks = tickers(RINGS);
    step = 0;

    let seed = 0.731;
    const rnd = (): number => (seed = (seed * 9301 + 0.49297) % 1);

    pivot = new THREE.Group();
    root.add(pivot);

    // 樋。手前の巻きが奥を隠さないよう薄く、depthWrite も切っておく
    const troughMat = new THREE.MeshStandardMaterial({
      color: emberColor(0.28),
      roughness: 0.5,
      metalness: 0.35,
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    for (const lane of LANES) {
      pivot.add(new THREE.Mesh(troughGeometry(lane), troughMat));
    }

    // 束は 9 つ。レーンをまたいで順ぐりに落ちるよう、位相を均等に配る
    for (let lane = 0; lane < LANES.length; lane++) {
      for (let c = 0; c < CLUSTERS; c++) {
        const i = lane * CLUSTERS + c;
        clusterOff[i] = frac(c / CLUSTERS + lane / RINGS);
      }
    }

    // 粒を束へ割り当てる。束の中では位相を等間隔に置き、わずかだけ乱数で崩す
    const perCluster = PER_LANE / CLUSTERS;
    for (let lane = 0; lane < LANES.length; lane++) {
      for (let k = 0; k < PER_LANE; k++) {
        const i = lane * PER_LANE + k;
        const c = Math.min(CLUSTERS - 1, Math.floor(k / perCluster));
        const inner = (k - c * perCluster) / perCluster - 0.5;
        const b = i * 5;
        drops[b] = lane;
        drops[b + 1] = frac(
          clusterOff[lane * CLUSTERS + c] + (inner + (rnd() - 0.5) * 0.35) * CLUSTER_SPREAD,
        );
        drops[b + 2] = rnd() * 2 - 1;
        drops[b + 3] = rnd();
        drops[b + 4] = DROP_R * (0.74 + rnd() * 0.56);
      }
    }

    dropMesh = new THREE.InstancedMesh(
      new THREE.SphereGeometry(1, 10, 8),
      new THREE.MeshStandardMaterial({ roughness: 0.16, metalness: 0.1 }),
      TOTAL,
    );
    dropMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    pivot.add(dropMesh);

    // 着水地点。落下区間の式に q = 1 を入れたもの
    const p = new THREE.Vector3();
    for (let i = 0; i < RINGS; i++) {
      const lane = LANES[Math.floor(i / CLUSTERS)];
      lanePoint(lane, 1, p);
      const a = lane.phase + lane.turns * TAU;
      splash[i * 2] = p.x - Math.sin(a) * FALL_SPREAD;
      splash[i * 2 + 1] = p.z + Math.cos(a) * FALL_SPREAD;
    }

    const ringGeo = new THREE.RingGeometry(0.9, 1, 56);
    ringGeo.rotateX(-Math.PI / 2);
    ringMesh = new THREE.InstancedMesh(
      ringGeo,
      new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0.6,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
      RINGS,
    );
    ringMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    pivot.add(ringMesh);

    // 水面。明るい金属面にすると光源が丸い塊になって映り込むので、色を深く沈めたうえで
    // 弱い反射だけを残す。完全なマット面にすると今度は板に見える
    const pool = new THREE.Mesh(
      new THREE.CircleGeometry(POOL_R, 96),
      new THREE.MeshStandardMaterial({ color: emberColor(0.09), roughness: 0.22, metalness: 0.55 }),
    );
    pool.rotation.x = -Math.PI / 2;
    pool.position.y = WATER_Y - 0.02;
    root.add(pool);
  },

  update(t, dt) {
    pivot.rotation.y += dt * SPIN;

    const hue = drift(t);
    const base = t / PERIOD;

    for (let i = 0; i < TOTAL; i++) {
      const b = i * 5;
      const lane = LANES[drops[b]];
      const s = frac(base + drops[b + 1]);
      const jr = drops[b + 2];
      const jy = drops[b + 3];
      let scale = drops[b + 4];
      let n: number;

      if (s < S_EXIT) {
        // 樋の中。u は下へ行くほど速く進むので、束は流れながら伸びる
        const u = Math.pow(s / S_EXIT, GLIDE_EASE);
        const a = lane.phase + u * lane.turns * TAU;
        // 速いほど外側の壁へ寄る
        const r = lane.r0 + (lane.r1 - lane.r0) * u + jr * TUBE_R * 0.44 + u * u * 0.24;
        dummy.position.set(
          Math.cos(a) * r,
          TOP + (EXIT_Y - TOP) * u - TUBE_R * 0.42 + jy * TUBE_R * 0.34,
          Math.sin(a) * r,
        );
        n = 0.46 + 0.24 * u;
      } else {
        // 出口から水平に放り出され、加速しながら水面へ落ちる
        const q = (s - S_EXIT) / (1 - S_EXIT);
        const a = lane.phase + lane.turns * TAU;
        const r = lane.r1 + jr * TUBE_R * 0.44;
        const fly = q * FALL_SPREAD;
        dummy.position.set(
          Math.cos(a) * r - Math.sin(a) * fly,
          EXIT_Y + (WATER_Y - EXIT_Y) * q * q,
          Math.sin(a) * r + Math.cos(a) * fly,
        );
        n = 0.7 + 0.22 * q;
        if (q > FADE_AT) scale *= Math.max(0, (1 - q) / (1 - FADE_AT));
      }

      dummy.scale.setScalar(scale);
      dummy.updateMatrix();
      dropMesh.setMatrixAt(i, dummy.matrix);
      ember(color, n, hue, 0.1);
      dropMesh.setColorAt(i, color);
    }
    dropMesh.instanceMatrix.needsUpdate = true;
    if (dropMesh.instanceColor) dropMesh.instanceColor.needsUpdate = true;

    // 波紋。束の位相が 0 に戻った瞬間＝その束が着水した瞬間
    for (let i = 0; i < RINGS; i++) {
      const age = frac(base + clusterOff[i]);
      const k = age / RING_LIFE;
      const live = k < 1;
      dummy.position.set(splash[i * 2], WATER_Y + 0.03, splash[i * 2 + 1]);
      dummy.scale.setScalar(live ? 1 + k * RING_R : 0);
      dummy.updateMatrix();
      ringMesh.setMatrixAt(i, dummy.matrix);
      const fade = live ? (1 - k) * (1 - k) : 0;
      ember(color, 0.58, hue).multiplyScalar(fade);
      ringMesh.setColorAt(i, color);
    }
    ringMesh.instanceMatrix.needsUpdate = true;
    if (ringMesh.instanceColor) ringMesh.instanceColor.needsUpdate = true;
  },

  sound(t, _dt, sfx) {
    // 落ち続ける水の底鳴り
    sfx.drone(tone(-7), 0.05);

    const base = t / PERIOD;
    for (let i = 0; i < RINGS; i++) {
      for (let k = ticks[i](base + clusterOff[i]); k > 0; k--) {
        step++;
        const lane = Math.floor(i / CLUSTERS);
        sfx.drop(tone(4 + lane * 2 + (step % 3)), {
          gain: 0.34,
          decay: 0.8,
          bend: 0.62,
          pan: Math.sin(i * 2.3) * 0.5,
        });
      }
    }
  },
};
