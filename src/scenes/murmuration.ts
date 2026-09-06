import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, ticker } from '../audio.ts';
import { ember, drift } from '../palette.ts';

/**
 * 鳥の群れ（ムクドリのねぐら入り）。
 *
 * 他のシーンは形を時刻 t の式で決めているが、ここだけは毎フレームの積分でしか
 * 形が決まらない。1 羽が見ているのは近くの数羽だけで、
 *   分離 … 近すぎる仲間から離れる
 *   整列 … 近くの仲間と向きを揃える
 *   結合 … 近くの仲間の重心へ寄る
 * の 3 つしか決めていない。群れ全体の形は誰も決めていないのに、
 * うねりも密度のむらも勝手に立ち上がる。
 */

/** 羽数。少なめにして、1 羽ずつの姿と羽ばたきが見える大きさで飛ばす。 */
const COUNT = 30;

/** 群れを閉じ込める球の半径と、その中心の高さ。 */
const SPHERE = 13;
const CENTER_Y = 4;

/** ねぐらの上を旋回する輪の半径。群れが描く軌道の大きさ。 */
const ROOST = 4;
/** 群れ 1 塊の半径。ここから出た羽だけが重心へ引き戻される。 */
const FLOCK_R = 4.2;
/** 上下方向だけ縮める率。空の群れは球ではなく、横に広い塊になる。 */
const FLOCK_FLAT = 1.7;

/** 仲間を見つける距離と、近すぎると判断する距離。翼が触れない間隔を取る。 */
const VIEW = 4;
const SEP = 2;
const VIEW2 = VIEW * VIEW;
const SEP2 = SEP * SEP;

/** 3 つの規則の重み。分離を一番強くしないと団子になる。 */
const W_SEP = 2;
const W_ALI = 1.15;
const W_COH = 0.6;
/** 群れから離れた羽を呼び戻す力と、ねぐらの上を旋回させる流れ。 */
const W_HOME = 2.2;
const W_SWIRL = 1;
/** それでも球から出てしまった羽を戻す、最後の歯止め。 */
const W_BOUND = 2.4;
/** 気配から逃げる力。他をねじ伏せる強さでないと群れが割れない。 */
const W_FLEE = 5;

/** 飛ぶ速さの上下限と、1 フレームでかけられる力の上限。 */
const MAX_SPEED = 5.4;
const MIN_SPEED = 2.6;
const MAX_FORCE = 10;

/** 旋回の内側へ傾く量。速度と直交する加速度の大きさから決める。 */
const BANK = 0.2;

/** 羽ばたきの速さ（rad/秒）と、上昇中に深くなる度合い。 */
const FLAP_RATE = 8.5;
const FLAP_GAIN = 0.7;

/**
 * 見えない気配（猛禽のようなもの）が群れを横切る周期。
 * 姿は出さず、群れのよじれだけで存在を見せる。
 */
const HAWK_CYCLE = 17;
/** 1 周のうち実際に横切っている割合 */
const HAWK_SPAN = 0.32;
/** 位相のずらし。シーンを開いた直後は静かに、数秒おいてから最初の 1 回が来る。 */
const HAWK_OFFSET = 0.62;
/** 気配を感じ取る半径と、通り抜ける距離 */
const HAWK_R = 5;
const HAWK_PATH = 24;

/** 羽の面が受ける光。この向きへ正対した鳥だけが明るく光る。 */
const LIGHT = new THREE.Vector3(8, 18, 10).normalize();

const pos = new Float32Array(COUNT * 3);
const vel = new Float32Array(COUNT * 3);
/** 羽ごとの大きさと、羽ばたきの位相 */
const size = new Float32Array(COUNT);
const flap = new Float32Array(COUNT);

/** 胴体と、左右それぞれの上腕・手（初列風切）。合わせて 5 回の描画で済む。 */
let body: THREE.InstancedMesh;
const armMesh: THREE.InstancedMesh[] = [];
const handMesh: THREE.InstancedMesh[] = [];
/** armMesh / handMesh の並び順に対応する左右。+1 が右。 */
const SIDES = [1, -1] as const;

const color = new THREE.Color();
const bodyColor = new THREE.Color();
const fwd = new THREE.Vector3();
const right = new THREE.Vector3();
const up = new THREE.Vector3();
const scale = new THREE.Vector3();
const spin = new THREE.Quaternion();
const mBird = new THREE.Matrix4();
const mLimb = new THREE.Matrix4();
const mSweep = new THREE.Matrix4();
const mOut = new THREE.Matrix4();
const UP = new THREE.Vector3(0, 1, 0);

/** いま計算中の 1 羽にかかっている力。steer() が足し込む。 */
let ax = 0;
let ay = 0;
let az = 0;

/**
 * 前フレームの群れの重心。
 *
 * 群れを 1 塊に保つ引力の中心であり、旋回の向きもここから決める。
 * 全員が同じ向きを共有するので、群れは散らばらずに塊のまま渡っていく。
 */
let homeX = ROOST;
let homeY = CENTER_Y;
let homeZ = 0;
/** 気配の位置。音の定位に使う。 */
let hawkX = 0;
let hawkOn = false;
/**
 * 気配が狙う点。1 回の通過が始まった瞬間の群れの重心を覚えておく。
 *
 * 毎フレーム重心を追わせると、逃げた先へ気配も動いてしまい追いかけっこになる。
 * 入り口で狙いを固定すれば、群れは横へ抜けてかわせる。
 */
let aimCycle = -1;
let aimX = ROOST;
let aimY = CENTER_Y;
let aimZ = 0;

let gust = ticker();
let wingBeat = ticker();

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

/**
 * 「その向きへ全速で飛びたい」という願いを、いまの速度との差＝力に直して足す。
 *
 * 差を取らずに向きをそのまま足すと、行き過ぎて振動する。上限をかけるのは
 * 1 羽が急に折れ曲がらないようにするため。
 */
function steer(dx: number, dy: number, dz: number, vx: number, vy: number, vz: number, w: number): void {
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-6) return;
  const k = MAX_SPEED / len;
  let sx = dx * k - vx;
  let sy = dy * k - vy;
  let sz = dz * k - vz;
  const sl = Math.hypot(sx, sy, sz);
  if (sl > MAX_FORCE) {
    const c = MAX_FORCE / sl;
    sx *= c;
    sy *= c;
    sz *= c;
  }
  ax += sx * w;
  ay += sy * w;
  az += sz * w;
}

/* ------------------------------------------------------------------ *
 * かたち
 *
 * 平らな板を並べると虫の翅に見えてしまうので、鳥はすべて「輪切りの断面を
 * 軸方向に並べた立体」で作る。断面の幅と厚みを少しずつ変えるだけで、
 * 嘴から尾までの膨らみも、付け根から翼端への薄まりも 1 つの式で書ける。
 * ------------------------------------------------------------------ */

/** 断面 1 枚。中心が (x, y, z)、a と b はその断面の楕円の半径。 */
interface Ring {
  x: number;
  y: number;
  z: number;
  a: number;
  b: number;
}

/**
 * 断面を並べて閉じた立体にする。
 *
 * @param axis 断面を並べる方向。'z' なら断面は XY 平面（胴体）、
 *             'x' なら ZY 平面（翼。a が翼弦、b が厚み）。
 */
function loft(rings: readonly Ring[], seg: number, axis: 'x' | 'z'): THREE.BufferGeometry {
  const verts: number[] = [];
  const index: number[] = [];

  for (const r of rings) {
    for (let j = 0; j < seg; j++) {
      const th = (j / seg) * Math.PI * 2;
      const ca = Math.cos(th) * r.a;
      const sb = Math.sin(th) * r.b;
      if (axis === 'z') verts.push(r.x + ca, r.y + sb, r.z);
      else verts.push(r.x, r.y + sb, r.z + ca);
    }
  }

  for (let i = 0; i < rings.length - 1; i++) {
    for (let j = 0; j < seg; j++) {
      const k = (j + 1) % seg;
      const a0 = i * seg + j;
      const b0 = i * seg + k;
      const a1 = (i + 1) * seg + j;
      const b1 = (i + 1) * seg + k;
      index.push(a0, a1, b1, a0, b1, b0);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  g.setIndex(index);
  // 面ごとではなく頂点ごとの法線にすることで、稜線が出ずに丸く見える
  g.computeVertexNormals();
  return g;
}

/**
 * 胴体の断面。嘴 → 丸い頭 → 首のくびれ → 胸 → 腰と続き、
 * 腰から先は縦を潰して横へ広げる。そこが扇形の尾羽になる。
 */
const BODY_RINGS: readonly Ring[] = [
  { x: 0, y: 0.015, z: 0.86, a: 0, b: 0 },
  { x: 0, y: 0.015, z: 0.72, a: 0.022, b: 0.02 },
  { x: 0, y: 0.02, z: 0.62, a: 0.052, b: 0.05 },
  { x: 0, y: 0.035, z: 0.52, a: 0.098, b: 0.098 },
  { x: 0, y: 0.03, z: 0.42, a: 0.1, b: 0.102 },
  { x: 0, y: 0.012, z: 0.3, a: 0.078, b: 0.082 },
  { x: 0, y: 0, z: 0.14, a: 0.118, b: 0.128 },
  { x: 0, y: 0, z: -0.1, a: 0.12, b: 0.124 },
  { x: 0, y: 0, z: -0.34, a: 0.098, b: 0.1 },
  { x: 0, y: 0, z: -0.58, a: 0.07, b: 0.062 },
  { x: 0, y: 0, z: -0.74, a: 0.07, b: 0.03 },
  { x: 0, y: 0, z: -0.95, a: 0.155, b: 0.016 },
  { x: 0, y: 0, z: -1.16, a: 0.135, b: 0.012 },
  { x: 0, y: 0, z: -1.32, a: 0, b: 0 },
];

/** 翼を上腕と手に分ける位置。ここが手首になる。 */
const WRIST_U = 0.42;

/** 継ぎ目を隠すために、上腕と手をこれだけ重ねて作る。 */
const WRIST_LAP = 0.05;

/**
 * 翼の断面。u = 0 が肩、1 が翼端。
 *
 * 翼弦は付け根が最も広く、外へ行くほど細る。同時に断面の中心が後ろへ下がる
 * ので、前縁も後縁もそろって後退し、先の尖った鎌形の輪郭になる。
 * y を二次で持ち上げているのは、翼を弓なりに反らせて板に見せないため。
 */
function wingAt(u: number): Ring {
  const chord = 0.4 * Math.pow(Math.max(1 - u, 0), 0.55) + 0.035;
  return {
    x: 0.085 + u * 1.16,
    y: 0.03 + 0.14 * u * u,
    z: 0.06 - 0.44 * Math.pow(u, 1.7),
    a: chord * 0.5,
    b: 0.052 * Math.pow(1 - u, 1.35) + 0.004,
  };
}

/** 手首の位置。手側の翼はここを原点にして、上腕とは別に振る。 */
const WRIST = wingAt(WRIST_U);

/**
 * 断面を鳥のローカル座標へ移す。
 *
 * @param dir  +1 が右、-1 が左。x を反転するだけで左右が作れる。
 * @param base 原点にしたい位置。手側はここに手首を渡して、根元で回せるようにする。
 */
function toLocal(rings: readonly Ring[], dir: 1 | -1, base: Ring | null): Ring[] {
  const bx = base ? base.x : 0;
  const by = base ? base.y : 0;
  const bz = base ? base.z : 0;
  return rings.map((r) => ({ x: (r.x - bx) * dir, y: r.y - by, z: r.z - bz, a: r.a, b: r.b }));
}

/**
 * 翼を u0..u1 で刻み、断面を scale() 倍しながら並べて、両端を潰して閉じる。
 *
 * 上腕と手は別の立体なので、境目をただ突き合わせると面がぴたりと重なって
 * そこだけ縞が浮く。手首をまたぐ区間はどちらか一方を細らせ、相手の内側へ
 * 潜り込ませる。潰した蓋も相手の肉の中に埋まるので、外からは見えない。
 */
function wingPart(
  dir: 1 | -1,
  u0: number,
  u1: number,
  steps: number,
  base: Ring | null,
  scale: (u: number) => number,
  tipU: number | null,
): THREE.BufferGeometry {
  const rings: Ring[] = [];
  for (let i = 0; i <= steps; i++) {
    const u = u0 + ((u1 - u0) * i) / steps;
    const r = wingAt(u);
    const k = scale(u);
    rings.push({ ...r, a: r.a * k, b: r.b * k });
  }
  rings.unshift({ ...rings[0]!, a: 0, b: 0 });
  // 蓋をその場で閉じると切り落としたような平面が残る。翼端だけは少し先へ置く
  rings.push(tipU === null ? { ...rings[rings.length - 1]!, a: 0, b: 0 } : { ...wingAt(tipU), a: 0, b: 0 });
  return loft(toLocal(rings, dir, base), 10, 'x');
}

/**
 * 上腕（肩から手首まで）。
 *
 * 手首の少し先まで細りながら伸ばしてある。翼が手首で曲がると外側に楔形の
 * 隙間が空くので、この延長がそこを埋めて、関節が切れて見えないようにする。
 */
function armGeometry(dir: 1 | -1): THREE.BufferGeometry {
  return wingPart(dir, 0, WRIST_U + WRIST_LAP, 8, null, (u) => (u <= WRIST_U ? 1 : 1 - 0.4 * ((u - WRIST_U) / WRIST_LAP)), null);
}

/**
 * 手（手首から翼端まで）。手首を原点にして、上腕とは別に振る。
 *
 * 手首より内側へは伸ばさない。回転の中心より後ろに肉があると、翼を曲げた
 * ときにその部分が上腕を突き破って角のように飛び出す。
 */
function handGeometry(dir: 1 | -1): THREE.BufferGeometry {
  return wingPart(dir, WRIST_U, 1, 11, WRIST, () => 1, 1.06);
}

function makeMesh(geo: THREE.BufferGeometry): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(
    geo,
    new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.06 }),
    COUNT,
  );
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false; // 群れが動き回るので、原点基準の境界球は当てにならない
  return mesh;
}

/** 夕暮れの空を、鳥の群れが形を変えながら渡っていく。 */
export const murmuration: SceneModule = {
  name: 'Murmuration',
  desc: '一羽ずつは近くの数羽しか見ていないのに、群れはひとつの生きもののようにうねる。',
  // 群れの少し上へ視線を置くと、輪の手前側が下に垂れても画面の中に収まる
  camera: { pos: [0, 5.5, 17.5], target: [0, CENTER_Y + 0.8, 0] },

  build(root) {
    gust = ticker();
    wingBeat = ticker();

    let s = 0.4172;
    const rnd = (): number => (s = (s * 9301 + 0.49297) % 1);

    for (let i = 0; i < COUNT; i++) {
      // 最初から軌道上の 1 点に、縦をつぶした塊として置く。原点に置くと
      // 旋回の向き（重心から見た接線）が決まらず、動き出しがもたつく
      const a = rnd() * Math.PI * 2;
      const b = Math.acos(rnd() * 2 - 1);
      const r = Math.cbrt(rnd()) * FLOCK_R;
      pos[i * 3] = ROOST + Math.sin(b) * Math.cos(a) * r;
      pos[i * 3 + 1] = CENTER_Y + (Math.cos(b) * r) / FLOCK_FLAT;
      pos[i * 3 + 2] = Math.sin(b) * Math.sin(a) * r;

      // 初速はばらばらでよい。整列の規則が数秒で勝手に揃えてくれる
      const va = rnd() * Math.PI * 2;
      const vb = (rnd() - 0.5) * 0.9;
      const sp = MIN_SPEED + rnd() * (MAX_SPEED - MIN_SPEED);
      vel[i * 3] = Math.cos(va) * Math.cos(vb) * sp;
      vel[i * 3 + 1] = Math.sin(vb) * sp;
      vel[i * 3 + 2] = Math.sin(va) * Math.cos(vb) * sp;

      size[i] = 1 + rnd() * 0.35;
      flap[i] = rnd() * Math.PI * 2;
    }

    homeX = ROOST;
    homeY = CENTER_Y;
    homeZ = 0;
    aimCycle = -1;
    aimX = ROOST;
    aimY = CENTER_Y;
    aimZ = 0;

    body = makeMesh(loft(BODY_RINGS, 12, 'z'));
    root.add(body);

    armMesh.length = 0;
    handMesh.length = 0;
    for (const dir of SIDES) {
      const arm = makeMesh(armGeometry(dir));
      const hand = makeMesh(handGeometry(dir));
      armMesh.push(arm);
      handMesh.push(hand);
      root.add(arm, hand);
    }
  },

  update(t, dt) {
    const d = drift(t);

    // 見えない気配。周回ごとに黄金角だけ向きを変えるので、同じ道を通らない
    const turn = t / HAWK_CYCLE + HAWK_OFFSET;
    const cycle = Math.floor(turn);
    const ph = turn - cycle;
    hawkOn = ph < HAWK_SPAN;
    const u = ph / HAWK_SPAN;
    if (cycle !== aimCycle) {
      aimCycle = cycle;
      aimX = homeX;
      aimY = homeY;
      aimZ = homeZ;
    }
    const ang = cycle * 2.399963;
    const along = (u - 0.5) * HAWK_PATH;
    const hx = aimX + Math.cos(ang) * along;
    const hy = aimY + (u - 0.5) * 3;
    const hz = aimZ + Math.sin(ang) * along;
    hawkX = hx;

    /*
     * 群れが次に向かう向き。羽ごとではなく重心の位置から 1 度だけ決めて全員へ配る。
     * こうすると全員が同じ「風」を受けるので、群れは輪に引き伸ばされず、
     * 塊のままねぐらの上を渡っていく。
     */
    const hr = Math.hypot(homeX, homeZ) || 1e-6;
    const inward = clamp((ROOST - hr) / 5, -1, 1); // 外にいれば内へ、内にいれば外へ
    const swirlX = -homeZ / hr + (homeX / hr) * inward;
    const swirlZ = homeX / hr + (homeZ / hr) * inward;
    // 高さは数十秒かけて上下する。降りてくるときに群れが伸びる
    const swirlY = (CENTER_Y + Math.sin(t * 0.19) * 2.6 - homeY) * 0.35;

    let sumX = 0;
    let sumY = 0;
    let sumZ = 0;

    for (let i = 0; i < COUNT; i++) {
      const px = pos[i * 3]!;
      const py = pos[i * 3 + 1]!;
      const pz = pos[i * 3 + 2]!;
      let vx = vel[i * 3]!;
      let vy = vel[i * 3 + 1]!;
      let vz = vel[i * 3 + 2]!;

      let cx = 0, cy = 0, cz = 0; // 近傍の重心
      let alx = 0, aly = 0, alz = 0; // 近傍の速度の和
      let sx = 0, sy = 0, sz = 0; // 近すぎる相手から離れる向き
      let n = 0;

      for (let j = 0; j < COUNT; j++) {
        if (j === i) continue;
        const dx = pos[j * 3]! - px;
        const dy = pos[j * 3 + 1]! - py;
        const dz = pos[j * 3 + 2]! - pz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > VIEW2 || d2 < 1e-8) continue;

        cx += dx;
        cy += dy;
        cz += dz;
        alx += vel[j * 3]!;
        aly += vel[j * 3 + 1]!;
        alz += vel[j * 3 + 2]!;
        n++;

        // 近いほど強く押し返す。距離の二乗で割ると、触れる直前だけ効く
        if (d2 < SEP2) {
          sx -= dx / d2;
          sy -= dy / d2;
          sz -= dz / d2;
        }
      }

      ax = 0;
      ay = 0;
      az = 0;

      if (n > 0) {
        steer(alx, aly, alz, vx, vy, vz, W_ALI);
        steer(cx, cy, cz, vx, vy, vz, W_COH);
      }
      steer(sx, sy, sz, vx, vy, vz, W_SEP);
      steer(swirlX, swirlY, swirlZ, vx, vy, vz, W_SWIRL);

      // 群れから離れた羽だけを重心へ呼び戻す。中にいる限り何もしないので、
      // 内側が詰まらず、塊のまま volume を保てる
      const hx0 = homeX - px;
      const hy0 = homeY - py;
      const hz0 = homeZ - pz;
      // 縦を詰めた距離で測るので、引き戻しは上下ほど早くかかる
      const hd = Math.hypot(hx0, hy0 * FLOCK_FLAT, hz0);
      if (hd > FLOCK_R) {
        steer(hx0, hy0, hz0, vx, vy, vz, W_HOME * Math.min((hd - FLOCK_R) / 3, 1.5));
      }

      // 球からはみ出した分だけ内向きの力。壁で弾かず、じわりと引き戻す
      const ox = px;
      const oy = py - CENTER_Y;
      const oz = pz;
      const dist = Math.hypot(ox, oy, oz);
      if (dist > SPHERE) {
        const over = Math.min((dist - SPHERE) / 4, 1.5);
        steer(-ox, -oy, -oz, vx, vy, vz, W_BOUND * over);
      }

      if (hawkOn) {
        const fx = px - hx;
        const fy = py - hy;
        const fz = pz - hz;
        const fd = Math.hypot(fx, fy, fz);
        // 近い羽ほど強く逃げる。逃げた羽が仲間を押すので、驚きが波として伝わる
        if (fd < HAWK_R) steer(fx, fy, fz, vx, vy, vz, W_FLEE * (1 - fd / HAWK_R));
      }

      vx += ax * dt;
      vy += ay * dt;
      vz += az * dt;

      // 鳥は止まれないし、落ちもしない。速さだけ範囲へ丸める
      const sp = Math.hypot(vx, vy, vz) || 1;
      const cl = clamp(sp, MIN_SPEED, MAX_SPEED) / sp;
      vx *= cl;
      vy *= cl;
      vz *= cl;

      vel[i * 3] = vx;
      vel[i * 3 + 1] = vy;
      vel[i * 3 + 2] = vz;
      // 位置は総当たりの途中で書き換わるが、1 フレームの移動は視野の 3% ほど。
      // 揃いすぎない分、かえって群れが硬くならない
      const nx = px + vx * dt;
      const ny = py + vy * dt;
      const nz = pz + vz * dt;
      pos[i * 3] = nx;
      pos[i * 3 + 1] = ny;
      pos[i * 3 + 2] = nz;
      sumX += nx;
      sumY += ny;
      sumZ += nz;

      // ここから見た目。進行方向を前、世界の上を仮の上として姿勢を組む
      fwd.set(vx, vy, vz).divideScalar(sp);
      right.crossVectors(fwd, UP);
      if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
      right.normalize();
      up.crossVectors(right, fwd).normalize();

      // 曲がる向き（速度と直交する力）の分だけ、内側へ傾ける
      const bank = clamp(-(ax * right.x + ay * right.y + az * right.z) * BANK, -1.1, 1.1);
      spin.setFromAxisAngle(fwd, bank);
      right.applyQuaternion(spin);
      up.applyQuaternion(spin);

      mBird.makeBasis(right, up, fwd);
      mBird.setPosition(nx, ny, nz);

      // 上昇中は深く、降りるときは浅く。滑空と羽ばたきが自然に交代する
      const lift = clamp(0.4 + vy / MAX_SPEED, 0, 1);
      const amp = 0.22 + FLAP_GAIN * lift;
      const p = (flap[i]! + dt * (FLAP_RATE + sp * 0.6)) % (Math.PI * 2);
      flap[i] = p;
      // 上反角の分だけ持ち上げておくと、伸ばしきった瞬間も V 字に見える
      const armBeat = 0.14 + Math.sin(p) * amp;
      // 手は上腕より遅れて、より大きく振れる。この差が翼のしなりになる
      const handBeat = 0.12 + Math.sin(p - 0.34) * amp * 1.25;
      // 打ち上げの間だけ、手を後ろへ畳む
      const sweep = 0.24 * clamp(Math.sin(p), 0, 1);

      scale.setScalar(size[i]!);
      const shimmer = Math.abs(up.dot(LIGHT));
      // 羽の面が光へ正対した瞬間だけ明るい。向きの揃った鳥が一斉に閃くので、
      // 群れの上を光の波が渡っていく
      ember(color, 0.46 + 0.4 * shimmer, d);
      bodyColor.copy(color).multiplyScalar(0.82); // 胴体は翼より一段落とす

      mOut.copy(mBird).scale(scale);
      body.setMatrixAt(i, mOut);
      body.setColorAt(i, bodyColor);

      for (let k = 0; k < SIDES.length; k++) {
        const dir = SIDES[k]!;
        const a = armBeat * dir;
        const ca = Math.cos(a);
        const sa = Math.sin(a);

        mLimb.makeRotationZ(a);
        mOut.multiplyMatrices(mBird, mLimb).scale(scale);
        armMesh[k]!.setMatrixAt(i, mOut);
        armMesh[k]!.setColorAt(i, color);

        // 手首は上腕と一緒に振れているので、その回った先へ手を置き直す
        const wx = WRIST.x * dir;
        mLimb.makeRotationZ(handBeat * dir);
        mSweep.makeRotationY(sweep * dir);
        mLimb.multiply(mSweep);
        mLimb.setPosition(wx * ca - WRIST.y * sa, wx * sa + WRIST.y * ca, WRIST.z);
        mOut.multiplyMatrices(mBird, mLimb).scale(scale);
        handMesh[k]!.setMatrixAt(i, mOut);
        handMesh[k]!.setColorAt(i, color);
      }
    }

    homeX = sumX / COUNT;
    homeY = sumY / COUNT;
    homeZ = sumZ / COUNT;

    for (const mesh of [body, ...armMesh, ...handMesh]) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  },

  sound(t, _dt, sfx) {
    // 空の低い唸り。気配が横切っている間だけ、風が少し強くなる
    sfx.drone(tone(-4), hawkOn ? 0.19 : 0.11);

    // 気配が入ってくる瞬間の、群れ全体が一度に翻る音
    for (let k = gust(t / HAWK_CYCLE + HAWK_OFFSET); k > 0; k--) {
      sfx.air({ gain: 0.55, decay: 2.4, freq: 620, q: 0.9, sweep: 0.35, pan: clamp(hawkX / SPHERE, -1, 1) });
    }

    // ふだんの羽音。遠くで一団が向きを変えたくらいの間隔で置く
    for (let k = wingBeat(t * 0.55); k > 0; k--) {
      sfx.air({ gain: 0.22, decay: 1.8, freq: 340, q: 1.6, sweep: 1.5, pan: clamp(homeX / SPHERE, -1, 1) });
    }
  },
};
