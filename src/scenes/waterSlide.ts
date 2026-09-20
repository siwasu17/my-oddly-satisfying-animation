import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, tickers } from '../audio.ts';
import { ember, emberColor, drift } from '../palette.ts';

/**
 * Water Slide。
 *
 * 空中に浮いた 3 本のらせんの樋を、アヒルのおもちゃが列になって滑り降りる。樋は上が
 * 開いた U 字なので、中の一匹ずつが隠れない。下へ行くほど速くなるので列は流れながら
 * 伸び、出口から放り出されてプールへ落ち、水面をくぐって消える。落ちた場所からは
 * 輪が広がる。
 *
 * アヒルは球と円錐だけで組んだ最小限のシルエット（体・頭・くちばし・尾）で、
 * 滑っている間は進行方向を向きながら左右にゆれる。
 *
 * 列は 3 本 × 3 つで 9 つあり、12 秒のループの中を 1.3 秒おきに順ぐりに落ちていく。
 * 位置はすべて経過秒から作り直しているので、いつ開いても同じ流れになる。
 */

/* ── 調整する数値 ───────────────────────────────────────── */

/** アヒルが入口から着水するまで（秒）。ループの周期そのもの */
const PERIOD = 12;
/** コースの入口の高さ */
const TOP = 13.4;
/** 樋の出口の高さ */
const EXIT_Y = 2.4;
/** 水面の高さ */
const WATER_Y = 0;
/** 着水後どれだけ沈むか。水面をくぐって隠れる深さ */
const SINK = 2.2;
/** プールの半径。大きくしすぎると画面下半分が平面に食われる */
const POOL_R = 9.5;
/** 樋の太さ（U 字の半径）。アヒルの幅より広く取る */
const TUBE_R = 0.88;
/** 樋の断面の半角（ラジアン）。π で全周、小さいほど浅い皿になる */
const TROUGH_OPEN = 2;
/**
 * アヒルの大きさ。小さくしすぎるとシルエットが解像せず、ただの塊に見える。
 * 0.62 まで落とすとくちばしが数ピクセルに潰れて鳥に見えなくなった。
 */
const DUCK_R = 0.72;
/** 1 本あたりのアヒルの数。大きくしたぶん数は絞る */
const PER_LANE = 6;
/** 1 本あたりの列の数 */
const CLUSTERS = 2;
/** 列の広がり（ループ位相）。狭くしすぎると出口のあたりで詰まって重なる */
const CLUSTER_SPREAD = 0.24;
/** 樋を出る進み具合（0..1）。ここから先は落下 */
const S_EXIT = 0.78;
/**
 * 落下のどこで水面を切るか（0..1）。残りが沈んでいく区間になる。
 * 短くすると沈む時間が伸び、水面と交差したアヒルが常に画面にいるようになる。
 */
const SPLASH_Q = 0.35;
/** 樋の中での加速。1 より大きいほど下で速くなる。低いと出口で列が詰まる */
const GLIDE_EASE = 1.7;
/** 出口から水平に飛び出す距離 */
const FALL_SPREAD = 1.8;
/** 滑っている間の横ゆれの深さ */
const WOBBLE = 0.17;
/** 波紋が広がりきるまでのループ位相。沈んでいく時間と揃えないと輪だけが残る */
const RING_LIFE = 0.14;
/** 波紋の最大半径 */
const RING_R = 3.6;
/** 1 回の着水で出す輪の本数 */
const RING_WAVES = 3;
/** 輪と輪の間隔（ループ位相） */
const RING_GAP = 0.02;
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
  { r0: 8.9, r1: 6.6, turns: 1.4, phase: 0.0 },
  { r0: 6.4, r1: 4.3, turns: 1.8, phase: 2.2 },
  { r0: 4.1, r1: 2.0, turns: 2.25, phase: 4.3 },
];

const TAU = Math.PI * 2;
const TOTAL = LANES.length * PER_LANE;
const RINGS = LANES.length * CLUSTERS;

/** 樋の中でアヒルが座る高さ。樋の底に浮かせる */
const RIDE_Y = DUCK_R * 0.8 - TUBE_R;
/** 着水するループ位相。1 との差だけ波紋と音を前倒しする */
const SPLASH_LEAD = 1 - (S_EXIT + SPLASH_Q * (1 - S_EXIT));

const frac = (x: number): number => x - Math.floor(x);

const dummy = new THREE.Object3D();
dummy.rotation.order = 'YXZ'; // 進行方向を向けてから、その軸まわりに傾ける
const color = new THREE.Color();

/** アヒルごとの [レーン番号, ループ位相のずれ, 樋の中の横ずれ, ゆれの位相, 大きさ] */
const ducks = new Float32Array(TOTAL * 5);
/** 列ごとのループ位相のずれ。波紋と着水音もこれに乗る */
const clusterOff = new Float32Array(RINGS);
/** 列ごとの着水地点 [x, z] */
const splash = new Float32Array(RINGS * 2);

let pivot: THREE.Group;
/** 体・頭・くちばし・尾。4 つとも同じ姿勢行列を共有する */
let parts: THREE.InstancedMesh[] = [];
let duckMat: THREE.MeshStandardMaterial;
let beakMat: THREE.MeshStandardMaterial;
let ringMesh: THREE.InstancedMesh;

let ticks = tickers(RINGS);
let step = 0;

/** らせんの u（0..1）の位置。樋のジオメトリとアヒルで同じ式を使う */
function lanePoint(lane: Lane, u: number, out: THREE.Vector3): THREE.Vector3 {
  const a = lane.phase + u * lane.turns * TAU;
  const r = lane.r0 + (lane.r1 - lane.r0) * u;
  return out.set(Math.cos(a) * r, TOP + (EXIT_Y - TOP) * u, Math.sin(a) * r);
}

/**
 * らせんに沿って、上が開いた U 字の樋を張る。
 * 断面の「上」は常にワールドの上。管にすると中のアヒルが見えなくなるので使わない。
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

/**
 * ラバーダック。体を原点、くちばしを +Z に置いた 4 つの部品で、それぞれの位置と向きを
 * ジオメトリに焼いておく。こうすると 4 つの InstancedMesh が同じ姿勢行列を使い回せる。
 * 大きな頭・短く平たいくちばし・小さな尾がゴム製アヒルの決め手で、
 * 首を伸ばしたり嘴を尖らせたりすると途端に小鳥になる。目は付けない
 * （この大きさでは点にしかならず、作り込むと実在感が出て気持ち悪くなる）。
 */
function duckParts(): THREE.BufferGeometry[] {
  // ぽってりと丸い胴。前後に伸ばさず、玉に近い比率にする
  const body = new THREE.SphereGeometry(1, 12, 10);
  body.scale(0.98, 0.9, 1.06);

  // ラバーダックは頭が大きく、首はほとんど無い。胴に食い込むくらい近づける
  const head = new THREE.SphereGeometry(0.66, 12, 9);
  head.translate(0, 0.72, 0.32);

  // くちばしは尖らせず平たい幅広に。ただし輪郭から前へ張り出させないと、
  // この大きさでは頭に埋もれて鳥に見えなくなる
  const beak = new THREE.SphereGeometry(0.3, 8, 6);
  beak.scale(0.96, 0.38, 1.55);
  beak.translate(0, 0.58, 1.08);

  // 尾は小さいが、輪郭を切り欠く程度には後ろ上へ跳ね上げる
  const tail = new THREE.ConeGeometry(0.26, 0.5, 4);
  tail.rotateX(-1.2);
  tail.translate(0, 0.48, -0.96);

  return [body, head, beak, tail];
}

export const waterSlide: SceneModule = {
  name: 'Water Slide',
  desc: 'らせんの樋をアヒルのおもちゃが列で滑り落ち、プールへ次々に沈んでいく。',
  camera: { pos: [0, 12.6, 26], target: [0, 4.8, 0] },

  build(root) {
    ticks = tickers(RINGS);
    step = 0;

    let seed = 0.731;
    const rnd = (): number => (seed = (seed * 9301 + 0.49297) % 1);

    pivot = new THREE.Group();
    root.add(pivot);

    // 樋。手前の巻きが奥を隠さないよう薄く、depthWrite も切っておく。
    // アヒルと明るさが近いと、樋に重なった個体の輪郭が溶けるので暗く保つ
    const troughMat = new THREE.MeshStandardMaterial({
      color: emberColor(0.18),
      roughness: 0.5,
      metalness: 0.35,
      transparent: true,
      opacity: 0.26,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    for (const lane of LANES) {
      pivot.add(new THREE.Mesh(troughGeometry(lane), troughMat));
    }

    // 列は 9 つ。レーンをまたいで順ぐりに落ちるよう、位相を均等に配る
    for (let lane = 0; lane < LANES.length; lane++) {
      for (let c = 0; c < CLUSTERS; c++) {
        const i = lane * CLUSTERS + c;
        clusterOff[i] = frac(c / CLUSTERS + lane / RINGS);
      }
    }

    // アヒルを列へ割り当てる。列の中では位相を等間隔に置き、わずかだけ乱数で崩す
    const perCluster = PER_LANE / CLUSTERS;
    for (let lane = 0; lane < LANES.length; lane++) {
      for (let k = 0; k < PER_LANE; k++) {
        const i = lane * PER_LANE + k;
        const c = Math.min(CLUSTERS - 1, Math.floor(k / perCluster));
        const inner = (k - c * perCluster) / perCluster - 0.5;
        const b = i * 5;
        ducks[b] = lane;
        ducks[b + 1] = frac(
          clusterOff[lane * CLUSTERS + c] + (inner + (rnd() - 0.5) * 0.3) * CLUSTER_SPREAD,
        );
        ducks[b + 2] = rnd() * 2 - 1;
        ducks[b + 3] = rnd();
        ducks[b + 4] = DUCK_R * (0.92 + rnd() * 0.18);
      }
    }

    // おもちゃなので個体で色を変えず、材質 2 つで塗り分ける
    duckMat = new THREE.MeshStandardMaterial({ roughness: 0.42, metalness: 0.06 });
    beakMat = new THREE.MeshStandardMaterial({ roughness: 0.46, metalness: 0.06 });
    parts = duckParts().map((geo, i) => {
      const mesh = new THREE.InstancedMesh(geo, i === 2 ? beakMat : duckMat, TOTAL);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      pivot.add(mesh);
      return mesh;
    });

    // 着水地点。落下区間の式に水面を切る q を入れたもの
    const p = new THREE.Vector3();
    for (let i = 0; i < RINGS; i++) {
      const lane = LANES[Math.floor(i / CLUSTERS)];
      lanePoint(lane, 1, p);
      const a = lane.phase + lane.turns * TAU;
      splash[i * 2] = p.x - Math.sin(a) * FALL_SPREAD;
      splash[i * 2 + 1] = p.z + Math.cos(a) * FALL_SPREAD;
    }

    const ringGeo = new THREE.RingGeometry(0.72, 1, 48);
    ringGeo.rotateX(-Math.PI / 2);
    ringMesh = new THREE.InstancedMesh(
      ringGeo,
      new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0.85,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
      RINGS * RING_WAVES,
    );
    ringMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    pivot.add(ringMesh);

    // 水面。明るい金属面にすると光源が丸い塊になって映り込むので、色を深く沈めたうえで
    // 弱い反射だけを残す。完全なマット面にすると今度は板に見える
    const pool = new THREE.Mesh(
      new THREE.CircleGeometry(POOL_R, 96),
      new THREE.MeshStandardMaterial({ color: emberColor(0.06), roughness: 0.22, metalness: 0.55 }),
    );
    pool.rotation.x = -Math.PI / 2;
    pool.position.y = WATER_Y - 0.02;
    root.add(pool);
  },

  update(t, dt) {
    pivot.rotation.y += dt * SPIN;

    const hue = drift(t);
    duckMat.color.copy(ember(color, 0.82, hue));
    // 実物のくちばしは体より濃いオレンジだが、暗い画面では暗い差分が潰れて
    // 見分けの助けにならない。体より明るい側へ振る
    beakMat.color.copy(ember(color, 0.95, hue));

    const base = t / PERIOD;

    for (let i = 0; i < TOTAL; i++) {
      const b = i * 5;
      const lane = LANES[ducks[b]];
      const s = frac(base + ducks[b + 1]);
      const jr = ducks[b + 2];
      const wob = ducks[b + 3] * TAU;

      if (s < S_EXIT) {
        // 樋の中。u は下へ行くほど速く進むので、列は流れながら伸びる
        const u = Math.pow(s / S_EXIT, GLIDE_EASE);
        const a = lane.phase + u * lane.turns * TAU;
        // 速いほど外側の壁へ寄る
        const r = lane.r0 + (lane.r1 - lane.r0) * u + jr * TUBE_R * 0.15 + u * u * 0.24;
        dummy.position.set(
          Math.cos(a) * r,
          TOP + (EXIT_Y - TOP) * u + RIDE_Y,
          Math.sin(a) * r,
        );
        // 進行方向を向きながら、舟のように左右へゆれる
        dummy.rotation.set(
          Math.sin(u * 11 + wob) * WOBBLE * 0.4,
          -a + Math.sin(u * 8 + wob) * WOBBLE * 0.7,
          Math.sin(u * 13 + wob) * WOBBLE,
        );
      } else {
        // 出口から放り出され、加速しながら水面へ落ちて、くぐって消える
        const q = (s - S_EXIT) / (1 - S_EXIT);
        const a = lane.phase + lane.turns * TAU;
        const r = lane.r1 + jr * TUBE_R * 0.15;
        const fly = Math.min(q / SPLASH_Q, 1) * FALL_SPREAD;
        // 水面までは放物線、そこから先はゆっくり沈む。
        // 水面を切っている間は体の下半分が水面に隠れて「浮いている」ように見える
        const y =
          q < SPLASH_Q
            ? EXIT_Y * (1 - (q / SPLASH_Q) ** 2) + RIDE_Y * (1 - q / SPLASH_Q)
            : -SINK * ((q - SPLASH_Q) / (1 - SPLASH_Q)) ** 2;
        dummy.position.set(
          Math.cos(a) * r - Math.sin(a) * fly,
          WATER_Y + y,
          Math.sin(a) * r + Math.cos(a) * fly,
        );
        // 前のめりに落ちる。水面を切ったらその姿勢のまま沈む
        dummy.rotation.set(-Math.min(q / SPLASH_Q, 1) * 0.7, -a, Math.sin(wob) * WOBBLE * 0.5);
      }

      dummy.scale.setScalar(ducks[b + 4]);
      dummy.updateMatrix();
      for (const part of parts) part.setMatrixAt(i, dummy.matrix);
    }
    for (const part of parts) part.instanceMatrix.needsUpdate = true;

    // 波紋。列の位相が着水の位相をまたぐ瞬間に合わせ、輪を少しずつ遅らせて重ねる
    dummy.rotation.set(0, 0, 0);
    for (let i = 0; i < RINGS * RING_WAVES; i++) {
      const ring = Math.floor(i / RING_WAVES);
      const wave = i % RING_WAVES;
      const age = frac(base + clusterOff[ring] + SPLASH_LEAD - wave * RING_GAP);
      const k = age / RING_LIFE;
      const live = k < 1;
      dummy.position.set(splash[ring * 2], WATER_Y + 0.03, splash[ring * 2 + 1]);
      dummy.scale.setScalar(live ? 0.35 + k * RING_R : 0);
      dummy.updateMatrix();
      ringMesh.setMatrixAt(i, dummy.matrix);
      // 着水は見せ場なので、内側の 1 本をいちばん明るくする
      const fade = live ? (1 - k) * (1 - k) * (1 - wave * 0.3) : 0;
      ember(color, 0.72, hue).multiplyScalar(fade);
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
      for (let k = ticks[i](base + clusterOff[i] + SPLASH_LEAD); k > 0; k--) {
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
