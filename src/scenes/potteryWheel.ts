import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, ticker } from '../audio.ts';
import { SURFACE, ember, emberColor } from '../palette.ts';

/**
 * Pottery Wheel — ろくろの上で、粘土の塊が壺になり、また塊へ戻る。
 *
 * 何が動くか: 回るろくろの上の粘土。土殺し（塊を円錐に伸ばして押し戻す）→ 中を開く →
 *   ヘラを当てて下から上へ 3 回引き上げ、筒にする → もう一度なぞって胴を膨らませ、首を絞った壺にする。
 *   しばらく回して眺めたあと、上から押しつぶされて元の塊へ戻る。
 * 気持ちよさの芯: ヘラが下から上へ昇るのに合わせて、壁が薄く高く伸びていく「引き上げ」。
 *   粘土の表面には回転で流れる濡れた筋と、引き上げでできる細い轆轤目が付く。
 * ループの周期: 30 秒（土殺し 4.2 / 開き 2.8 / 引き上げ 3 秒 × 3 / 成形 5 / 完成 4 / 潰す 5）。
 * カメラ: 斜め上から、ろくろ全体と壺の口の中が見える高さ。
 * 音: 回転の低いドローン。工程が切り替わるたびに 1 音、完成で和音、潰すときに沈む音。
 * スコープ外: 手や指、水・泥しぶき、糸切りと作品の取り上げ、高台削り。
 */

/** 輪郭の外壁・内壁それぞれのサンプル数（下から上へ等間隔） */
const NH = 48;
/** 口縁（外壁の頂点から内壁の頂点へ回り込む半円）のサンプル数 */
const NL = 7;
/** 周方向の分割数 */
const NS = 96;
/** 輪郭 1 本の点の数: 外壁 + 口縁 + 内壁 + 底の中心 */
const NP = NH + NL + NH + 1;

/** ろくろの回転（rad/秒）。上から見て反時計回り */
const SPIN = 2.4;
/** ろくろの天板の半径 */
const HEAD_R = 4;
/** 受け皿（天板を囲む水受け）の内径・外径 */
const PAN_IN = 4.5;
const PAN_OUT = 5.5;
/** 床の高さ */
const FLOOR_Y = -1.7;

/** ヘラを当てる向き（カメラから見て右手前）と、離しているときの置き場所 */
const RIB_ANGLE = -0.55;
const RIB_REST_R = HEAD_R + 0.3;
const RIB_REST_Y = 1.6;
/** ヘラが押し込む深さと幅（高さ方向、ワールド単位） */
const PRESS = 0.12;
const PRESS_W = 0.35;
/** 轆轤目の深さと間隔 */
const RIDGE = 0.011;
const RIDGE_PITCH = 0.3;

/** 工程の区切り（秒） */
const T_CONE_UP = 2.2;
const T_CONE_DN = 4.2;
const T_OPEN = 7;
const PULLS = 3;
const T_PULL = 3;
const T_PULLED = T_OPEN + PULLS * T_PULL; // 16
const T_SHAPED = 21;
const T_HOLD = 25;
const CYCLE = 30;

/** 音を鳴らす時刻と、そのときの音程 */
const EVENTS = [0, T_CONE_UP, T_CONE_DN, T_OPEN, T_OPEN + T_PULL, T_OPEN + 2 * T_PULL, T_PULLED, T_SHAPED, T_HOLD];
const NOTES = [5, 7, 4, 8, 9, 10, 11, 12, 3];

/** 粘土の形 1 つぶん。外径・内径は高さ h（0..1）ごとの配列 */
interface Shape {
  H: number;
  ro: Float32Array;
  ri: Float32Array;
  /** 内側の底の高さ。塊のときは H（= 穴が無い） */
  floor: number;
  /** 轆轤目の出方 0..1 */
  ridge: number;
}

function makeShape(H: number, floor: number, ridge: number, ro: (h: number) => number, wall: (h: number) => number | null): Shape {
  const s: Shape = { H, ro: new Float32Array(NH), ri: new Float32Array(NH), floor, ridge };
  for (let k = 0; k < NH; k++) {
    const h = k / (NH - 1);
    s.ro[k] = ro(h);
    const w = wall(h);
    s.ri[k] = w === null ? 0 : Math.max(s.ro[k] - w, 0);
  }
  return s;
}

const smooth = (a: number, b: number, x: number): number => {
  const k = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return k * k * (3 - 2 * k);
};
const ease = (x: number): number => smooth(0, 1, x);

/** 塊: 低いドーム。穴は無い */
const LUMP = makeShape(2.4, 2.4, 0, (h) => 2.3 * Math.pow(Math.max(1 - h * h, 0), 0.45), () => null);
/** 土殺しの円錐 */
const CONE = makeShape(4.6, 4.6, 0, (h) => 1.6 * Math.pow(1 - h, 0.9) + 0.05, () => null);
/** 中を開いた厚い円盤 */
const PUCK = makeShape(2.2, 0.55, 0, (h) => 2.2 - 0.3 * h * h, () => 0.9);
/** 引き上げた筒 */
const CYL = makeShape(5.2, 0.35, 1, (h) => 1.62 + 0.08 * (1 - h), () => 0.28);
/** 胴を膨らませて首を絞った壺 */
const VASE = makeShape(
  5.8,
  0.35,
  1,
  (h) => 0.85 + 1.25 * Math.exp(-(((h - 0.36) / 0.26) ** 2)) + 0.36 * smooth(0.84, 1, h),
  () => 0.24,
);

const cur: Shape = { H: 0, ro: new Float32Array(NH), ri: new Float32Array(NH), floor: 0, ridge: 0 };

function blend(a: Shape, b: Shape, s: number): void {
  cur.H = a.H + (b.H - a.H) * s;
  cur.floor = a.floor + (b.floor - a.floor) * s;
  cur.ridge = a.ridge + (b.ridge - a.ridge) * s;
  for (let k = 0; k < NH; k++) {
    cur.ro[k] = a.ro[k] + (b.ro[k] - a.ro[k]) * s;
    cur.ri[k] = a.ri[k] + (b.ri[k] - a.ri[k]) * s;
  }
}

/** 輪郭の (r, y) と、その点の外向き法線 (nr, ny) */
const pr = new Float32Array(NP);
const py = new Float32Array(NP);
const nr = new Float32Array(NP);
const ny = new Float32Array(NP);
const cosT = new Float32Array(NS + 1);
const sinT = new Float32Array(NS + 1);

let clay: THREE.Mesh;
let clayGeo: THREE.BufferGeometry;
let wheel: THREE.Group;
let rib: THREE.Group;

let tick = ticker();

export const potteryWheel: SceneModule = {
  name: 'Pottery Wheel',
  desc: 'ろくろの上で粘土の塊が引き上げられて壺になり、押しつぶされてまた塊へ戻る。',
  camera: { pos: [0, 9, 14], target: [0, 2.7, 0] },

  build(root) {
    tick = ticker();

    for (let j = 0; j <= NS; j++) {
      const a = (j / NS) * Math.PI * 2;
      cosT[j] = Math.cos(a);
      sinT[j] = Math.sin(a);
    }

    // 粘土。頂点の位置と法線は毎フレーム作り直し、色（濡れた筋）だけ build で焼く
    clayGeo = new THREE.BufferGeometry();
    const cols = NS + 1;
    const pos = new Float32Array(NP * cols * 3);
    const nor = new Float32Array(NP * cols * 3);
    const col = new Float32Array(NP * cols * 3);
    const c = new THREE.Color();
    let seed = 0.731;
    const rnd = (): number => (seed = (seed * 9301 + 0.49297) % 1);
    const jitter = new Float32Array(NS);
    for (let j = 0; j < NS; j++) jitter[j] = rnd();
    for (let i = 0; i < NP; i++) {
      const inner = i >= NH + NL;
      for (let j = 0; j <= NS; j++) {
        const a = (j / NS) * Math.PI * 2;
        const jj = j % NS;
        const n =
          0.5 +
          0.06 * Math.sin(2 * a + i * 0.11) +
          0.035 * Math.sin(7 * a - i * 0.27) +
          0.03 * (jitter[jj] - 0.5) -
          (inner ? 0.12 : 0);
        ember(c, n, 0.01);
        const o = (i * cols + j) * 3;
        col[o] = c.r;
        col[o + 1] = c.g;
        col[o + 2] = c.b;
      }
    }
    const index: number[] = [];
    for (let i = 0; i < NP - 1; i++) {
      for (let j = 0; j < NS; j++) {
        const a = i * cols + j;
        const b = a + cols;
        index.push(a, a + 1, b, b, a + 1, b + 1);
      }
    }
    clayGeo.setIndex(index);
    clayGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    clayGeo.setAttribute('normal', new THREE.BufferAttribute(nor, 3).setUsage(THREE.DynamicDrawUsage));
    clayGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    clay = new THREE.Mesh(
      clayGeo,
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.38, metalness: 0.04, side: THREE.DoubleSide }),
    );
    clay.frustumCulled = false;

    // ろくろ: 天板・脚・回っているのが分かる目印
    wheel = new THREE.Group();
    const headMat = new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.45, metalness: 0.45 });
    const head = new THREE.Mesh(new THREE.CylinderGeometry(HEAD_R, HEAD_R * 0.97, 0.3, 96), headMat);
    head.position.y = -0.15;
    wheel.add(head);
    const markMat = new THREE.MeshStandardMaterial({ color: emberColor(0.28), roughness: 0.5, metalness: 0.3 });
    for (let k = 0; k < 3; k++) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(2.8 + k * 0.45, 0.018, 6, 96), markMat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.005;
      wheel.add(ring);
    }
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2;
      const mark = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.03, 0.09), markMat);
      mark.position.set(Math.cos(a) * 3.35, 0.01, Math.sin(a) * 3.35);
      mark.rotation.y = -a;
      wheel.add(mark);
    }
    wheel.add(clay);
    root.add(wheel);

    const baseMat = new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.55, metalness: 0.5 });
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 1.1, -FLOOR_Y, 32), baseMat);
    shaft.position.y = FLOOR_Y / 2 - 0.15;
    root.add(shaft);

    // 受け皿: 天板のまわりを囲む浅い鉢
    const panProfile = [
      new THREE.Vector2(PAN_IN - 0.2, -0.75),
      new THREE.Vector2(PAN_OUT - 0.2, -0.75),
      new THREE.Vector2(PAN_OUT, -0.55),
      new THREE.Vector2(PAN_OUT, 0.15),
      new THREE.Vector2(PAN_OUT - 0.12, 0.2),
      new THREE.Vector2(PAN_OUT - 0.18, -0.5),
      new THREE.Vector2(PAN_IN - 0.2, -0.62),
    ];
    const pan = new THREE.Mesh(
      new THREE.LatheGeometry(panProfile, 96),
      new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.6, metalness: 0.35, side: THREE.DoubleSide }),
    );
    root.add(pan);

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(14, 96),
      new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.55, metalness: 0.55 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = FLOOR_Y;
    root.add(floor);

    // ヘラ: 薄い木の板。回らず、引き上げのときだけ粘土に寄ってくる
    rib = new THREE.Group();
    const ribMat = new THREE.MeshStandardMaterial({ color: emberColor(0.8, 0.02, 0.04), roughness: 0.6, metalness: 0.05 });
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.14, 1.5, 1.3), ribMat);
    blade.position.x = 0.07;
    rib.add(blade);
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 1.8, 16), ribMat);
    grip.rotation.z = Math.PI / 2;
    grip.position.set(1.0, 0, 0);
    rib.add(grip);
    rib.rotation.y = RIB_ANGLE;
    root.add(rib);
  },

  update(t) {
    const u = ((t % CYCLE) + CYCLE) % CYCLE;

    // 工程ごとに、どの形からどの形へ、どこまで進んだかを決める
    let hc = 0; // ヘラの高さ（0..1）
    let contact = 0; // ヘラの当たり具合（0 = 離れている）
    if (u < T_CONE_UP) blend(LUMP, CONE, ease(u / T_CONE_UP));
    else if (u < T_CONE_DN) blend(CONE, LUMP, ease((u - T_CONE_UP) / (T_CONE_DN - T_CONE_UP)));
    else if (u < T_OPEN) blend(LUMP, PUCK, ease((u - T_CONE_DN) / (T_OPEN - T_CONE_DN)));
    else if (u < T_PULLED) {
      const k = Math.floor((u - T_OPEN) / T_PULL);
      const x = (u - T_OPEN) / T_PULL - k;
      const rise = smooth(0.12, 0.92, x);
      blend(PUCK, CYL, ease((k + rise) / PULLS));
      hc = 0.04 + rise * 0.92;
      contact = smooth(0, 0.12, x) * (1 - smooth(0.9, 1, x));
    } else if (u < T_SHAPED) {
      const x = (u - T_PULLED) / (T_SHAPED - T_PULLED);
      const rise = smooth(0.08, 0.94, x);
      blend(CYL, VASE, rise);
      hc = 0.04 + rise * 0.92;
      contact = smooth(0, 0.08, x) * (1 - smooth(0.94, 1, x));
    } else if (u < T_HOLD) blend(VASE, VASE, 0);
    else blend(VASE, LUMP, ease((u - T_HOLD) / (CYCLE - T_HOLD)));

    // 輪郭を組み立てる: 外壁（下→上）→ 口縁 → 内壁（上→下）→ 底の中心
    const H = cur.H;
    const cy = hc * H;
    // 轆轤目はヘラが通った高さより下にだけ残す
    const top = cy + (H + 1 - cy) * (1 - contact);
    const ridgeMask = (y: number): number => 1 - smooth(top - 0.3, top + 0.1, y);
    let p = 0;
    for (let k = 0; k < NH; k++, p++) {
      const y = (k / (NH - 1)) * H;
      const dent = contact * PRESS * Math.exp(-(((y - cy) / PRESS_W) ** 2));
      const ridge = cur.ridge * RIDGE * ridgeMask(y) * Math.sin((y / RIDGE_PITCH) * Math.PI * 2);
      pr[p] = Math.max(cur.ro[k] - dent + ridge, 0);
      py[p] = y;
    }
    const ro1 = pr[NH - 1];
    const ri1 = cur.ri[NH - 1];
    const lc = (ro1 + ri1) / 2;
    const lr = Math.max((ro1 - ri1) / 2, 0);
    for (let k = 1; k <= NL; k++, p++) {
      const a = (k / (NL + 1)) * Math.PI;
      pr[p] = lc + lr * Math.cos(a);
      py[p] = H + lr * 0.8 * Math.sin(a);
    }
    for (let k = NH - 1; k >= 0; k--, p++) {
      pr[p] = cur.ri[k];
      py[p] = cur.floor + (k / (NH - 1)) * (H - cur.floor);
    }
    pr[p] = 0;
    py[p] = cur.floor;

    // 法線は輪郭の接線を 90° 回すだけで出る（継ぎ目が出ない）
    for (let i = 0; i < NP; i++) {
      const a = i > 0 ? i - 1 : i;
      const b = i < NP - 1 ? i + 1 : i;
      const dr = pr[b] - pr[a];
      const dy = py[b] - py[a];
      const len = Math.hypot(dr, dy);
      if (len < 1e-5) {
        nr[i] = 0;
        ny[i] = 1;
      } else {
        nr[i] = dy / len;
        ny[i] = -dr / len;
      }
    }

    const pos = clayGeo.getAttribute('position') as THREE.BufferAttribute;
    const nor = clayGeo.getAttribute('normal') as THREE.BufferAttribute;
    const P = pos.array as Float32Array;
    const N = nor.array as Float32Array;
    let o = 0;
    for (let i = 0; i < NP; i++) {
      for (let j = 0; j <= NS; j++, o += 3) {
        P[o] = pr[i] * cosT[j];
        P[o + 1] = py[i];
        P[o + 2] = -pr[i] * sinT[j];
        N[o] = nr[i] * cosT[j];
        N[o + 1] = ny[i];
        N[o + 2] = -nr[i] * sinT[j];
      }
    }
    pos.needsUpdate = true;
    nor.needsUpdate = true;

    wheel.rotation.y = t * SPIN;

    // ヘラは当たっている高さの外壁に沿わせ、離すときは外へ退く
    const k = Math.min(Math.max(Math.round(hc * (NH - 1)), 0), NH - 1);
    const r = RIB_REST_R + (cur.ro[k] - PRESS - RIB_REST_R) * contact;
    const y = RIB_REST_Y + (cy - RIB_REST_Y) * contact;
    rib.position.set(Math.cos(RIB_ANGLE) * r, y, -Math.sin(RIB_ANGLE) * r);
  },

  sound(t, _dt, sfx) {
    sfx.drone(tone(0), 0.05);
    const u = ((t % CYCLE) + CYCLE) % CYCLE;
    let passed = 0;
    while (passed < EVENTS.length && EVENTS[passed] <= u) passed++;
    for (let n = tick(Math.floor(t / CYCLE) * EVENTS.length + passed); n > 0; n--) {
      const e = (passed - n + EVENTS.length) % EVENTS.length;
      if (e === EVENTS.length - 1) {
        sfx.drop(tone(NOTES[e]), { gain: 0.35, decay: 0.9, bend: 0.5 });
      } else if (e === EVENTS.length - 2) {
        sfx.pluck(tone(NOTES[e]), { gain: 0.3, decay: 3 });
        sfx.pluck(tone(NOTES[e] + 2), { gain: 0.22, decay: 3.2, pan: 0.3 });
        sfx.pluck(tone(NOTES[e] + 4), { gain: 0.18, decay: 3.4, pan: -0.3 });
      } else {
        sfx.pluck(tone(NOTES[e]), { gain: 0.28, decay: 2, pan: 0.35 });
      }
    }
  },
};
