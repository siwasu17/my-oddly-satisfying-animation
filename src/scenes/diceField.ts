import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, tickers } from '../audio.ts';
import { SURFACE, ember, emberColor, drift } from '../palette.ts';

/**
 * 何が動くか: 広い格子の盤に散らばった 6 つの無地の立方体が、辺を軸にコトンと倒れて
 *   気まぐれな向きの隣マスへ移る。行き先は毎手ランダムで、来た道を戻ることもある。
 * 気持ちよさの芯: 立方体が辺で持ち上がって落ちる「間」と、次にどっちへ行くか読めないこと。
 *   歩き終えた立方体は盤へすっと沈み、なわばりのどこかからまたせり上がってくる。
 * ループの周期: 1 手 1.0〜1.9 秒。各立方体は 12〜21 手で沈降まで一巡し、位相はばらばら。
 * カメラ: 盤全体が入る俯瞰。
 * 音: 着地に pluck（2 つに 1 つの立方体だけ・倒れた先のマスで左右に振る）、沈む瞬間に drop。
 * スコープ外: サイコロの目、立方体同士の衝突（各自 3x3 のなわばりから出ないので重ならない）。
 */

// ---- 調整する数値 ----
const BLOCKS_X = 3; // 横のなわばり数
const BLOCKS_Z = 2; // 奥行きのなわばり数。立方体は BLOCKS_X * BLOCKS_Z 個
const ROOM = 3; // なわばりの一辺のマス数。この中だけを歩くので互いに重ならない
const MARGIN = 1; // 盤の外周に残す空きマス
const CELL = 2.3; // マスの一辺
const DIE = CELL; // 立方体の一辺。マス目と同じにして、1 マスをちょうど埋める
const DEPTH = DIE * 2.1; // 沈む深さ
const ROLL_FRAC = 0.34; // 1 手のうち転がりに使う割合（残りは静止して「間」になる）
const STEP_MIN = 1.0; // 1 手の秒数
const STEP_VAR = 0.9;
const MOVES_MIN = 12; // 沈むまでの手数
const MOVES_VAR = 10;
const BACKTRACK = 0.18; // 来た道をそのまま引き返す確率
const BODY_N = 0.34; // 立方体の色
const BODY_VAR = 0.16;
const SINK_GLOW = 0.2; // 沈むときに持ち上げる明度
const LINE_N = 0.2; // 盤の罫線
const COUNT = BLOCKS_X * BLOCKS_Z;
const CELLS_X = BLOCKS_X * ROOM + MARGIN * 2; // 盤のマス数
const CELLS_Z = BLOCKS_Z * ROOM + MARGIN * 2;
const SPAN_X = CELLS_X * CELL; // 盤の一辺
const SPAN_Z = CELLS_Z * CELL;

/** 1 個ぶんの周回路と姿勢。すべて build で決めて update からは読むだけ。 */
interface Die {
  n: number; // 本体の色
  step: number; // 1 手の秒数
  off: number; // 位相オフセット
  moves: number; // 沈むまでの手数
  cx: Float32Array; // 各手の開始マス中心
  cz: Float32Array;
  dx: Float32Array; // 各手の進む向き
  dz: Float32Array;
  quats: THREE.Quaternion[]; // 各手の開始姿勢
  note: number;
}

const dice: Die[] = [];

const dummy = new THREE.Object3D();
const color = new THREE.Color();
const spin = new THREE.Quaternion();
const rest = new THREE.Quaternion();
const axis = new THREE.Vector3();
const rel = new THREE.Vector3();

let body: THREE.InstancedMesh;
let landTicks: ((phase: number) => number)[] = [];
let sinkTicks: ((phase: number) => number)[] = [];

const DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

const smooth = (x: number): number => x * x * (3 - 2 * x);
const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
/** 盤の左右どちらで鳴ったか。 */
const panAt = (x: number): number => (x / (SPAN_X * 0.5)) * 0.7;

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

/** 立方体 1 個ぶんの歩みと、各手の姿勢を先に全部求めておく。 */
function buildDice(): void {
  const rnd = makeRng(0x51ced1ce);
  const halfX = (CELLS_X - 1) / 2; // 盤の中心に来るマス番号
  const halfZ = (CELLS_Z - 1) / 2;
  const step = new THREE.Quaternion();
  const open: number[][] = [];
  const fwd: number[][] = [];
  dice.length = 0;

  for (let bj = 0; bj < BLOCKS_Z; bj++) {
    for (let bi = 0; bi < BLOCKS_X; bi++) {
      const c0 = MARGIN + bi * ROOM; // なわばりの左奥のマス
      const r0 = MARGIN + bj * ROOM;
      const moves = MOVES_MIN + Math.floor(rnd() * MOVES_VAR);

      const cx = new Float32Array(moves + 1);
      const cz = new Float32Array(moves + 1);
      const dx = new Float32Array(moves);
      const dz = new Float32Array(moves);
      const quats: THREE.Quaternion[] = [new THREE.Quaternion()];

      let c = c0 + Math.floor(rnd() * ROOM);
      let r = r0 + Math.floor(rnd() * ROOM);
      cx[0] = (c - halfX) * CELL;
      cz[0] = (r - halfZ) * CELL;

      for (let m = 0; m < moves; m++) {
        // なわばりから出ない向きを集める。引き返しは別枠にして、たまにだけ混ぜる
        open.length = 0;
        fwd.length = 0;
        for (const dir of DIRS) {
          const nc = c + dir[0];
          const nr = r + dir[1];
          if (nc < c0 || nc >= c0 + ROOM || nr < r0 || nr >= r0 + ROOM) continue;
          open.push(dir);
          if (m === 0 || dir[0] !== -dx[m - 1] || dir[1] !== -dz[m - 1]) fwd.push(dir);
        }
        const pool = fwd.length > 0 && rnd() > BACKTRACK ? fwd : open;
        const dir = pool[Math.floor(rnd() * pool.length)];

        dx[m] = dir[0];
        dz[m] = dir[1];
        c += dir[0];
        r += dir[1];
        cx[m + 1] = (c - halfX) * CELL;
        cz[m + 1] = (r - halfZ) * CELL;

        axis.set(dz[m], 0, -dx[m]);
        step.setFromAxisAngle(axis, Math.PI / 2);
        quats.push(quats[m].clone().premultiply(step));
      }

      const i = dice.length;
      dice.push({
        n: BODY_N + rnd() * BODY_VAR,
        step: STEP_MIN + rnd() * STEP_VAR,
        off: rnd() * 60,
        moves,
        cx,
        cz,
        dx,
        dz,
        quats,
        note: 5 + (i % 6),
      });
    }
  }
}

/** m 手目の途中（f = 0..1）の姿勢と位置を dummy に置く。戻り値は明るさの加算。 */
function place(d: Die, m: number, f: number): number {
  const half = DIE * 0.5;
  if (m < d.moves) {
    const e = smooth(clamp01(f / ROLL_FRAC));
    axis.set(d.dz[m], 0, -d.dx[m]);
    spin.setFromAxisAngle(axis, (e * Math.PI) / 2);
    rel.set(-d.dx[m] * half, half, -d.dz[m] * half).applyQuaternion(spin);
    dummy.position.set(d.cx[m] + d.dx[m] * half + rel.x, rel.y, d.cz[m] + d.dz[m] * half + rel.z);
    dummy.quaternion.copy(d.quats[m]).premultiply(spin);
    return 0;
  }
  const e = smooth(f);
  const sinking = m === d.moves;
  const drop = sinking ? e : 1 - e;
  // 沈むのは歩き終えたマス、出てくるのは歩き出しのマス
  const at = sinking ? d.moves : 0;
  dummy.position.set(d.cx[at], half - DEPTH * drop, d.cz[at]);
  if (sinking) {
    dummy.quaternion.copy(d.quats[d.moves]);
  } else {
    // 床下に隠れているあいだに、歩き出しのマスと姿勢へ戻しておく
    rest.copy(d.quats[d.moves]).slerp(d.quats[0], clamp01(f / 0.42));
    dummy.quaternion.copy(rest);
  }
  return SINK_GLOW * (sinking ? e : 1 - e);
}

export const diceField: SceneModule = {
  name: 'Dice Field',
  desc: '広い盤に散らばった 6 つの立方体が、辺で倒れて気まぐれな隣のマスへ移り、やがて盤に沈む。',
  camera: { pos: [0, 14.8, 17.8], target: [0, 0.4, 0] },

  build(root) {
    buildDice();
    landTicks = tickers(COUNT);
    sinkTicks = tickers(COUNT);

    const floor = new THREE.Mesh(
      new THREE.BoxGeometry(SPAN_X + CELL * 0.6, 0.8, SPAN_Z + CELL * 0.6),
      new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.62, metalness: 0.28 }),
    );
    floor.position.y = -0.4;
    root.add(floor);

    // 盤の罫線。マス目が読めるだけの明るさに留める
    const pts: number[] = [];
    for (let i = 0; i <= CELLS_Z; i++) {
      const p = (i - CELLS_Z / 2) * CELL;
      pts.push(-SPAN_X / 2, 0.01, p, SPAN_X / 2, 0.01, p);
    }
    for (let i = 0; i <= CELLS_X; i++) {
      const p = (i - CELLS_X / 2) * CELL;
      pts.push(p, 0.01, -SPAN_Z / 2, p, 0.01, SPAN_Z / 2);
    }
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    root.add(
      new THREE.LineSegments(
        lineGeo,
        new THREE.LineBasicMaterial({ color: emberColor(LINE_N), transparent: true, opacity: 0.55 }),
      ),
    );

    body = new THREE.InstancedMesh(
      new THREE.BoxGeometry(DIE, DIE, DIE),
      new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.28 }),
      COUNT,
    );
    body.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    root.add(body);
  },

  update(t) {
    const shift = drift(t);
    for (let i = 0; i < COUNT; i++) {
      const d = dice[i];
      const per = d.moves + 2; // 転がり + 沈む + 戻る
      const p = (t + d.off) / d.step;
      const kg = Math.floor(p);
      const m = ((kg % per) + per) % per;
      const glow = place(d, m, p - kg);

      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      body.setMatrixAt(i, dummy.matrix);
      ember(color, d.n, shift, glow);
      body.setColorAt(i, color);
    }
    body.instanceMatrix.needsUpdate = true;
    if (body.instanceColor) body.instanceColor.needsUpdate = true;
  },

  sound(t, _dt, sfx) {
    for (let i = 0; i < COUNT; i++) {
      const d = dice[i];
      const per = d.moves + 2;
      const p = (t + d.off) / d.step;

      // 着地は 1 手のうち ROLL_FRAC の位相。全部鳴らすと団子になるので 2 つに 1 つ
      for (let c = landTicks[i](p - ROLL_FRAC); c > 0; c--) {
        if (i % 2 !== 0) continue;
        const k = Math.floor(p - ROLL_FRAC);
        const mm = ((k % per) + per) % per;
        if (mm < d.moves) {
          sfx.pluck(tone(d.note), { gain: 0.19, decay: 1.1, pan: panAt(d.cx[mm + 1]) });
        }
      }
      for (let c = sinkTicks[i](p); c > 0; c--) {
        const k = Math.floor(p);
        if (((k % per) + per) % per === d.moves) {
          sfx.drop(tone(d.note - 5), { gain: 0.26, decay: 0.7, pan: panAt(d.cx[d.moves]) });
        }
      }
    }
  },
};
