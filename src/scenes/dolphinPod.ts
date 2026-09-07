import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, ticker } from '../audio.ts';
import { ember, drift } from '../palette.ts';

/**
 * イルカの群れ（ポッド）。
 *
 * 他のシーンは形を時刻 t の式で決めているが、ここだけは毎フレームの積分でしか
 * 形が決まらない。1 頭が見ているのは近くの数頭だけで、
 *   分離 … 近すぎる仲間から離れる
 *   整列 … 近くの仲間と向きを揃える
 *   結合 … 近くの仲間の重心へ寄る
 * の 3 つしか決めていない。群れ全体の形は誰も決めていないのに、
 * うねりも密度のむらも勝手に立ち上がる。
 *
 * 空を飛ぶ群れとの違いは水の重さで出す。速さも舵の効きも鳥より鈍く、
 * 推進は羽ばたきではなく、尾柄と尾びれが遅れて連なる上下動で作る。
 */

/** 頭数。少なめにして、1 頭ずつの姿と尾の打ち下ろしが見える大きさで泳がせる。 */
const COUNT = 20;

/** 群れを閉じ込める球の半径と、その中心の深さ。 */
const SPHERE = 13;
const CENTER_Y = 4;

/** 回遊する輪の半径。群れが描く軌道の大きさ。 */
const COURSE = 4;
/** 群れ 1 塊の半径。ここから出た頭だけが重心へ引き戻される。 */
const POD_R = 4.8;
/** 上下方向だけ縮める率。ポッドは球ではなく、水平に広い帯になる。 */
const POD_FLAT = 2.2;

/** 仲間を見つける距離と、近すぎると判断する距離。胸びれが触れない間隔を取る。 */
const VIEW = 6;
const SEP = 3;
const VIEW2 = VIEW * VIEW;
const SEP2 = SEP * SEP;

/** 3 つの規則の重み。分離を一番強くしないと団子になる。 */
const W_SEP = 2;
const W_ALI = 1.15;
const W_COH = 0.6;
/** 群れから離れた頭を呼び戻す力と、回遊させる潮の流れ。 */
const W_HOME = 2.2;
const W_SWIRL = 1;
/** それでも球から出てしまった頭を戻す、最後の歯止め。 */
const W_BOUND = 2.4;
/** 気配から逃げる力。他をねじ伏せる強さでないと群れが割れない。 */
const W_FLEE = 5;

/** 泳ぐ速さの上下限と、1 フレームでかけられる力の上限。水の抵抗の分だけ鳥より鈍い。 */
const MAX_SPEED = 4.2;
const MIN_SPEED = 2.1;
const MAX_FORCE = 7;

/** 旋回の内側へ傾く量。速度と直交する加速度の大きさから決める。 */
const BANK = 0.26;

/** 尾を打つ速さ（rad/秒）と、速く泳ぐほど上がる分。 */
const BEAT_RATE = 4.6;
const BEAT_GAIN = 0.85;
/** 尾柄の振り幅と、尾びれがさらに振れる幅、そしてその遅れ。 */
const TAIL_AMP = 0.3;
const FLUKE_AMP = 0.3;
const FLUKE_LAG = 0.9;
/** 尾を振った反動で体幹が受ける、わずかな縦揺れ。 */
const RECOIL = 0.055;

/**
 * 見えない気配（大きな影のようなもの）が群れを横切る周期。
 * 姿は出さず、群れのよじれだけで存在を見せる。
 */
const SHADOW_CYCLE = 17;
/** 1 周のうち実際に横切っている割合 */
const SHADOW_SPAN = 0.32;
/** 位相のずらし。シーンを開いた直後は静かに、数秒おいてから最初の 1 回が来る。 */
const SHADOW_OFFSET = 0.62;
/** 気配を感じ取る半径と、通り抜ける距離 */
const SHADOW_R = 5;
const SHADOW_PATH = 24;

/** 水面から差す光。この向きへ背を向けた個体だけが濡れた照りを返す。 */
const LIGHT = new THREE.Vector3(8, 18, 10).normalize();

const pos = new Float32Array(COUNT * 3);
const vel = new Float32Array(COUNT * 3);
/** 個体ごとの大きさと、尾を打つ位相 */
const size = new Float32Array(COUNT);
const beat = new Float32Array(COUNT);

/** 体幹・尾柄・尾びれ・背びれと、左右の胸びれ。合わせて 6 回の描画で済む。 */
let body: THREE.InstancedMesh;
let stock: THREE.InstancedMesh;
let fluke: THREE.InstancedMesh;
let dorsal: THREE.InstancedMesh;
const pectoral: THREE.InstancedMesh[] = [];
/** pectoral の並び順に対応する左右。+1 が右。 */
const SIDES = [1, -1] as const;

const color = new THREE.Color();
const fwd = new THREE.Vector3();
const right = new THREE.Vector3();
const up = new THREE.Vector3();
const scale = new THREE.Vector3();
const spin = new THREE.Quaternion();
const mFish = new THREE.Matrix4();
const mBody = new THREE.Matrix4();
const mStock = new THREE.Matrix4();
const mJoint = new THREE.Matrix4();
const mOut = new THREE.Matrix4();
const UP = new THREE.Vector3(0, 1, 0);

/** いま計算中の 1 頭にかかっている力。steer() が足し込む。 */
let ax = 0;
let ay = 0;
let az = 0;

/**
 * 前フレームの群れの重心。
 *
 * 群れを 1 塊に保つ引力の中心であり、回遊の向きもここから決める。
 * 全員が同じ向きを共有するので、ポッドは散らばらずに塊のまま渡っていく。
 */
let homeX = COURSE;
let homeY = CENTER_Y;
let homeZ = 0;
/** 気配の位置。音の定位に使う。 */
let shadowX = 0;
let shadowOn = false;
/**
 * 気配が狙う点。1 回の通過が始まった瞬間の群れの重心を覚えておく。
 *
 * 毎フレーム重心を追わせると、逃げた先へ気配も動いてしまい追いかけっこになる。
 * 入り口で狙いを固定すれば、群れは横へ抜けてかわせる。
 */
let aimCycle = -1;
let aimX = COURSE;
let aimY = CENTER_Y;
let aimZ = 0;

let surge = ticker();
let whistle = ticker();

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

/**
 * 「その向きへ全速で泳ぎたい」という願いを、いまの速度との差＝力に直して足す。
 *
 * 差を取らずに向きをそのまま足すと、行き過ぎて振動する。上限をかけるのは
 * 1 頭が急に折れ曲がらないようにするため。
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
 * 平らな板を並べると魚の切り身に見えてしまうので、体はすべて「輪切りの断面を
 * 軸方向に並べた立体」で作る。断面の幅と厚みを少しずつ変えるだけで、
 * 吻から尾柄までの紡錘形も、付け根から先端への薄まりも 1 つの式で書ける。
 * ------------------------------------------------------------------ */

/** 断面 1 枚。中心が (x, y, z)、a と b はその断面の楕円の半径。 */
interface Ring {
  x: number;
  y: number;
  z: number;
  a: number;
  b: number;
}

/** 体軸に沿う断面。z が体の前後、a が横半径、b が縦半径。 */
const ring = (z: number, a: number, b: number, y = 0): Ring => ({ x: 0, y, z, a, b });
/** 立てたひれの断面。y が高さ、a が前後の翼弦、b が横の厚み。 */
const vane = (y: number, z: number, a: number, b: number): Ring => ({ x: 0, y, z, a, b });

/**
 * 断面を並べて閉じた立体にする。
 *
 * @param axis 断面を並べる方向。'z' なら断面は XY 平面（体幹）、
 *             'x' なら ZY 平面（胸びれ）、'y' なら ZX 平面（背びれ）。
 * @param tint 面の明るさ。null を渡すと断面の上下から作る。背が暗く腹が明るい、
 *             イルカのあの塗り分け（カウンターシェーディング）になる。
 */
function loft(
  rings: readonly Ring[],
  seg: number,
  axis: 'x' | 'y' | 'z',
  tint: number | null = null,
): THREE.BufferGeometry {
  const verts: number[] = [];
  const shade: number[] = [];
  const index: number[] = [];

  for (const r of rings) {
    for (let j = 0; j < seg; j++) {
      const th = (j / seg) * Math.PI * 2;
      const ca = Math.cos(th) * r.a;
      const sb = Math.sin(th) * r.b;
      if (axis === 'z') verts.push(r.x + ca, r.y + sb, r.z);
      else if (axis === 'x') verts.push(r.x, r.y + sb, r.z + ca);
      else verts.push(r.x + sb, r.y, r.z + ca);
      // sin(th) は断面の上（+1）から下（-1）。腹側だけを白く抜く
      const v = tint ?? Math.min(0.5 + 0.55 * Math.pow(0.5 - 0.5 * Math.sin(th), 1.6), 1);
      shade.push(v, v, v);
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
  g.setAttribute('color', new THREE.Float32BufferAttribute(shade, 3));
  g.setIndex(index);
  // 面ごとではなく頂点ごとの法線にすることで、稜線が出ずに丸く見える
  g.computeVertexNormals();
  return g;
}

/** 尾柄が体幹から折れる位置と、尾びれが尾柄から折れる位置。 */
const JOINT_Z = -0.4;
const FLUKE_Z = -1.02;

/**
 * 体幹の断面。吻 → メロン（丸い額）→ 胸 → いちばん太い胴 → 尾柄の付け根。
 * そこから先は細らせて、尾柄の肉の内側へ潜り込ませる（継ぎ目を隠すため）。
 */
const BODY_RINGS: readonly Ring[] = [
  ring(1.02, 0, 0),
  ring(0.94, 0.028, 0.026, -0.006),
  ring(0.84, 0.042, 0.04, -0.005),
  ring(0.72, 0.058, 0.055),
  ring(0.64, 0.098, 0.112, 0.014), // メロン。ここだけ急に膨らむ
  ring(0.5, 0.14, 0.152, 0.012),
  ring(0.3, 0.168, 0.184, 0.005),
  ring(0.08, 0.176, 0.194),
  ring(-0.16, 0.152, 0.172),
  ring(JOINT_Z, 0.112, 0.138),
  ring(-0.46, 0.075, 0.095),
  ring(-0.52, 0.04, 0.05),
  ring(-0.55, 0, 0),
];

/**
 * 尾柄。横に薄く縦に高い（a < b）のがイルカの尾の断面で、
 * この平たさがそのまま上下動の効きになる。先端は尾びれの内側へ潜らせる。
 */
const STOCK_RINGS: readonly Ring[] = [
  ring(JOINT_Z, 0, 0),
  ring(JOINT_Z, 0.122, 0.146),
  ring(-0.56, 0.092, 0.124),
  ring(-0.74, 0.068, 0.104),
  ring(-0.88, 0.052, 0.088),
  ring(FLUKE_Z, 0.042, 0.074),
  ring(-1.09, 0.026, 0.046),
  ring(-1.13, 0, 0),
];

/** 尾びれ。水平に大きく張り出し、上下には紙のように薄い。 */
const FLUKE_RINGS: readonly Ring[] = [
  ring(FLUKE_Z, 0, 0),
  ring(FLUKE_Z, 0.058, 0.066),
  ring(-1.08, 0.26, 0.032),
  ring(-1.18, 0.34, 0.024),
  ring(-1.3, 0.3, 0.017),
  ring(-1.4, 0.18, 0.012),
  ring(-1.47, 0, 0),
];

/** 背びれ。高いところほど翼弦が縮み、中心が後ろへ下がるので鎌形になる。 */
const DORSAL_RINGS: readonly Ring[] = [
  vane(0.1, -0.02, 0, 0),
  vane(0.1, -0.02, 0.21, 0.05),
  vane(0.22, -0.05, 0.185, 0.04),
  vane(0.34, -0.1, 0.14, 0.028),
  vane(0.44, -0.17, 0.09, 0.018),
  vane(0.52, -0.24, 0.04, 0.009),
  vane(0.55, -0.28, 0, 0),
];

/**
 * 胸びれの断面。u = 0 が付け根、1 が先端。
 *
 * 翼弦は付け根が最も広く、外へ行くほど細る。同時に断面の中心が後ろと下へ
 * 下がるので、前縁も後縁もそろって後退し、先の尖った鎌形の輪郭になる。
 */
function pectoralAt(u: number): Ring {
  const k = Math.max(1 - u, 0);
  return {
    x: 0.1 + u * 0.44,
    y: -0.05 - 0.17 * u * u,
    z: 0.16 - 0.3 * Math.pow(u, 1.4),
    a: 0.13 * Math.pow(k, 0.5) + 0.018,
    b: 0.028 * Math.pow(k, 1.3) + 0.003,
  };
}

/**
 * 断面をローカル座標へ移す。
 *
 * @param dir   +1 が右、-1 が左。x を反転するだけで左右が作れる。
 * @param baseZ 原点にしたい位置。尾柄と尾びれには、折れ曲がる関節を渡す。
 */
function toLocal(rings: readonly Ring[], dir: 1 | -1, baseZ = 0): Ring[] {
  return rings.map((r) => ({ x: r.x * dir, y: r.y, z: r.z - baseZ, a: r.a, b: r.b }));
}

/** 胸びれを刻んで、両端を潰して閉じる。付け根の蓋は体幹の肉の中に埋まる。 */
function pectoralGeometry(dir: 1 | -1): THREE.BufferGeometry {
  const rings: Ring[] = [];
  for (let i = 0; i <= 7; i++) rings.push(pectoralAt(i / 7));
  rings.unshift({ ...rings[0]!, a: 0, b: 0 });
  // 蓋をその場で閉じると切り落としたような平面が残る。先端だけは少し先へ置く
  rings.push({ ...pectoralAt(1.04), a: 0, b: 0 });
  return loft(toLocal(rings, dir), 8, 'x', 0.54);
}

function makeMesh(geo: THREE.BufferGeometry): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(
    geo,
    // 濡れた肌なので、鳥の羽よりつるりと光らせる
    new THREE.MeshStandardMaterial({ roughness: 0.32, metalness: 0.1, vertexColors: true }),
    COUNT,
  );
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false; // 群れが動き回るので、原点基準の境界球は当てにならない
  return mesh;
}

/** 暮れかけた海を、イルカの群れが形を変えながら渡っていく。 */
export const dolphinPod: SceneModule = {
  name: 'Dolphin Pod',
  desc: '一頭ずつは近くの数頭しか見ていないのに、群れはひとつの生きもののようにうねる。',
  // 群れの少し上へ視線を置くと、輪の手前側が下に垂れても画面の中に収まる
  camera: { pos: [0, 5.2, 14.5], target: [0, CENTER_Y + 0.6, 0] },

  build(root) {
    surge = ticker();
    whistle = ticker();

    let s = 0.4172;
    const rnd = (): number => (s = (s * 9301 + 0.49297) % 1);

    for (let i = 0; i < COUNT; i++) {
      // 最初から軌道上の 1 点に、縦をつぶした塊として置く。原点に置くと
      // 回遊の向き（重心から見た接線）が決まらず、動き出しがもたつく
      const a = rnd() * Math.PI * 2;
      const b = Math.acos(rnd() * 2 - 1);
      const r = Math.cbrt(rnd()) * POD_R;
      pos[i * 3] = COURSE + Math.sin(b) * Math.cos(a) * r;
      pos[i * 3 + 1] = CENTER_Y + (Math.cos(b) * r) / POD_FLAT;
      pos[i * 3 + 2] = Math.sin(b) * Math.sin(a) * r;

      // 初速はばらばらでよい。整列の規則が数秒で勝手に揃えてくれる
      const va = rnd() * Math.PI * 2;
      const vb = (rnd() - 0.5) * 0.9;
      const sp = MIN_SPEED + rnd() * (MAX_SPEED - MIN_SPEED);
      vel[i * 3] = Math.cos(va) * Math.cos(vb) * sp;
      vel[i * 3 + 1] = Math.sin(vb) * sp;
      vel[i * 3 + 2] = Math.sin(va) * Math.cos(vb) * sp;

      size[i] = 1.12 + rnd() * 0.5;
      beat[i] = rnd() * Math.PI * 2;
    }

    homeX = COURSE;
    homeY = CENTER_Y;
    homeZ = 0;
    aimCycle = -1;
    aimX = COURSE;
    aimY = CENTER_Y;
    aimZ = 0;

    body = makeMesh(loft(BODY_RINGS, 12, 'z'));
    stock = makeMesh(loft(toLocal(STOCK_RINGS, 1, JOINT_Z), 10, 'z'));
    fluke = makeMesh(loft(toLocal(FLUKE_RINGS, 1, FLUKE_Z), 10, 'z', 0.52));
    dorsal = makeMesh(loft(DORSAL_RINGS, 8, 'y', 0.5));
    root.add(body, stock, fluke, dorsal);

    pectoral.length = 0;
    for (const dir of SIDES) {
      const fin = makeMesh(pectoralGeometry(dir));
      pectoral.push(fin);
      root.add(fin);
    }
  },

  update(t, dt) {
    const d = drift(t);

    // 見えない気配。周回ごとに黄金角だけ向きを変えるので、同じ道を通らない
    const turn = t / SHADOW_CYCLE + SHADOW_OFFSET;
    const cycle = Math.floor(turn);
    const ph = turn - cycle;
    shadowOn = ph < SHADOW_SPAN;
    const u = ph / SHADOW_SPAN;
    if (cycle !== aimCycle) {
      aimCycle = cycle;
      aimX = homeX;
      aimY = homeY;
      aimZ = homeZ;
    }
    const ang = cycle * 2.399963;
    const along = (u - 0.5) * SHADOW_PATH;
    const hx = aimX + Math.cos(ang) * along;
    const hy = aimY + (u - 0.5) * 3;
    const hz = aimZ + Math.sin(ang) * along;
    shadowX = hx;

    /*
     * 群れが次に向かう向き。頭ごとではなく重心の位置から 1 度だけ決めて全員へ配る。
     * こうすると全員が同じ「潮」を受けるので、群れは輪に引き伸ばされず、
     * 塊のまま回遊していく。
     */
    const hr = Math.hypot(homeX, homeZ) || 1e-6;
    const inward = clamp((COURSE - hr) / 5, -1, 1); // 外にいれば内へ、内にいれば外へ
    const swirlX = -homeZ / hr + (homeX / hr) * inward;
    const swirlZ = homeX / hr + (homeZ / hr) * inward;
    // 深さは数十秒かけて上下する。浮上してくるときに群れが伸びる
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

      // 群れから離れた頭だけを重心へ呼び戻す。中にいる限り何もしないので、
      // 内側が詰まらず、塊のまま volume を保てる
      const hx0 = homeX - px;
      const hy0 = homeY - py;
      const hz0 = homeZ - pz;
      // 縦を詰めた距離で測るので、引き戻しは上下ほど早くかかる
      const hd = Math.hypot(hx0, hy0 * POD_FLAT, hz0);
      if (hd > POD_R) {
        steer(hx0, hy0, hz0, vx, vy, vz, W_HOME * Math.min((hd - POD_R) / 3, 1.5));
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

      if (shadowOn) {
        const fx = px - hx;
        const fy = py - hy;
        const fz = pz - hz;
        const fd = Math.hypot(fx, fy, fz);
        // 近い頭ほど強く逃げる。逃げた頭が仲間を押すので、驚きが波として伝わる
        if (fd < SHADOW_R) steer(fx, fy, fz, vx, vy, vz, W_FLEE * (1 - fd / SHADOW_R));
      }

      vx += ax * dt;
      vy += ay * dt;
      vz += az * dt;

      // イルカは止まらないし、沈みもしない。速さだけ範囲へ丸める
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
      // 右手系のまま組む。fwd × UP の順にすると基底が鏡像になり、
      // 面の裏表が反転して体の内側が見えてしまう
      right.crossVectors(UP, fwd);
      if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
      right.normalize();
      up.crossVectors(fwd, right).normalize();

      // 曲がる向き（速度と直交する力）の分だけ、内側へ傾ける
      const bank = clamp(-(ax * right.x + ay * right.y + az * right.z) * BANK, -1.1, 1.1);
      spin.setFromAxisAngle(fwd, bank);
      right.applyQuaternion(spin);
      up.applyQuaternion(spin);

      mFish.makeBasis(right, up, fwd);
      mFish.setPosition(nx, ny, nz);
      // 大きさは体を組み上げる前にかける。あとからかけると関節の位置だけ
      // 元の寸法のまま残り、大きい個体で尾が胴から浮く
      scale.setScalar(size[i]!);
      mFish.scale(scale);

      const p = (beat[i]! + dt * (BEAT_RATE + sp * BEAT_GAIN)) % (Math.PI * 2);
      beat[i] = p;
      // 尾柄が振れ、尾びれはそれに遅れてさらに振れる。この遅れが水を後ろへ蹴る
      const stockA = Math.sin(p) * TAIL_AMP;
      const flukeA = Math.sin(p - FLUKE_LAG) * FLUKE_AMP;
      // 打ち下ろしの反動で、体幹も逆向きにわずかに縦揺れする
      mJoint.makeRotationX(-Math.sin(p + 0.6) * RECOIL);
      mBody.multiplyMatrices(mFish, mJoint);

      // 濡れた背が水面の光へ向いた瞬間だけ明るい。向きの揃った群れが一斉に
      // 閃くので、ポッドの上を光の帯が渡っていく
      const shimmer = Math.abs(up.dot(LIGHT));
      ember(color, 0.46 + 0.38 * shimmer, d);

      body.setMatrixAt(i, mBody);
      body.setColorAt(i, color);
      dorsal.setMatrixAt(i, mBody);
      dorsal.setColorAt(i, color);
      for (let k = 0; k < SIDES.length; k++) {
        pectoral[k]!.setMatrixAt(i, mBody);
        pectoral[k]!.setColorAt(i, color);
      }

      // 尾柄は体幹の関節で、尾びれは振れた尾柄の先で、それぞれ回す
      mJoint.makeRotationX(stockA);
      mJoint.setPosition(0, 0, JOINT_Z);
      mStock.multiplyMatrices(mBody, mJoint);
      stock.setMatrixAt(i, mStock);
      stock.setColorAt(i, color);

      mJoint.makeRotationX(flukeA);
      mJoint.setPosition(0, 0, FLUKE_Z - JOINT_Z);
      mOut.multiplyMatrices(mStock, mJoint);
      fluke.setMatrixAt(i, mOut);
      fluke.setColorAt(i, color);
    }

    homeX = sumX / COUNT;
    homeY = sumY / COUNT;
    homeZ = sumZ / COUNT;

    for (const mesh of [body, stock, fluke, dorsal, ...pectoral]) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  },

  sound(t, _dt, sfx) {
    // 水の中の低い唸り。気配が横切っている間だけ、流れが少し強くなる
    sfx.drone(tone(-6), shadowOn ? 0.2 : 0.12);

    // 気配が入ってくる瞬間の、群れ全体が一度に翻る水音
    for (let k = surge(t / SHADOW_CYCLE + SHADOW_OFFSET); k > 0; k--) {
      sfx.air({ gain: 0.5, decay: 2.6, freq: 380, q: 0.8, sweep: 0.3, pan: clamp(shadowX / SPHERE, -1, 1) });
    }

    // ふだんの鳴き交わし。下から上へ滑る細い笛を、遠くで鳴っているように置く
    for (let k = whistle(t * 0.42); k > 0; k--) {
      // 音程も定位も時刻から決める。ticker と同じ拍を見ているので必ず揃う
      const step = Math.floor(t * 0.42);
      sfx.drop(tone(9 + (step % 3) + (step % 5 === 0 ? 2 : 0)), {
        gain: 0.3,
        decay: 1.1,
        bend: 0.45,
        pan: clamp((homeX + ((step % 7) - 3)) / SPHERE, -1, 1),
      });
    }
  },
};
