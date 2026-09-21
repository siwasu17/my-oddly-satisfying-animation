import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, ticker } from '../audio.ts';
import { SURFACE, emberColor } from '../palette.ts';

/**
 * 宙に浮いた 3×3×3 のキューブが、1 レイヤーずつ回る。
 * 溜めてから一息に回り、角がぴたりと揃って止まる——その決まり方が芯。
 *
 * 混ぜ方は固定シードの乱数で作る。開き直せば同じだが、1 周のあいだに 4 本の別の手順が走る。
 * 軸・レイヤー（外側 2 枚と中央）・向き・回す量（90°/180°/270°）がすべて振られる。
 *
 * 戻すときに来た道を逆再生しないために、手順を「位数 2 のブロック」で組んである。
 * ブロックは g・180°・g⁻¹ の形にしてあり、2 回続けて実行すると必ず元へ戻る。
 * だから混ぜが A B C なら、戻しは C B A ——
 * ブロックの並びが裏返るだけで、ブロックの中身は混ぜたときと同じ向きに進む。
 * さらに各ブロックは「90° の逆回し」を「270° の順回し」へ振り替えた別表現で回すので、
 * 同じブロックでも混ぜと戻しでは絵が違う。
 *
 * 面の色は 6 色ではなく暖色帯の 6 段階の濃淡（青を画面へ入れないため）。
 * カメラは少し斜め上から。手が決まった瞬間だけ pluck が 1 音鳴る。
 */

const CUBIE = 1.86; // 小立方体の一辺
const SPACING = 2.0; // 中心間の距離。差の 0.14 が溝になる
const STICKER = 1.64; // ステッカーの一辺。溝を細くして 3×3 の格子と色面を読ませる
const CENTER_Y = 3.6; // キューブの中心高さ。レイヤーが回っても角が床を割らない高さ
const HOLD = 0.18; // 各手の前後に入れる静止（秒）
const TURN_SEC = 0.75; // 90° を回しきるのにかける秒
const TURN_POW = 0.56; // 180°/270° を何倍の時間で回すか。1 未満なので大きく回すほど勢いが乗る
const PAUSE = 0.7; // 並びが揃ったところで置く余韻（秒）
const CYCLES = 4; // 1 ループに入れる「混ぜて戻す」の本数。それぞれ手順が違う
const SEED = 0x314159; // 手順を決める種。軸とレイヤーの散らばり、尺、混ざり具合を見て選んである
const SPIN = 0.05; // 全体がゆっくり流れる速さ（rad/s）
const TILT = 0.5; // 初期のヨー角。角が正面に来ないようずらす
const FLOOR_R = 11;
const GLOW = 0.02; // ステッカーだけをわずかに持ち上げる。上げすぎるとブルームで白く飛ぶ

/**
 * 面ごとの [ember の n, 色相のずらし]。6 色は青が入るので暖色帯の濃淡で区別する。
 * カメラから同時に見えるのは +X / +Y / +Z の 3 面なので、その 3 つを大きく離してある。
 */
const FACE_TONE: [number, number][] = [
  [0.72, 0.03], // +X 琥珀寄り。上限はここまで（ブルーム閾値 0.28 に触れさせない）
  [0.3, -0.02], // -X
  [0.46, 0.0], // +Y 上面。天井光を受けるぶん控えめにする
  [0.1, 0.02], // -Y
  [0.18, -0.03], // +Z 暗い薔薇
  [0.6, 0.01], // -Z
];

/** 面ごとの [軸, 符号, ステッカーの姿勢] */
const FACES: { ax: 0 | 1 | 2; sg: 1 | -1; rot: [number, number, number] }[] = [
  { ax: 0, sg: 1, rot: [0, Math.PI / 2, 0] },
  { ax: 0, sg: -1, rot: [0, -Math.PI / 2, 0] },
  { ax: 1, sg: 1, rot: [-Math.PI / 2, 0, 0] },
  { ax: 1, sg: -1, rot: [Math.PI / 2, 0, 0] },
  { ax: 2, sg: 1, rot: [0, 0, 0] },
  { ax: 2, sg: -1, rot: [0, Math.PI, 0] },
];

const AXES = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];

// #region gen
type Axis = 0 | 1 | 2;
type Layer = -1 | 0 | 1;

/** 1 手。q は 90° を単位にした符号付きの回す量（±1 / ±2 / ±3） */
type Move = { axis: Axis; layer: Layer; q: number };

/** 固定シードの擬似乱数。Math.random() だと開き直すたびに手順が変わってしまう。 */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let x = s;
    x = Math.imul(x ^ (x >>> 16), 0x21f0aaad);
    x = Math.imul(x ^ (x >>> 15), 0x735a2d97);
    x ^= x >>> 15;
    return (x >>> 0) / 4294967296;
  };
}

/** 直前と違う軸を選ぶ。同じ軸が続くと 2 手が 1 手にまとまって見えてしまう。 */
function pickAxis(rnd: () => number, avoid: number): Axis {
  const r = Math.floor(rnd() * (avoid < 0 ? 3 : 2));
  return (avoid < 0 ? r : (avoid + 1 + r) % 3) as Axis;
}

/** 外側 2 枚と中央。中央は回っても輪郭が変わらないので、出る割合を少し下げてある。 */
function pickLayer(rnd: () => number): Layer {
  const r = rnd();
  return r < 0.38 ? -1 : r < 0.74 ? 1 : 0;
}

/**
 * 2 回続けて実行すると必ず元へ戻る手順（位数 2）を作る。
 *
 * 芯にあるのは 180°。それ自体が 2 回で戻るので、前に g を、後ろに g の巻き戻しを置いた
 * (g h g⁻¹)(g h g⁻¹) = g h h g⁻¹ = g g⁻¹ = 何もしないのと同じ、という組み方になる。
 * この性質のおかげで、戻しの手順をブロック単位の並べ替えだけで作れる。
 *
 * wide にすると芯を同じ軸の 2 枚にする。互いに可換でどちらも 2 回で戻るので性質は変わらず、
 * 1 ブロックで動く小立方体がほぼ倍になる——つまり、少ない手数でよく混ざる。
 */
function block(rnd: () => number, glen: number, wide: boolean): Move[] {
  const g: Move[] = [];
  let prev = -1;
  for (let i = 0; i < glen; i++) {
    const ax = pickAxis(rnd, prev);
    g.push({ axis: ax, layer: pickLayer(rnd), q: rnd() < 0.5 ? 1 : -1 });
    prev = ax;
  }

  const ax = pickAxis(rnd, prev);
  const layer = pickLayer(rnd);
  const h: Move[] = [{ axis: ax, layer, q: rnd() < 0.5 ? 2 : -2 }];
  if (wide) {
    const rest = ([-1, 0, 1] as Layer[]).filter((l) => l !== layer);
    h.push({ axis: ax, layer: rest[rnd() < 0.5 ? 0 : 1], q: rnd() < 0.5 ? 2 : -2 });
  }

  const back = g
    .slice()
    .reverse()
    .map((m): Move => ({ ...m, q: -m.q }));
  return [...g, ...h, ...back];
}

/**
 * 結果を変えずに回し方だけを振り替える。
 * 90° の逆回しは 270° の順回しと同じところへ着くが、絵はまるで違う。
 * 同じ軸の別レイヤーどうしは順番を入れ替えても結果が変わらないので、そこも混ぜる。
 */
function variant(src: Move[], rnd: () => number): Move[] {
  const out = src.map((m): Move => ({ ...m }));
  for (const m of out) {
    if (Math.abs(m.q) === 1 && rnd() < 0.3) m.q = m.q > 0 ? -3 : 3;
  }
  for (let i = 0; i + 1 < out.length; i++) {
    const a = out[i]!;
    const b = out[i + 1]!;
    if (a.axis === b.axis && a.layer !== b.layer && rnd() < 0.5) {
      out[i] = b;
      out[i + 1] = a;
    }
  }
  return out;
}

/**
 * 「混ぜて戻す」1 本。混ぜが A B C なら戻しは C B A。
 * 末尾の C は 180° 1 手だけのブロックなので、折り返しでは同じレイヤーが 180° ずつ
 * 2 回回る——つまりぐるりと一周する。ここが混ざりきった山になる。
 */
function cycle(rnd: () => number): Move[] {
  const blocks = [block(rnd, 2, true), block(rnd, 1, false), block(rnd, 0, false)];
  const mix = blocks.flatMap((b) => variant(b, rnd));
  const back = blocks
    .slice()
    .reverse()
    .flatMap((b) => variant(b, rnd));
  return [...mix, ...back];
}

const MOVES: Move[] = [];
/** その手で並びが揃う（1 本の終わり）かどうか */
const AT_END: boolean[] = [];
{
  const rnd = rng(SEED);
  for (let c = 0; c < CYCLES; c++) {
    const one = cycle(rnd);
    one.forEach((m, i) => {
      MOVES.push(m);
      AT_END.push(i === one.length - 1);
    });
  }
}

/** 各手の開始時刻と、回している最中の秒数。回す量が多い手ほど長く回す。 */
const START: number[] = [];
const SPAN: number[] = [];
let TOTAL = 0;
MOVES.forEach((m, i) => {
  START.push(TOTAL);
  const span = TURN_SEC * Math.pow(Math.abs(m.q), TURN_POW);
  SPAN.push(span);
  TOTAL += HOLD * 2 + span + (AT_END[i] ? PAUSE : 0);
});

/** 中心を除く 26 個の論理座標 */
const CELLS: [number, number, number][] = [];
for (let x = -1; x <= 1; x++) {
  for (let y = -1; y <= 1; y++) {
    for (let z = -1; z <= 1; z++) {
      if (x !== 0 || y !== 0 || z !== 0) CELLS.push([x, y, z]);
    }
  }
}
const N = CELLS.length;

/**
 * 各手の「開始時点」の姿勢を先に全部作っておく。
 * update は t から手番号を引いて、その状態に進行中の回転を足すだけになる（差分を積まない）。
 */
const STATE_POS: Float32Array[] = [];
const STATE_QUAT: Float32Array[] = [];
{
  const pos = new Float32Array(N * 3);
  const quat = new Float32Array(N * 4);
  CELLS.forEach((c, i) => {
    pos[i * 3] = c[0];
    pos[i * 3 + 1] = c[1];
    pos[i * 3 + 2] = c[2];
    quat[i * 4 + 3] = 1;
  });

  const v = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const qm = new THREE.Quaternion();
  for (const m of MOVES) {
    STATE_POS.push(pos.slice());
    STATE_QUAT.push(quat.slice());
    qm.setFromAxisAngle(AXES[m.axis], (m.q * Math.PI) / 2);
    for (let i = 0; i < N; i++) {
      if (Math.round(pos[i * 3 + m.axis]) !== m.layer) continue;
      v.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]).applyQuaternion(qm);
      pos[i * 3] = Math.round(v.x);
      pos[i * 3 + 1] = Math.round(v.y);
      pos[i * 3 + 2] = Math.round(v.z);
      q.set(quat[i * 4], quat[i * 4 + 1], quat[i * 4 + 2], quat[i * 4 + 3]).premultiply(qm);
      quat[i * 4] = q.x;
      quat[i * 4 + 1] = q.y;
      quat[i * 4 + 2] = q.z;
      quat[i * 4 + 3] = q.w;
    }
  }
}
// #endregion

/** ループ内の時刻 tt がどの手に属するか */
function indexAt(tt: number): number {
  let lo = 0;
  let hi = MOVES.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (START[mid] <= tt) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** 静止を挟んだあとの smootherstep。溜めてから一息に回る */
function ease(u: number): number {
  const p = u < 0 ? 0 : u > 1 ? 1 : u;
  return p * p * p * (p * (p * 6 - 15) + 10);
}

const qLayer = new THREE.Quaternion();
const qBase = new THREE.Quaternion();
const vBase = new THREE.Vector3();

let pivot: THREE.Group;
let cubies: THREE.Group[] = [];
let tick = ticker();
let turn = 0;

export const rubiksCube: SceneModule = {
  name: 'Rubiks Cube',
  desc: '毎回ちがう向きに混ざって、来た道とは別の回し方で揃っていく立方体。',
  // 方位を振って 3 面目を薄く見せ、注視点をキューブより下へ置いて浮いて見せる
  camera: { pos: [9.5, 7.5, 10.9], target: [0, 2.9, 0] },

  build(root) {
    tick = ticker();
    turn = 0;

    pivot = new THREE.Group();
    pivot.position.y = CENTER_Y;
    root.add(pivot);

    const body = new THREE.BoxGeometry(CUBIE, CUBIE, CUBIE);
    const bodyMat = new THREE.MeshStandardMaterial({
      color: SURFACE,
      roughness: 0.62,
      metalness: 0.3,
    });
    const sticker = new THREE.PlaneGeometry(STICKER, STICKER);
    const stickerMats = FACE_TONE.map(
      ([n, shift]) =>
        new THREE.MeshStandardMaterial({
          color: emberColor(n, shift, GLOW),
          roughness: 0.34,
          metalness: 0.22,
        }),
    );

    cubies = CELLS.map((cell) => {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(body, bodyMat));

      FACES.forEach((f, i) => {
        if (cell[f.ax] !== f.sg) return; // 外を向いている面にだけ貼る
        const s = new THREE.Mesh(sticker, stickerMats[i]);
        s.rotation.set(f.rot[0], f.rot[1], f.rot[2]);
        s.position.setComponent(f.ax, f.sg * (CUBIE / 2 + 0.012));
        g.add(s);
      });

      pivot.add(g);
      return g;
    });

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(FLOOR_R, 96),
      // 粗めにして、リムライトが床で鋭い光点にならないようにする（主役より明るくしない）
      new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.58, metalness: 0.68 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.02;
    root.add(floor);
  },

  update(t) {
    pivot.rotation.y = TILT + t * SPIN;

    const tt = t % TOTAL;
    const k = indexAt(tt);
    const m = MOVES[k];
    const pos = STATE_POS[k];
    const quat = STATE_QUAT[k];
    const e = ease((tt - START[k] - HOLD) / SPAN[k]);
    qLayer.setFromAxisAngle(AXES[m.axis], (e * m.q * Math.PI) / 2);

    for (let i = 0; i < N; i++) {
      vBase.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
      qBase.set(quat[i * 4], quat[i * 4 + 1], quat[i * 4 + 2], quat[i * 4 + 3]);
      if (Math.round(vBase.getComponent(m.axis)) === m.layer) {
        vBase.applyQuaternion(qLayer);
        qBase.premultiply(qLayer);
      }
      const c = cubies[i];
      c.position.copy(vBase).multiplyScalar(SPACING);
      c.quaternion.copy(qBase);
    }
  },

  sound(t, _dt, sfx) {
    // 決まった手の通し番号を位相として渡す。手ごとに長さが違うので割り算では出せない
    const loop = Math.floor(t / TOTAL);
    const tt = t - loop * TOTAL;
    const k = indexAt(tt);
    const done = tt >= START[k] + HOLD + SPAN[k] ? 1 : 0;

    for (let n = tick(loop * MOVES.length + k + done + 0.5); n > 0; n--) {
      const i = turn % MOVES.length;
      const m = MOVES[i];
      turn++;
      sfx.pluck(tone(4 + (i % 5)), { gain: 0.28, decay: 1.9, pan: m.layer * 0.35 });
      // 並びが揃ったところだけ、上に 2 音重ねて区切りにする
      if (AT_END[i]) {
        sfx.pluck(tone(9), { gain: 0.26, decay: 3.6, pan: -0.2 });
        sfx.pluck(tone(12), { gain: 0.18, decay: 3.6, pan: 0.2 });
      }
    }
  },
};
