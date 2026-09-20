import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, tickers } from '../audio.ts';
import { ember, emberColor, drift } from '../palette.ts';

/**
 * 何が動くか: 同じ大きさの盤が 5 枚、広い間隔をあけて真上に積まれている。各盤には
 *   いくつか穴が開いていて、サイコロは盤の上を辺で倒れながら気まぐれに歩き、
 *   穴にたどり着くと一段下の盤へ落ちる。落ちながら 1 回転するので着地で出目が変わる。
 *   最下段の穴を抜けたサイコロは暗がりへ消え、しばらくして最上段の上から降ってくる。
 * 気持ちよさの芯: コトンと倒れて歩く「間」と、穴の縁で姿勢が傾いて落ちる瞬間。
 *   どの穴へ向かうか、どの向きに倒れるかが読めない。段ごとに別のサイコロが
 *   別の位相で歩いているので、視線をどこへ置いても何かが落ちている。
 * ループの周期: 1 手 0.62〜0.95 秒、1 段あたり 5〜7 手。1 個が 5 段を降りて戻るまで 24〜45 秒。
 *   同じ区画のサイコロは 1 段ぶんずつ位相がずれているので、常にどの段にも 1 個ずつ居る。
 * カメラ: 水平から 28 度の斜俯瞰。段と段の空きから 5 枚すべての盤面が見える角度。
 * 音: 落ち始めに drop、下の盤への着地に pluck（区画の 1/3 だけ）。段が下がるほど音程が低い。
 * スコープ外: サイコロ同士の衝突（各自 3x3 の区画を縦に貫く柱の中だけを歩くので重ならない）。
 */

// ---- 調整する数値 ----
const TIERS = 5; // 盤の枚数
const GAP = 3.5; // 盤と盤の間隔。広く空けて段の間から奥を見せる
const BLOCKS_X = 4; // 横の区画数
const BLOCKS_Z = 3; // 奥行きの区画数
const ROOM = 3; // 区画の一辺のマス数。この中だけを歩くので互いに重ならない
const CELL = 1.12; // マスの一辺
const DIE = CELL; // 立方体の一辺。マス目と同じにしないと転がりが 1 マスぶんにならない
const TILE = CELL * 0.94; // 盤のタイル。マスより少しだけ小さくして目地を作る
const TILE_H = 0.26; // 盤の厚み
const ROLL_FRAC = 0.46; // 1 手のうち転がりに使う割合（残りは静止して「間」になる）
const STEP_MIN = 0.62; // 1 手の秒数
const STEP_VAR = 0.33;
const MOVES_MIN = 5; // 1 段を歩く手数
const MOVES_VAR = 3;
const FALL = 0.86; // 落下にかける秒数
const TOUCH = 0.74; // 落下のうち着地までの割合。残りがバウンド
const BOUNCE = 0.075; // 落差に対するバウンドの高さ
const BACKTRACK = 0.16; // 来た道をそのまま引き返す確率
const BODY_N = 0.48; // サイコロの色。盤より明るくして浮かび上がらせる
const BODY_VAR = 0.14;
const TILE_N = 0.028; // 盤のタイルの色。暗く沈めて、上に載るサイコロだけを見せる
const TILE_VAR = 0.04;
const RIM_N = 0.32; // 穴の縁のライン。ここが次に落ちる場所だと読ませる
const EDGE_N = 0.13; // 盤の外周のライン
const DARK = -0.32; // 暗がりへ消えるときの明度の引き下げ量。背景と同じ黒まで落とす
const VOICED = 3; // 何区画に 1 つ音を鳴らすか

const BLOCKS = BLOCKS_X * BLOCKS_Z;
const PER_BLOCK = TIERS + 1; // 5 段ぶん + 暗がりを通る区間
const COUNT = BLOCKS * PER_BLOCK;
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
  hc: number; // 落ちるマス（穴）
  hr: number;
  dx: Int8Array; // 各手の進む向き
  dz: Int8Array;
  quats: THREE.Quaternion[]; // 各手の開始姿勢。最後の 1 つは穴の上での姿勢
  spin: THREE.Quaternion; // 落下中に加える回転
  after: THREE.Quaternion; // 落下しきったあとの姿勢
}

/** 1 区画。ここに属するサイコロは同じ手数・同じ歩幅で、位相だけがずれている。 */
interface Block {
  n: number; // 本体の色
  moves: number; // 1 段の手数
  step: number; // 1 手の秒数
  seg: number; // 1 段にかかる秒数（転がり + 落下）
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
let dropTicks: ((phase: number) => number)[] = [];
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

/** 落下の進み具合（0 = 落ち始め、1 = 着地）。着地のあと一度だけ浅く跳ねる。 */
function dropCurve(e: number): number {
  if (e <= TOUCH) {
    const k = e / TOUCH;
    return k * k;
  }
  const b = (e - TOUCH) / (1 - TOUCH);
  return 1 - BOUNCE * 4 * b * (1 - b);
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
 * 6 面ぶんの目を横一列に描いたテクスチャ。白地に暗い点なので、
 * instanceColor に乗算されて点だけが沈んで見える。
 * シーンを開き直すたびに作らないよう、モジュールに 1 枚だけ持つ。
 */
let pips: THREE.CanvasTexture | null = null;

/** BoxGeometry の面の並び（+X, -X, +Y, -Y, +Z, -Z）に当てる出目。対面の和が 7。 */
const FACE_VALUES = [3, 4, 5, 2, 1, 6];

/** 目の配置。値は面の中での 0..1 座標。 */
const SPOTS: readonly (readonly [number, number])[][] = [
  [[0.5, 0.5]],
  [
    [0.29, 0.29],
    [0.71, 0.71],
  ],
  [
    [0.27, 0.27],
    [0.5, 0.5],
    [0.73, 0.73],
  ],
  [
    [0.3, 0.3],
    [0.7, 0.3],
    [0.3, 0.7],
    [0.7, 0.7],
  ],
  [
    [0.29, 0.29],
    [0.71, 0.29],
    [0.5, 0.5],
    [0.29, 0.71],
    [0.71, 0.71],
  ],
  [
    [0.3, 0.24],
    [0.7, 0.24],
    [0.3, 0.5],
    [0.7, 0.5],
    [0.3, 0.76],
    [0.7, 0.76],
  ],
];

function pipTexture(): THREE.CanvasTexture {
  const S = 96;
  const cv = document.createElement('canvas');
  cv.width = S * 6;
  cv.height = S;
  const g = cv.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, S * 6, S);
  for (let f = 0; f < 6; f++) {
    const spots = SPOTS[FACE_VALUES[f]! - 1]!;
    // 目のふちをぼかすと、彫り込みのように見えて輪郭が硬くならない
    for (const [u, v] of spots) {
      const cx = f * S + u * S;
      const cy = v * S;
      const r = S * 0.094;
      const grad = g.createRadialGradient(cx, cy, r * 0.35, cx, cy, r);
      grad.addColorStop(0, '#3a3330');
      grad.addColorStop(0.72, '#463d39');
      grad.addColorStop(1, '#ffffff');
      g.fillStyle = grad;
      g.beginPath();
      g.arc(cx, cy, r, 0, Math.PI * 2);
      g.fill();
    }
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** 立方体の 6 面を、目のアトラスの 6 コマへ割り当てる。 */
function dieGeometry(): THREE.BoxGeometry {
  const geo = new THREE.BoxGeometry(DIE, DIE, DIE);
  const uv = geo.attributes.uv;
  for (let f = 0; f < 6; f++) {
    for (let v = 0; v < 4; v++) {
      const i = f * 4 + v;
      uv.setX(i, (uv.getX(i) + f) / 6);
    }
  }
  uv.needsUpdate = true;
  return geo;
}

/**
 * 1 区画ぶんの経路を作る。区画内の 3x3 を縦に貫く柱の中だけで完結するので、
 * 他の区画のサイコロと重なることはない。
 */
function buildBlocks(): void {
  const rnd = makeRng(0x51ced1ce);
  const step = new THREE.Quaternion();
  const open: (readonly [number, number])[] = [];
  const fwd: (readonly [number, number])[] = [];
  const spots: number[][] = [];
  blocks.length = 0;

  for (let bj = 0; bj < BLOCKS_Z; bj++) {
    for (let bi = 0; bi < BLOCKS_X; bi++) {
      const c0 = bi * ROOM; // 区画の左奥のマス
      const r0 = bj * ROOM;
      const moves = MOVES_MIN + Math.floor(rnd() * MOVES_VAR);
      const step_ = STEP_MIN + rnd() * STEP_VAR;
      const b: Block = {
        n: BODY_N + rnd() * BODY_VAR,
        moves,
        step: step_,
        seg: moves * step_ + FALL,
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
        // 穴は歩き出しのマスから「手数と同じ偶奇の距離」にある必要がある。
        // そうでないとぴったり moves 手で穴へ着けない
        spots.length = 0;
        for (let c = c0; c < c0 + ROOM; c++) {
          for (let r = r0; r < r0 + ROOM; r++) {
            const d = Math.abs(c - sc) + Math.abs(r - sr);
            if (d === 0 || d > moves || (moves - d) % 2 !== 0) continue;
            spots.push([c, r]);
          }
        }
        const hole = spots[Math.floor(rnd() * spots.length)]!;
        const hc = hole[0]!;
        const hr = hole[1]!;

        // 穴へちょうど moves 手で着くよう、残り手数で届く向きだけから選ぶ
        const dx = new Int8Array(moves);
        const dz = new Int8Array(moves);
        const quats: THREE.Quaternion[] = [carry.clone()];
        let c = sc;
        let r = sr;
        for (let m = 0; m < moves; m++) {
          const left = moves - m - 1;
          open.length = 0;
          fwd.length = 0;
          for (const dir of DIRS) {
            const nc = c + dir[0];
            const nr = r + dir[1];
            if (nc < c0 || nc >= c0 + ROOM || nr < r0 || nr >= r0 + ROOM) continue;
            const d = Math.abs(nc - hc) + Math.abs(nr - hr);
            if (d > left || (left - d) % 2 !== 0) continue;
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

        // 落下中の回転。90 度の倍数だけ回すので、着地しても姿勢は軸に揃ったまま
        axis.set(rnd() < 0.5 ? 1 : 0, 0, rnd() < 0.5 ? 1 : 0);
        if (axis.x === 0 && axis.z === 0) axis.set(1, 0, 0);
        const spin = new THREE.Quaternion().setFromAxisAngle(
          axis.normalize(),
          (Math.PI / 2) * (1 + Math.floor(rnd() * 3)),
        );
        const after = quats[moves]!.clone().premultiply(spin);

        b.tiers.push({ sc, sr, hc, hr, dx, dz, quats, spin, after });
        carry = after;
        sc = hc; // 真下へ落ちるので、次の段は穴と同じマスから歩き出す
        sr = hr;
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
    const top = tierY(seg) + half;
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
      axis.set(uz, 0, -ux);
      turn.setFromAxisAngle(axis, (e * Math.PI) / 2);
      // 倒れる先の辺を回転の中心にして、そのまわりに立方体を振る
      rel.set(-ux * half, half, -uz * half).applyQuaternion(turn);
      dummy.position.set(
        gridX(c) + ux * half + rel.x,
        tierY(seg) + rel.y,
        gridZ(r) + uz * half + rel.z,
      );
      dummy.quaternion.copy(tier.quats[m]!).premultiply(turn);
      return 0;
    }

    // 穴に差しかかってから、下の盤（最下段なら暗がり）へ落ちる
    const e = clamp01((tt - rollT) / FALL);
    const fallen = dropCurve(e) * GAP;
    dummy.position.set(gridX(tier.hc), top - fallen, gridZ(tier.hr));
    turn.copy(tier.spin).slerp(pose.identity(), 1 - smooth(clamp01(e / TOUCH)));
    dummy.quaternion.copy(tier.quats[b.moves]!).premultiply(turn);
    return seg === TIERS - 1 ? DARK * smooth(clamp01(e / 0.55)) : 0;
  }

  // 最下段を抜けたあと。暗がりを落ちきってから、最上段の上へ降ってくる
  const last = b.tiers[TIERS - 1]!;
  const first = b.tiers[0]!;
  if (f < 0.5) {
    const e = f / 0.5;
    dummy.position.set(
      gridX(last.hc),
      tierY(TIERS - 1) + half - GAP - GAP * 1.8 * e * e,
      gridZ(last.hr),
    );
    dummy.quaternion.copy(last.after);
    return DARK;
  }
  const e = (f - 0.5) / 0.5;
  const top = tierY(0) + half;
  const rise = GAP * 1.7;
  dummy.position.set(gridX(first.sc), top + rise * (1 - dropCurve(e)), gridZ(first.sr));
  // 暗がりにいるうちに、歩き出しの姿勢へ戻しておく
  pose.copy(last.after).slerp(first.quats[0]!, smooth(clamp01(e / 0.5)));
  dummy.quaternion.copy(pose);
  return DARK * (1 - clamp01((e - 0.38) / 0.42));
}

export const diceField: SceneModule = {
  name: 'Dice Field',
  desc: '5 枚の盤が間を空けて積まれている。サイコロは盤を歩き、穴を見つけて一段下へ落ちていく。',
  camera: { pos: [9.7, 21.6, 23.8], target: [0, STACK_H * 0.55, 0] },

  build(root) {
    buildBlocks();
    dropTicks = tickers(COUNT);
    landTicks = tickers(COUNT);

    // ---- 盤。穴のマスだけタイルを置かない ----
    const holed = new Set<number>();
    for (const b of blocks) {
      for (let k = 0; k < TIERS; k++) {
        const tier = b.tiers[k]!;
        holed.add((k * CELLS_Z + tier.hr) * CELLS_X + tier.hc);
      }
    }
    const tileN = TIERS * CELLS_X * CELLS_Z - holed.size;
    const tiles = new THREE.InstancedMesh(
      new THREE.BoxGeometry(TILE, TILE_H, TILE),
      new THREE.MeshStandardMaterial({ roughness: 0.82, metalness: 0.12 }),
      tileN,
    );
    const rnd = makeRng(0x7a1de5);
    let i = 0;
    for (let k = 0; k < TIERS; k++) {
      for (let r = 0; r < CELLS_Z; r++) {
        for (let c = 0; c < CELLS_X; c++) {
          const shade = TILE_N + rnd() * TILE_VAR;
          if (holed.has((k * CELLS_Z + r) * CELLS_X + c)) continue;
          dummy.position.set(gridX(c), tierY(k) - TILE_H * 0.5, gridZ(r));
          dummy.quaternion.identity();
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          tiles.setMatrixAt(i, dummy.matrix);
          tiles.setColorAt(i, emberColor(shade));
          i++;
        }
      }
    }
    root.add(tiles);

    // ---- 穴の縁と盤の外周。穴が光っていると、次にどこへ落ちるかが読める ----
    const rim: number[] = [];
    const edge: number[] = [];
    for (let k = 0; k < TIERS; k++) {
      const y = tierY(k) + 0.012;
      for (const key of holed) {
        if (Math.floor(key / (CELLS_X * CELLS_Z)) !== k) continue;
        const c = key % CELLS_X;
        const r = Math.floor(key / CELLS_X) % CELLS_Z;
        const x = gridX(c);
        const z = gridZ(r);
        const h = CELL * 0.5;
        rim.push(x - h, y, z - h, x + h, y, z - h);
        rim.push(x + h, y, z - h, x + h, y, z + h);
        rim.push(x + h, y, z + h, x - h, y, z + h);
        rim.push(x - h, y, z + h, x - h, y, z - h);
      }
      const hx = SPAN_X * 0.5;
      const hz = SPAN_Z * 0.5;
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
    for (const [pts, n, opacity] of [
      [rim, RIM_N, 0.9],
      [edge, EDGE_N, 0.5],
    ] as const) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      root.add(
        new THREE.LineSegments(
          geo,
          new THREE.LineBasicMaterial({
            color: emberColor(n),
            transparent: true,
            opacity,
          }),
        ),
      );
    }

    // ---- サイコロ ----
    pips ??= pipTexture();
    body = new THREE.InstancedMesh(
      dieGeometry(),
      new THREE.MeshStandardMaterial({ map: pips, roughness: 0.46, metalness: 0.26 }),
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
      const seg = ((Math.floor(p) % PER_BLOCK) + PER_BLOCK) % PER_BLOCK;
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

      // 穴へ落ち始める瞬間
      for (let n = dropTicks[i]!(p - rollT); n > 0; n--) {
        const seg = ((Math.floor(p - rollT) % PER_BLOCK) + PER_BLOCK) % PER_BLOCK;
        if (seg >= TIERS) continue;
        const tier = b.tiers[seg]!;
        sfx.drop(tone(b.note - 6 - seg), {
          gain: 0.2,
          decay: 0.55,
          pan: panAt(gridX(tier.hc)),
        });
      }
      // 下の盤へ着いた瞬間。段が下がるほど低く鳴らす
      const landT = rollT + (FALL * TOUCH) / b.seg;
      for (let n = landTicks[i]!(p - landT); n > 0; n--) {
        const seg = ((Math.floor(p - landT) % PER_BLOCK) + PER_BLOCK) % PER_BLOCK;
        if (seg >= TIERS - 1) continue;
        const tier = b.tiers[seg]!;
        sfx.pluck(tone(b.note - seg), {
          gain: 0.21,
          decay: 1.2,
          pan: panAt(gridX(tier.hc)),
        });
      }
    }
  },
};
