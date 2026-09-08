import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, tickers } from '../audio.ts';
import { SURFACE, ember, emberColor, drift } from '../palette.ts';

/**
 * 何が動くか: 格子の盤に並んだサイコロが、辺を軸にコトンと倒れて隣のマスへ移る。
 * 気持ちよさの芯: 立方体が辺で持ち上がって落ちる「間」と、そのたび入れ替わる目の面。
 *   一周し終えたサイコロは盤へすっと沈み、目を変えてまたせり上がってくる。
 * ループの周期: 1 手 1.2〜1.8 秒。各サイコロは 10〜18 手で沈降まで一巡し、位相はばらばら。
 * カメラ: 盤全体が入る俯瞰。
 * 音: 着地に pluck（3 つに 1 つのサイコロだけ）、沈む瞬間に drop。
 * スコープ外: 目を揃えて消すパズル判定、サイコロ同士の衝突（各自 2x2 のブロック内を周回する）。
 */

// ---- 調整する数値 ----
const BLOCKS = 4; // 2x2 マスのブロック数。盤は BLOCKS*2 マス四方
const CELL = 2.3; // マスの一辺
const DIE = 1.96; // サイコロの一辺
const PIP_R = DIE * 0.088; // 目の半径
const PIP_OFF = DIE * 0.26; // 目の面内オフセット
const DEPTH = DIE * 2.1; // 沈む深さ
const ROLL_FRAC = 0.34; // 1 手のうち転がりに使う割合（残りは静止して「間」になる）
const STEP_MIN = 1.2; // 1 手の秒数
const STEP_VAR = 0.6;
const BODY_N = 0.3; // サイコロ本体の色（暗い）
const BODY_VAR = 0.16;
const PIP_N = 0.68; // 目の色（少し滲む明るさ）
const SINK_GLOW = 0.2; // 沈むときに持ち上げる明度
const LINE_N = 0.2; // 盤の罫線
const COUNT = BLOCKS * BLOCKS;
const PIPS = 21; // 1〜6 の目の合計

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
const pipLocal: THREE.Vector3[] = [];

const dummy = new THREE.Object3D();
const color = new THREE.Color();
const spin = new THREE.Quaternion();
const rest = new THREE.Quaternion();
const axis = new THREE.Vector3();
const rel = new THREE.Vector3();
const pipMat = new THREE.Matrix4();
const pipOffset: THREE.Matrix4[] = [];

let body: THREE.InstancedMesh;
let pips: THREE.InstancedMesh;
let landTicks: ((phase: number) => number)[] = [];
let sinkTicks: ((phase: number) => number)[] = [];

const smooth = (x: number): number => x * x * (3 - 2 * x);
const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** 6 面ぶんの目を立方体のローカル座標に並べる。対面の和は 7。 */
function buildPips(): void {
  const faces: [THREE.Vector3, THREE.Vector3, THREE.Vector3, number][] = [
    [new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1), 1],
    [new THREE.Vector3(0, -1, 0), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, -1), 6],
    [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 1, 0), 2],
    [new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0), 5],
    [new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), 3],
    [new THREE.Vector3(0, 0, -1), new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 1, 0), 4],
  ];
  const spots: number[][][] = [
    [[0, 0]],
    [
      [-1, -1],
      [1, 1],
    ],
    [
      [-1, -1],
      [0, 0],
      [1, 1],
    ],
    [
      [-1, -1],
      [-1, 1],
      [1, -1],
      [1, 1],
    ],
    [
      [-1, -1],
      [-1, 1],
      [0, 0],
      [1, -1],
      [1, 1],
    ],
    [
      [-1, -1],
      [-1, 0],
      [-1, 1],
      [1, -1],
      [1, 0],
      [1, 1],
    ],
  ];
  const depth = DIE * 0.5 - PIP_R * 0.3;
  pipLocal.length = 0;
  for (const [n, u, v, value] of faces) {
    for (const [a, b] of spots[value - 1]) {
      pipLocal.push(
        new THREE.Vector3(
          n.x * depth + u.x * a * PIP_OFF + v.x * b * PIP_OFF,
          n.y * depth + u.y * a * PIP_OFF + v.y * b * PIP_OFF,
          n.z * depth + u.z * a * PIP_OFF + v.z * b * PIP_OFF,
        ),
      );
    }
  }
}

/** サイコロ 1 個ぶんの周回路と、各手の姿勢を先に全部求めておく。 */
function buildDice(): void {
  let s = 0.317;
  const rnd = (): number => (s = (s * 9301 + 0.49297) % 1);
  const half = BLOCKS - 0.5;
  const step = new THREE.Quaternion();
  dice.length = 0;

  for (let bj = 0; bj < BLOCKS; bj++) {
    for (let bi = 0; bi < BLOCKS; bi++) {
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
        cx[m] = (c[0] - half) * CELL;
        cz[m] = (c[1] - half) * CELL;
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
        pan: (cx[0] / (BLOCKS * CELL)) * 0.7,
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
    // 床下に隠れているあいだに、開始姿勢へ戻す（目が変わったように見える）
    rest.copy(d.quats[d.moves]).slerp(d.quats[0], clamp01(f / 0.42));
    dummy.quaternion.copy(rest);
  }
  return SINK_GLOW * (sinking ? e : 1 - e);
}

export const diceField: SceneModule = {
  name: 'Dice Field',
  desc: 'マス目のサイコロが辺で倒れて隣へ移り、一周すると盤に沈んで目を変えて戻る。',
  camera: { pos: [0, 10.5, 12.5], target: [0, 1, 0] },

  build(root) {
    buildPips();
    buildDice();
    landTicks = tickers(COUNT);
    sinkTicks = tickers(COUNT);

    const span = BLOCKS * 2 * CELL;

    const floor = new THREE.Mesh(
      new THREE.BoxGeometry(span + CELL * 0.6, 0.8, span + CELL * 0.6),
      new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.62, metalness: 0.28 }),
    );
    floor.position.y = -0.4;
    root.add(floor);

    // 盤の罫線。マス目が読めるだけの明るさに留める
    const pts: number[] = [];
    for (let i = 0; i <= BLOCKS * 2; i++) {
      const p = (i - BLOCKS) * CELL;
      pts.push(-span / 2, 0.01, p, span / 2, 0.01, p);
      pts.push(p, 0.01, -span / 2, p, 0.01, span / 2);
    }
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    root.add(
      new THREE.LineSegments(
        lineGeo,
        new THREE.LineBasicMaterial({ color: emberColor(LINE_N), transparent: true, opacity: 0.55 }),
      ),
    );

    const dieGeo = new THREE.BoxGeometry(DIE, DIE, DIE);
    body = new THREE.InstancedMesh(
      dieGeo,
      new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.28 }),
      COUNT,
    );
    body.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    root.add(body);

    pips = new THREE.InstancedMesh(
      new THREE.SphereGeometry(PIP_R, 10, 8),
      new THREE.MeshStandardMaterial({ roughness: 0.42, metalness: 0.1 }),
      COUNT * PIPS,
    );
    pips.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    root.add(pips);

    pipOffset.length = 0;
    for (const p of pipLocal) pipOffset.push(new THREE.Matrix4().makeTranslation(p.x, p.y, p.z));
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

      ember(color, PIP_N, shift, glow);
      for (let j = 0; j < PIPS; j++) {
        pipMat.multiplyMatrices(dummy.matrix, pipOffset[j]);
        pips.setMatrixAt(i * PIPS + j, pipMat);
        pips.setColorAt(i * PIPS + j, color);
      }
    }
    body.instanceMatrix.needsUpdate = true;
    pips.instanceMatrix.needsUpdate = true;
    if (body.instanceColor) body.instanceColor.needsUpdate = true;
    if (pips.instanceColor) pips.instanceColor.needsUpdate = true;
  },

  sound(t, _dt, sfx) {
    for (let i = 0; i < COUNT; i++) {
      const d = dice[i];
      const per = d.moves + 2;
      const p = (t + d.off) / d.step;

      // 着地は 1 手のうち ROLL_FRAC の位相。全部鳴らすと団子になるので 3 つに 1 つ
      for (let c = landTicks[i](p - ROLL_FRAC); c > 0; c--) {
        if (i % 3 !== 0) continue;
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
