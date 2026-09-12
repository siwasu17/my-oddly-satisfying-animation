import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, tickers } from '../audio.ts';
import { SURFACE, ember, emberColor, drift } from '../palette.ts';

/**
 * 何が動くか: 格子の盤に置かれた 6 つの無地の立方体が、辺を軸にコトンと倒れて隣のマスへ移る。
 * 気持ちよさの芯: 立方体が辺で持ち上がって落ちる「間」と、面の陰影が入れ替わる瞬間。
 *   一周し終えた立方体は盤へすっと沈み、また同じマスからせり上がってくる。
 * ループの周期: 1 手 1.2〜1.8 秒。各立方体は 8〜16 手で沈降まで一巡し、位相はばらばら。
 * カメラ: 盤全体が入る俯瞰。
 * 音: 着地に pluck（2 つに 1 つの立方体だけ）、沈む瞬間に drop。
 * スコープ外: サイコロの目、立方体同士の衝突（各自 2x2 のブロック内を周回する）。
 */

// ---- 調整する数値 ----
const BLOCKS_X = 3; // 横のブロック数（1 ブロック = 2x2 マス）
const BLOCKS_Z = 2; // 奥行きのブロック数。立方体は BLOCKS_X * BLOCKS_Z 個
const CELL = 2.3; // マスの一辺
const DIE = 1.96; // 立方体の一辺
const DEPTH = DIE * 2.1; // 沈む深さ
const ROLL_FRAC = 0.34; // 1 手のうち転がりに使う割合（残りは静止して「間」になる）
const STEP_MIN = 1.2; // 1 手の秒数
const STEP_VAR = 0.6;
const BODY_N = 0.34; // 立方体の色
const BODY_VAR = 0.16;
const SINK_GLOW = 0.2; // 沈むときに持ち上げる明度
const LINE_N = 0.2; // 盤の罫線
const COUNT = BLOCKS_X * BLOCKS_Z;

/** 1 個ぶんの周回路と姿勢。すべて build で決めて update からは読むだけ。 */
interface Die {
  n: number; // 本体の色
  step: number; // 1 手の秒数
  off: number; // 位相オフセット
  moves: number; // 沈むまでの手数（4 の倍数なので開始マスへ戻る）
  cx: Float32Array; // 各手の開始マス中心
  cz: Float32Array;
  dx: Float32Array; // 各手の進む向き
  dz: Float32Array;
  quats: THREE.Quaternion[]; // 各手の開始姿勢
  pan: number;
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

const smooth = (x: number): number => x * x * (3 - 2 * x);
const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** 立方体 1 個ぶんの周回路と、各手の姿勢を先に全部求めておく。 */
function buildDice(): void {
  let s = 0.317;
  const rnd = (): number => (s = (s * 9301 + 0.49297) % 1);
  const halfX = BLOCKS_X - 0.5;
  const halfZ = BLOCKS_Z - 0.5;
  const step = new THREE.Quaternion();
  dice.length = 0;

  for (let bj = 0; bj < BLOCKS_Z; bj++) {
    for (let bi = 0; bi < BLOCKS_X; bi++) {
      const c0 = bi * 2;
      const r0 = bj * 2;
      const corners = [
        [c0, r0],
        [c0 + 1, r0],
        [c0 + 1, r0 + 1],
        [c0, r0 + 1],
      ];
      const turn = rnd() < 0.5 ? 1 : 3; // 時計回りか反時計回りか
      const start = Math.floor(rnd() * 4) % 4;
      const moves = 8 + Math.floor(rnd() * 2.99) * 4; // 8 / 12 / 16 手で開始マスへ戻る

      const cx = new Float32Array(moves + 1);
      const cz = new Float32Array(moves + 1);
      for (let m = 0; m <= moves; m++) {
        const c = corners[(start + turn * m) % 4];
        cx[m] = (c[0] - halfX) * CELL;
        cz[m] = (c[1] - halfZ) * CELL;
      }

      const dx = new Float32Array(moves);
      const dz = new Float32Array(moves);
      const quats: THREE.Quaternion[] = [new THREE.Quaternion()];
      for (let m = 0; m < moves; m++) {
        dx[m] = (cx[m + 1] - cx[m]) / CELL;
        dz[m] = (cz[m + 1] - cz[m]) / CELL;
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
        pan: (cx[0] / (BLOCKS_X * CELL)) * 0.7,
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
  dummy.position.set(d.cx[0], half - DEPTH * drop, d.cz[0]);
  if (sinking) {
    dummy.quaternion.copy(d.quats[d.moves]);
  } else {
    // 床下に隠れているあいだに、開始姿勢へ戻しておく
    rest.copy(d.quats[d.moves]).slerp(d.quats[0], clamp01(f / 0.42));
    dummy.quaternion.copy(rest);
  }
  return SINK_GLOW * (sinking ? e : 1 - e);
}

export const diceField: SceneModule = {
  name: 'Dice Field',
  desc: 'マス目に置かれた 6 つの立方体が辺で倒れて隣へ移り、一周すると盤に沈んでまたせり上がる。',
  camera: { pos: [0, 7.2, 8.6], target: [0, 0.6, 0] },

  build(root) {
    buildDice();
    landTicks = tickers(COUNT);
    sinkTicks = tickers(COUNT);

    const spanX = BLOCKS_X * 2 * CELL;
    const spanZ = BLOCKS_Z * 2 * CELL;

    const floor = new THREE.Mesh(
      new THREE.BoxGeometry(spanX + CELL * 0.6, 0.8, spanZ + CELL * 0.6),
      new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.62, metalness: 0.28 }),
    );
    floor.position.y = -0.4;
    root.add(floor);

    // 盤の罫線。マス目が読めるだけの明るさに留める
    const pts: number[] = [];
    for (let i = 0; i <= BLOCKS_Z * 2; i++) {
      const p = (i - BLOCKS_Z) * CELL;
      pts.push(-spanX / 2, 0.01, p, spanX / 2, 0.01, p);
    }
    for (let i = 0; i <= BLOCKS_X * 2; i++) {
      const p = (i - BLOCKS_X) * CELL;
      pts.push(p, 0.01, -spanZ / 2, p, 0.01, spanZ / 2);
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
        if (((k % per) + per) % per < d.moves) {
          sfx.pluck(tone(d.note), { gain: 0.19, decay: 1.1, pan: d.pan });
        }
      }
      for (let c = sinkTicks[i](p); c > 0; c--) {
        const k = Math.floor(p);
        if (((k % per) + per) % per === d.moves) {
          sfx.drop(tone(d.note - 5), { gain: 0.26, decay: 0.7, pan: d.pan });
        }
      }
    }
  },
};
