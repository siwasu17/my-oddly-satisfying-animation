import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, tickers } from '../audio.ts';
import { ember, emberColor, drift } from '../palette.ts';

/**
 * 何が動くか: 同じ大きさの盤が 5 枚、広い間隔をあけて真上に積まれている。無地の立方体が
 *   盤の上を辺を軸にコトンと倒れて気まぐれな隣のマスへ移り、4〜6 手で立ち止まる。
 *   止まった立方体はその場で盤に沈み、暗がりをゆっくり通って、一段下の盤の同じ位置へ
 *   降りてくる。最下段まで降りたものは暗がりを抜けて最上段の上から戻ってくる。
 * 気持ちよさの芯: 立方体が辺で持ち上がって落ちる「間」と、次にどっちへ行くか読めないこと。
 *   段ごとに別の立方体が別の位相で歩いているので、視線をどこへ置いても何かが動いている。
 * ループの周期: 1 手 0.95〜1.4 秒、1 段あたり 4〜6 手。一段下りるのに 1.9 秒。
 *   1 個が 5 段を降りて戻るまで 34〜62 秒。区画ごとに歩幅も手数も違うので位相は揃わない。
 * カメラ: 水平から 28 度の斜俯瞰。段と段の空きから 5 枚すべての盤面が見える角度。
 * 音: 沈み始めに drop、下の盤へ着いたときに pluck（区画の半分だけ）。段が下がるほど音程が低い。
 * スコープ外: サイコロの目、立方体同士の衝突（各自 3x3 の区画を縦に貫く柱の中だけを歩く）。
 */

// ---- 調整する数値 ----
const TIERS = 5; // 盤の枚数
const GAP = 4.2; // 盤と盤の間隔。広く空けて段の間から奥を見せる
const BLOCKS_X = 3; // 横の区画数
const BLOCKS_Z = 2; // 奥行きの区画数。1 段に載る立方体は BLOCKS_X * BLOCKS_Z 個
const ROOM = 3; // 区画の一辺のマス数。この中だけを歩くので互いに重ならない
const CELL = 1.35; // マスの一辺
const DIE = CELL; // 立方体の一辺。マス目と同じにしないと転がりが 1 マスぶんにならない
const TILE = CELL * 0.94; // 盤のタイル。マスより少しだけ小さくして目地を作る
const TILE_H = 0.26; // 盤の厚み
const ROLL_FRAC = 0.4; // 1 手のうち転がりに使う割合（残りは静止して「間」になる）
const STEP_MIN = 0.95; // 1 手の秒数
const STEP_VAR = 0.45;
const MOVES_MIN = 4; // 立ち止まるまでの手数
const MOVES_VAR = 3;
const SINK = 1.9; // 一段下りるのにかける秒数
const FADE = 0.46; // 沈み込みのうち、いちばん暗くなるまでの割合。ここを 0.5 に近づけるほど暗い間が短い
const BACKTRACK = 0.16; // 来た道をそのまま引き返す確率
const BODY_N = 0.42; // 立方体の色
const BODY_VAR = 0.14;
const TILE_N = 0.032; // 盤のタイルの色。暗く沈めて、上に載る立方体だけを見せる
const TILE_VAR = 0.04;
const EDGE_N = 0.15; // 盤の外周のライン
const DARK = -0.26; // 沈むときに落とす明度。消しきらず、暗がりを降りる影が残る程度にする
const VOICED = 2; // 何区画に 1 つ音を鳴らすか

const BLOCKS = BLOCKS_X * BLOCKS_Z;
const LANES = TIERS + 1; // 5 段ぶん + 暗がりを通って最上段へ戻る区間
const COUNT = BLOCKS * LANES;
const CELLS_X = BLOCKS_X * ROOM;
const CELLS_Z = BLOCKS_Z * ROOM;
const SPAN_X = CELLS_X * CELL;
const SPAN_Z = CELLS_Z * CELL;
const STACK_H = (TIERS - 1) * GAP;

/** 段 k の盤の上面の高さ。0 が最上段。 */
const tierY = (k: number): number => (TIERS - 1 - k) * GAP;
/** マス番号を盤の中心を原点とする座標へ。 */
const gridX = (c: number): number => (c - (CELLS_X - 1) / 2) * CELL;
const gridZ = (r: number): number => (r - (CELLS_Z - 1) / 2) * CELL;

/** 1 区画の 1 段ぶん。歩く経路と、そこで取る姿勢をすべて build で決めておく。 */
interface Tier {
  sc: number; // 降りてきたマス（歩き出し）
  sr: number;
  ec: number; // 立ち止まるマス。ここで盤に沈む
  er: number;
  dx: Int8Array; // 各手の進む向き
  dz: Int8Array;
  quats: THREE.Quaternion[]; // 各手の開始姿勢。最後の 1 つは立ち止まったときの姿勢
}

/** 1 区画。ここに属する立方体は同じ手数・同じ歩幅で、位相だけがずれている。 */
interface Block {
  n: number; // 本体の色
  moves: number; // 立ち止まるまでの手数
  step: number; // 1 手の秒数
  seg: number; // 1 段にかかる秒数（転がり + 沈み込み）
  off: number; // 区画ごとの位相オフセット
  note: number;
  voiced: boolean; // 音を鳴らす区画か
  tiers: Tier[];
}

const blocks: Block[] = [];

const dummy = new THREE.Object3D();
const color = new THREE.Color();
const turn = new THREE.Quaternion();
const pose = new THREE.Quaternion();
const axis = new THREE.Vector3();
const rel = new THREE.Vector3();

let body: THREE.InstancedMesh;
let sinkTicks: ((phase: number) => number)[] = [];
let landTicks: ((phase: number) => number)[] = [];

const DIRS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

const smooth = (x: number): number => x * x * (3 - 2 * x);
const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
/** 盤の左右どちらで鳴ったか。 */
const panAt = (x: number): number => (x / (SPAN_X * 0.5)) * 0.7;

/**
 * 沈み込みのあいだの暗さ（0 = そのまま、1 = いちばん暗い）。
 * 盤をくぐるところを見せたくないので降り始めですぐ暗くし、下の盤へ着く手前で戻す。
 * 消しきらずに影を残すので、段と段のあいだを降りていくのは見える。
 */
function veil(e: number): number {
  if (e < FADE) return smooth(e / FADE);
  if (e > 1 - FADE) return smooth((1 - e) / FADE);
  return 1;
}

/** 固定シードの乱数（mulberry32）。歩き方を決めるので、質の悪い LCG だと癖が出る。 */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = Math.imul(s ^ (s >>> 15), 1 | s);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 1 区画ぶんの経路を作る。区画内の 3x3 を縦に貫く柱の中だけで完結するので、
 * 他の区画の立方体と重なることはない。
 */
function buildBlocks(): void {
  const rnd = makeRng(0x51ced1ce);
  const step = new THREE.Quaternion();
  const open: (readonly [number, number])[] = [];
  const fwd: (readonly [number, number])[] = [];
  blocks.length = 0;

  for (let bj = 0; bj < BLOCKS_Z; bj++) {
    for (let bi = 0; bi < BLOCKS_X; bi++) {
      const c0 = bi * ROOM; // 区画の左奥のマス
      const r0 = bj * ROOM;
      const moves = MOVES_MIN + Math.floor(rnd() * MOVES_VAR);
      const walk = STEP_MIN + rnd() * STEP_VAR;
      const b: Block = {
        n: BODY_N + rnd() * BODY_VAR,
        moves,
        step: walk,
        seg: moves * walk + SINK,
        off: rnd() * 90,
        note: 6 + (blocks.length % 5),
        voiced: blocks.length % VOICED === 0,
        tiers: [],
      };

      // 旅の開始姿勢。段をまたいで姿勢を積み上げ、最後に暗がりで戻す
      let carry = new THREE.Quaternion();
      let sc = c0 + Math.floor(rnd() * ROOM);
      let sr = r0 + Math.floor(rnd() * ROOM);

      for (let k = 0; k < TIERS; k++) {
        const dx = new Int8Array(moves);
        const dz = new Int8Array(moves);
        const quats: THREE.Quaternion[] = [carry.clone()];
        let c = sc;
        let r = sr;

        for (let m = 0; m < moves; m++) {
          // 区画から出ない向きを集める。引き返しは別枠にして、たまにだけ混ぜる
          open.length = 0;
          fwd.length = 0;
          for (const dir of DIRS) {
            const nc = c + dir[0];
            const nr = r + dir[1];
            if (nc < c0 || nc >= c0 + ROOM || nr < r0 || nr >= r0 + ROOM) continue;
            open.push(dir);
            if (m === 0 || dir[0] !== -dx[m - 1]! || dir[1] !== -dz[m - 1]!) fwd.push(dir);
          }
          const pool = fwd.length > 0 && rnd() > BACKTRACK ? fwd : open;
          const dir = pool[Math.floor(rnd() * pool.length)]!;

          dx[m] = dir[0];
          dz[m] = dir[1];
          c += dir[0];
          r += dir[1];
          axis.set(dir[1], 0, -dir[0]);
          step.setFromAxisAngle(axis, Math.PI / 2);
          quats.push(quats[m]!.clone().premultiply(step));
        }

        b.tiers.push({ sc, sr, ec: c, er: r, dx, dz, quats });
        carry = quats[moves]!.clone();
        sc = c; // 真下へ降りるので、次の段は同じマスから歩き出す
        sr = r;
      }
      blocks.push(b);
    }
  }
}

/**
 * 区間 seg の途中（f = 0..1）の姿勢と位置を dummy に置く。戻り値は明度の加算。
 * seg が TIERS のときは、最下段を抜けて暗がりを通り、最上段の上へ戻る区間。
 */
function place(b: Block, seg: number, f: number): number {
  const half = DIE * 0.5;

  if (seg < TIERS) {
    const tier = b.tiers[seg]!;
    const rollT = b.moves * b.step;
    const tt = f * b.seg;

    if (tt < rollT) {
      const m = Math.min(b.moves - 1, Math.floor(tt / b.step));
      const e = smooth(clamp01((tt - m * b.step) / b.step / ROLL_FRAC));
      let c = tier.sc;
      let r = tier.sr;
      for (let i = 0; i < m; i++) {
        c += tier.dx[i]!;
        r += tier.dz[i]!;
      }
      const ux = tier.dx[m]!;
      const uz = tier.dz[m]!;
      // 倒れる先の辺を回転の中心にして、そのまわりに立方体を振る
      axis.set(uz, 0, -ux);
      turn.setFromAxisAngle(axis, (e * Math.PI) / 2);
      rel.set(-ux * half, half, -uz * half).applyQuaternion(turn);
      dummy.position.set(
        gridX(c) + ux * half + rel.x,
        tierY(seg) + rel.y,
        gridZ(r) + uz * half + rel.z,
      );
      dummy.quaternion.copy(tier.quats[m]!).premultiply(turn);
      return 0;
    }

    // 立ち止まったマスで盤へ沈み、一段下の同じ位置へ降りてくる
    const e = clamp01((tt - rollT) / SINK);
    dummy.position.set(gridX(tier.ec), tierY(seg) + half - GAP * smooth(e), gridZ(tier.er));
    dummy.quaternion.copy(tier.quats[b.moves]!);
    if (seg < TIERS - 1) return DARK * veil(e);
    // 最下段には下の盤が無い。盤をくぐったあとは影も残さず暗がりへ沈めきる
    return (
      DARK * smooth(clamp01(e / FADE)) +
      (-1 - DARK) * smooth(clamp01((e - FADE) / (1 - FADE)))
    );
  }

  // 最下段を抜けたあと。暗がりを降りきってから、最上段の上へ戻る
  const last = b.tiers[TIERS - 1]!;
  const first = b.tiers[0]!;
  if (f < 0.42) {
    const e = f / 0.42;
    dummy.position.set(
      gridX(last.ec),
      tierY(TIERS - 1) + half - GAP - GAP * 0.8 * smooth(e),
      gridZ(last.er),
    );
    dummy.quaternion.copy(last.quats[b.moves]!);
    return -1;
  }
  const e = (f - 0.42) / 0.58;
  dummy.position.set(gridX(first.sc), tierY(0) + half + GAP * (1 - smooth(e)), gridZ(first.sr));
  // 暗がりにいるうちに、歩き出しの姿勢へ戻しておく
  pose.copy(last.quats[b.moves]!).slerp(first.quats[0]!, smooth(clamp01(e / 0.55)));
  dummy.quaternion.copy(pose);
  // 最上段へ近づくにつれ、暗がりから元の明るさへ戻す
  return -1 + smooth(clamp01((e - 0.2) / 0.55));
}

export const diceField: SceneModule = {
  name: 'Dice Field',
  desc: '5 枚の盤が間を空けて積まれている。立方体は盤を歩き、立ち止まったところで一段下へ降りる。',
  camera: { pos: [11, 25, 27.6], target: [0, STACK_H * 0.55, 0] },

  build(root) {
    buildBlocks();
    sinkTicks = tickers(COUNT);
    landTicks = tickers(COUNT);

    // ---- 盤。マスごとのタイルにして、目地で格子を見せる ----
    const tiles = new THREE.InstancedMesh(
      new THREE.BoxGeometry(TILE, TILE_H, TILE),
      new THREE.MeshStandardMaterial({ roughness: 0.82, metalness: 0.12 }),
      TIERS * CELLS_X * CELLS_Z,
    );
    const rnd = makeRng(0x7a1de5);
    let i = 0;
    for (let k = 0; k < TIERS; k++) {
      for (let r = 0; r < CELLS_Z; r++) {
        for (let c = 0; c < CELLS_X; c++) {
          dummy.position.set(gridX(c), tierY(k) - TILE_H * 0.5, gridZ(r));
          dummy.quaternion.identity();
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          tiles.setMatrixAt(i, dummy.matrix);
          tiles.setColorAt(i, emberColor(TILE_N + rnd() * TILE_VAR));
          i++;
        }
      }
    }
    root.add(tiles);

    // ---- 盤の外周。上下 2 本引いて、板に厚みがあることを見せる ----
    const edge: number[] = [];
    const hx = SPAN_X * 0.5;
    const hz = SPAN_Z * 0.5;
    for (let k = 0; k < TIERS; k++) {
      const y = tierY(k) + 0.012;
      const yb = tierY(k) - TILE_H;
      for (const [x0, z0, x1, z1] of [
        [-hx, -hz, hx, -hz],
        [hx, -hz, hx, hz],
        [hx, hz, -hx, hz],
        [-hx, hz, -hx, -hz],
      ] as const) {
        edge.push(x0, y, z0, x1, y, z1);
        edge.push(x0, yb, z0, x1, yb, z1);
      }
    }
    const edgeGeo = new THREE.BufferGeometry();
    edgeGeo.setAttribute('position', new THREE.Float32BufferAttribute(edge, 3));
    root.add(
      new THREE.LineSegments(
        edgeGeo,
        new THREE.LineBasicMaterial({
          color: emberColor(EDGE_N),
          transparent: true,
          opacity: 0.5,
        }),
      ),
    );

    // ---- 立方体 ----
    body = new THREE.InstancedMesh(
      new THREE.BoxGeometry(DIE, DIE, DIE),
      new THREE.MeshStandardMaterial({ roughness: 0.46, metalness: 0.26 }),
      COUNT,
    );
    body.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    root.add(body);
  },

  update(t) {
    const shift = drift(t);
    dummy.scale.set(1, 1, 1);
    for (let i = 0; i < COUNT; i++) {
      const b = blocks[i % BLOCKS]!;
      const lane = Math.floor(i / BLOCKS); // 同じ区画の中で 1 段ぶんずつ位相をずらす
      const p = (t + b.off) / b.seg + lane;
      const seg = ((Math.floor(p) % LANES) + LANES) % LANES;
      const glow = place(b, seg, p - Math.floor(p));

      dummy.updateMatrix();
      body.setMatrixAt(i, dummy.matrix);
      ember(color, b.n, shift, glow);
      body.setColorAt(i, color);
    }
    body.instanceMatrix.needsUpdate = true;
    if (body.instanceColor) body.instanceColor.needsUpdate = true;
  },

  sound(t, _dt, sfx) {
    for (let i = 0; i < COUNT; i++) {
      const b = blocks[i % BLOCKS]!;
      if (!b.voiced) continue;
      const lane = Math.floor(i / BLOCKS);
      const p = (t + b.off) / b.seg + lane;
      const rollT = (b.moves * b.step) / b.seg;

      // 立ち止まって沈み始める瞬間
      for (let n = sinkTicks[i]!(p - rollT); n > 0; n--) {
        const seg = ((Math.floor(p - rollT) % LANES) + LANES) % LANES;
        if (seg >= TIERS) continue;
        const tier = b.tiers[seg]!;
        sfx.drop(tone(b.note - 6 - seg), {
          gain: 0.19,
          decay: 0.7,
          pan: panAt(gridX(tier.ec)),
        });
      }
      // 下の盤へ降り着いた瞬間。段が下がるほど低く鳴らす
      for (let n = landTicks[i]!(p); n > 0; n--) {
        const seg = ((Math.floor(p) % LANES) + LANES) % LANES;
        if (seg === 0 || seg > TIERS - 1) continue;
        const tier = b.tiers[seg]!;
        sfx.pluck(tone(b.note - seg), {
          gain: 0.2,
          decay: 1.4,
          pan: panAt(gridX(tier.sc)),
        });
      }
    }
  },
};
