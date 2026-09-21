import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, tickers } from '../audio.ts';
import { ember, emberColor, drift } from '../palette.ts';

/**
 * 何が動くか: 7x7 の盤が 5 枚、広い間隔をあけて真上に積まれている。無地の立方体が
 *   盤の上を辺を軸にコトンと倒れて気まぐれな隣のマスへ移り、4〜6 手で立ち止まる。
 *   止まった立方体はその場で盤に沈み、暗がりをゆっくり通って、一段下の盤の同じ位置へ
 *   降りてくる。最下段まで降りたものは暗がりを抜けて最上段の上から戻ってくる。
 * 気持ちよさの芯: 立方体が辺で持ち上がって落ちる「間」と、次にどっちへ行くか読めないこと。
 *   歩く範囲を区切っていないので、行き先も、どの立方体とすれ違うかも決まっていない。
 * ループの周期: 1 段の滞在が 8.5 秒（歩き 6.3 秒 + 沈み 2.2 秒）で、これは全個体で共通。
 *   手数は個体ごとに 4〜6 手なので、1 手の長さは 1.05〜1.58 秒とまちまちになる。
 *   1 個が 5 段を降りて戻るまで 51 秒。30 個の位相を周期全体へ散らしてある。
 * カメラ: 水平から 28 度の斜俯瞰。段と段の空きから 5 枚すべての盤面が見える角度。
 * 音: 沈み始めに drop、下の盤へ着いたときに pluck（半分の立方体だけ）。段が下がるほど音程が低い。
 * スコープ外: サイコロの目。
 *
 * 立方体どうしの重なりは、なわばりで分けるのではなく build で時間ごとにマスを予約して防ぐ。
 * 1 段の滞在時間が全個体で同じなので、周期 51 秒を 216 のスロットへ割った表を作れば、
 * 「この段のこのマスを、この時間帯に使う個体がいるか」を先に調べられる。経路はこの表を
 * 見ながら 1 個ずつ貪欲に引くので、歩く範囲が重なっていてもぶつからない。
 */

// ---- 調整する数値 ----
const TIERS = 5; // 盤の枚数
const GAP = 4.2; // 盤と盤の間隔。広く空けて段の間から奥を見せる
const SIDE = 7; // 盤の一辺のマス数。正方形
const CELL = 1.35; // マスの一辺
const DIE = CELL; // 立方体の一辺。マス目と同じにしないと転がりが 1 マスぶんにならない
const TILE = CELL * 0.94; // 盤のタイル。マスより少しだけ小さくして目地を作る
const TILE_H = 0.26; // 盤の厚み
const DICE = 30; // 立方体の総数。うち 1/6 は暗がりを通っていて見えない
const SEG = 8.5; // 1 段に居る秒数。全個体で同じにして、予約表を作れるようにしている
const SINK = 2.2; // そのうち沈み込みに使う秒数
const WALK = SEG - SINK; // 歩きに使う秒数
const MOVES_MIN = 4; // 立ち止まるまでの手数
const MOVES_VAR = 3;
const ROLL_FRAC = 0.4; // 1 手のうち転がりに使う割合（残りは静止して「間」になる）
const ROLL_OFF = 0.5; // 手の中で倒れ始める位相のばらつき。揃って倒れないように散らす
const FADE = 0.46; // 沈み込みのうち、いちばん暗くなるまでの割合。0.5 に近づけるほど暗い間が短い
const BACKTRACK = 0.16; // 来た道をそのまま引き返す確率
const JITTER = 0.45; // 位相を均等割りからずらす幅（秒）
const BODY_N = 0.42; // 立方体の色
const BODY_VAR = 0.14;
const TILE_N = 0.032; // 盤のタイルの色。暗く沈めて、上に載る立方体だけを見せる
const TILE_VAR = 0.04;
const EDGE_N = 0.15; // 盤の外周のライン
const DARK = -0.26; // 沈むときに落とす明度。消しきらず、暗がりを降りる影が残る程度にする
const SLOTS_PER_SEG = 36; // 予約表の時間の刻み。1 段ぶんをこの数に割る
const TRIES = 240; // 経路を引き直す上限。7x7 に 30 個だとここまで要る

const LANES = TIERS + 1; // 5 段ぶん + 暗がりを通って最上段へ戻る区間
const PERIOD = SEG * LANES;
const SLOTS = SLOTS_PER_SEG * LANES;
const CELLS = SIDE * SIDE;
const SPAN = SIDE * CELL;
const STACK_H = (TIERS - 1) * GAP;

/** 段 k の盤の上面の高さ。0 が最上段。 */
const tierY = (k: number): number => (TIERS - 1 - k) * GAP;
/** マス番号を盤の中心を原点とする座標へ。 */
const grid = (i: number): number => (i - (SIDE - 1) / 2) * CELL;

/** 1 個の 1 段ぶん。歩く経路と、そこで取る姿勢をすべて build で決めておく。 */
interface Path {
  sc: number; // 降りてきたマス（歩き出し）
  sr: number;
  ec: number; // 立ち止まるマス。ここで盤に沈む
  er: number;
  dx: Int8Array; // 各手の進む向き
  dz: Int8Array;
  quats: THREE.Quaternion[]; // 各手の開始姿勢。最後の 1 つは立ち止まったときの姿勢
}

/** 立方体 1 個。経路は 1 個ずつ別に引くので、同じ歩き方をするものは無い。 */
interface Die {
  n: number; // 本体の色
  moves: number; // 立ち止まるまでの手数
  step: number; // 1 手の秒数。手数で歩きの時間を割ったもの
  lean: number; // 手の中で倒れ始める位相
  off: number; // 位相オフセット
  note: number;
  voiced: boolean; // 音を鳴らすか
  tiers: Path[];
}

const dice: Die[] = [];

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
const panAt = (x: number): number => (x / (SPAN * 0.5)) * 0.7;

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
 * どの段のどのマスが、どの時間帯に埋まっているかの表。
 * 1 が立つのは「その時間帯に立方体が乗っているか、乗り込んでくる」マス。
 */
const taken = new Uint8Array(TIERS * SLOTS * CELLS);
/** 経路を引いている途中の予約。通しで引けたときだけ taken へ書き写す。 */
let holds: number[] = [];

/** 時刻 t0..t1 のあいだ、段 k のマス (c, r) を使えるか調べ、write なら予約する。 */
function reserve(k: number, c: number, r: number, t0: number, t1: number, write: boolean): boolean {
  const cell = r * SIDE + c;
  const s0 = Math.floor((t0 / SEG) * SLOTS_PER_SEG);
  const s1 = Math.ceil((t1 / SEG) * SLOTS_PER_SEG);
  for (let s = s0; s <= s1; s++) {
    const idx = (k * SLOTS + (((s % SLOTS) + SLOTS) % SLOTS)) * CELLS + cell;
    if (taken[idx]) return false;
    if (write) holds.push(idx);
  }
  return true;
}

/** 1 手ぶん（いま居るマスと倒れ込む先）を時間 t0..t1 で押さえられるか。 */
function step(
  k: number,
  c: number,
  r: number,
  nc: number,
  nr: number,
  t0: number,
  t1: number,
  write: boolean,
): boolean {
  if (!reserve(k, c, r, t0, t1, write)) return false;
  return reserve(k, nc, nr, t0, t1, write);
}

/**
 * 立方体 1 個ぶんの経路を、予約表を見ながら引く。
 * 引き終えるまで他の個体の予約は動かないので、通れば以後ぶつからない。
 */
function route(d: Die, rnd: () => number): boolean {
  const open: (readonly [number, number])[] = [];
  const fwd: (readonly [number, number])[] = [];
  const tiers: Path[] = [];
  let carry = new THREE.Quaternion();
  const spin = new THREE.Quaternion();

  // 最上段の歩き出しは、その時間に空いているマスから選ぶ
  let sc = Math.floor(rnd() * SIDE);
  let sr = Math.floor(rnd() * SIDE);
  let found = false;
  for (let n = 0; n < CELLS; n++) {
    const c = (sc + n) % SIDE;
    const r = (sr + Math.floor(n / SIDE)) % SIDE;
    if (reserve(0, c, r, -d.off, -d.off + d.step, false)) {
      sc = c;
      sr = r;
      found = true;
      break;
    }
  }
  if (!found) return false;

  for (let k = 0; k < TIERS; k++) {
    // 予約表は実時刻で持つ。位相が k*SEG になる実時刻は、位相オフセットを引いた側
    const base = k * SEG - d.off;
    const dx = new Int8Array(d.moves);
    const dz = new Int8Array(d.moves);
    const quats: THREE.Quaternion[] = [carry.clone()];
    let c = sc;
    let r = sr;

    for (let m = 0; m < d.moves; m++) {
      const t0 = base + m * d.step;
      const t1 = t0 + d.step;
      // 盤から出ず、その時間に空いている向きを集める。引き返しはたまにだけ混ぜる
      open.length = 0;
      fwd.length = 0;
      for (const dir of DIRS) {
        const nc = c + dir[0];
        const nr = r + dir[1];
        if (nc < 0 || nc >= SIDE || nr < 0 || nr >= SIDE) continue;
        if (!step(k, c, r, nc, nr, t0, t1, false)) continue;
        open.push(dir);
        if (m === 0 || dir[0] !== -dx[m - 1]! || dir[1] !== -dz[m - 1]!) fwd.push(dir);
      }
      if (open.length === 0) return false;
      const pool = fwd.length > 0 && rnd() > BACKTRACK ? fwd : open;
      const dir = pool[Math.floor(rnd() * pool.length)]!;

      step(k, c, r, c + dir[0], r + dir[1], t0, t1, true);
      dx[m] = dir[0];
      dz[m] = dir[1];
      c += dir[0];
      r += dir[1];
      axis.set(dir[1], 0, -dir[0]);
      spin.setFromAxisAngle(axis, Math.PI / 2);
      quats.push(quats[m]!.clone().premultiply(spin));
    }

    // 沈んでいるあいだは、立ち止まったマスと、その真下の段の同じマスを押さえる
    const t0 = base + WALK;
    const t1 = base + SEG;
    if (!reserve(k, c, r, t0, t1, true)) return false;
    if (k < TIERS - 1 && !reserve(k + 1, c, r, t0, t1, true)) return false;

    tiers.push({ sc, sr, ec: c, er: r, dx, dz, quats });
    carry = quats[d.moves]!.clone();
    sc = c; // 真下へ降りるので、次の段は同じマスから歩き出す
    sr = r;
  }

  d.tiers = tiers;
  return true;
}

/** 30 個ぶんの経路を順に引く。引けなかった個体はそのまま落とす。 */
function buildDice(): void {
  const rnd = makeRng(0x51ced1ce);
  dice.length = 0;
  taken.fill(0);

  for (let i = 0; i < DICE; i++) {
    const moves = MOVES_MIN + Math.floor(rnd() * MOVES_VAR);
    const d: Die = {
      n: BODY_N + rnd() * BODY_VAR,
      moves,
      step: WALK / moves,
      lean: rnd() * ROLL_OFF,
      // 位相は周期全体へ均等に散らし、少しだけ揺らす。揃って沈まないように
      off: ((i + 0.5) / DICE) * PERIOD + (rnd() * 2 - 1) * JITTER,
      note: 6 + (i % 5),
      voiced: i % 2 === 0,
      tiers: [],
    };

    for (let attempt = 0; attempt < TRIES; attempt++) {
      holds = [];
      if (!route(d, rnd)) continue; // 詰まったら予約を捨てて、別の乱数で引き直す
      for (const idx of holds) taken[idx] = 1;
      dice.push(d);
      break;
    }
  }
  holds = [];
}

/**
 * 区間 seg の途中（f = 0..1）の姿勢と位置を dummy に置く。戻り値は明度の加算。
 * seg が TIERS のときは、最下段を抜けて暗がりを通り、最上段の上へ戻る区間。
 */
function place(d: Die, seg: number, f: number): number {
  const half = DIE * 0.5;

  if (seg < TIERS) {
    const path = d.tiers[seg]!;
    const tt = f * SEG;

    if (tt < WALK) {
      const m = Math.min(d.moves - 1, Math.floor(tt / d.step));
      const inStep = (tt - m * d.step) / d.step;
      const e = smooth(clamp01((inStep - d.lean) / ROLL_FRAC));
      let c = path.sc;
      let r = path.sr;
      for (let i = 0; i < m; i++) {
        c += path.dx[i]!;
        r += path.dz[i]!;
      }
      const ux = path.dx[m]!;
      const uz = path.dz[m]!;
      // 倒れる先の辺を回転の中心にして、そのまわりに立方体を振る
      axis.set(uz, 0, -ux);
      turn.setFromAxisAngle(axis, (e * Math.PI) / 2);
      rel.set(-ux * half, half, -uz * half).applyQuaternion(turn);
      dummy.position.set(
        grid(c) + ux * half + rel.x,
        tierY(seg) + rel.y,
        grid(r) + uz * half + rel.z,
      );
      dummy.quaternion.copy(path.quats[m]!).premultiply(turn);
      return 0;
    }

    // 立ち止まったマスで盤へ沈み、一段下の同じ位置へ降りてくる
    const e = clamp01((tt - WALK) / SINK);
    dummy.position.set(grid(path.ec), tierY(seg) + half - GAP * smooth(e), grid(path.er));
    dummy.quaternion.copy(path.quats[d.moves]!);
    if (seg < TIERS - 1) return DARK * veil(e);
    // 最下段には下の盤が無い。盤をくぐったあとは影も残さず暗がりへ沈めきる
    return (
      DARK * smooth(clamp01(e / FADE)) + (-1 - DARK) * smooth(clamp01((e - FADE) / (1 - FADE)))
    );
  }

  // 最下段を抜けたあと。暗がりを降りきってから、最上段の上へ戻る
  const last = d.tiers[TIERS - 1]!;
  const first = d.tiers[0]!;
  if (f < 0.42) {
    const e = f / 0.42;
    dummy.position.set(
      grid(last.ec),
      tierY(TIERS - 1) + half - GAP - GAP * 0.8 * smooth(e),
      grid(last.er),
    );
    dummy.quaternion.copy(last.quats[d.moves]!);
    return -1;
  }
  const e = (f - 0.42) / 0.58;
  dummy.position.set(grid(first.sc), tierY(0) + half + GAP * (1 - smooth(e)), grid(first.sr));
  // 暗がりにいるうちに、歩き出しの姿勢へ戻しておく
  pose.copy(last.quats[d.moves]!).slerp(first.quats[0]!, smooth(clamp01(e / 0.55)));
  dummy.quaternion.copy(pose);
  // 最上段へ近づくにつれ、暗がりから元の明るさへ戻す
  return -1 + smooth(clamp01((e - 0.2) / 0.55));
}

export const diceField: SceneModule = {
  name: 'Dice Field',
  desc: '間を空けて積んだ 5 枚の盤。立方体は盤を歩き、立ち止まったところで一段下へ降りる。',
  camera: { pos: [10, 23.5, 26], target: [0, STACK_H * 0.55, 0] },

  build(root) {
    buildDice();
    sinkTicks = tickers(dice.length);
    landTicks = tickers(dice.length);

    // ---- 盤。マスごとのタイルにして、目地で格子を見せる ----
    const tiles = new THREE.InstancedMesh(
      new THREE.BoxGeometry(TILE, TILE_H, TILE),
      new THREE.MeshStandardMaterial({ roughness: 0.82, metalness: 0.12 }),
      TIERS * CELLS,
    );
    const rnd = makeRng(0x7a1de5);
    let i = 0;
    for (let k = 0; k < TIERS; k++) {
      for (let r = 0; r < SIDE; r++) {
        for (let c = 0; c < SIDE; c++) {
          dummy.position.set(grid(c), tierY(k) - TILE_H * 0.5, grid(r));
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
    const h = SPAN * 0.5;
    for (let k = 0; k < TIERS; k++) {
      const y = tierY(k) + 0.012;
      const yb = tierY(k) - TILE_H;
      for (const [x0, z0, x1, z1] of [
        [-h, -h, h, -h],
        [h, -h, h, h],
        [h, h, -h, h],
        [-h, h, -h, -h],
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
      dice.length,
    );
    body.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    root.add(body);
  },

  update(t) {
    const shift = drift(t);
    dummy.scale.set(1, 1, 1);
    for (let i = 0; i < dice.length; i++) {
      const d = dice[i]!;
      const p = (t + d.off) / SEG;
      const seg = ((Math.floor(p) % LANES) + LANES) % LANES;
      const glow = place(d, seg, p - Math.floor(p));

      dummy.updateMatrix();
      body.setMatrixAt(i, dummy.matrix);
      ember(color, d.n, shift, glow);
      body.setColorAt(i, color);
    }
    body.instanceMatrix.needsUpdate = true;
    if (body.instanceColor) body.instanceColor.needsUpdate = true;
  },

  sound(t, _dt, sfx) {
    for (let i = 0; i < dice.length; i++) {
      const d = dice[i]!;
      if (!d.voiced) continue;
      const p = (t + d.off) / SEG;
      const sinkAt = WALK / SEG;

      // 立ち止まって沈み始める瞬間
      for (let n = sinkTicks[i]!(p - sinkAt); n > 0; n--) {
        const seg = ((Math.floor(p - sinkAt) % LANES) + LANES) % LANES;
        if (seg >= TIERS) continue;
        const path = d.tiers[seg]!;
        sfx.drop(tone(d.note - 6 - seg), {
          gain: 0.19,
          decay: 0.7,
          pan: panAt(grid(path.ec)),
        });
      }
      // 下の盤へ降り着いた瞬間。段が下がるほど低く鳴らす
      for (let n = landTicks[i]!(p); n > 0; n--) {
        const seg = ((Math.floor(p) % LANES) + LANES) % LANES;
        if (seg === 0 || seg > TIERS - 1) continue;
        const path = d.tiers[seg]!;
        sfx.pluck(tone(d.note - seg), {
          gain: 0.2,
          decay: 1.4,
          pan: panAt(grid(path.sc)),
        });
      }
    }
  },
};
