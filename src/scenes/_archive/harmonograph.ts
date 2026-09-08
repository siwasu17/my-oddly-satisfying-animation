import * as THREE from 'three';
import type { SceneModule } from '../../types.ts';
import { tone, ticker } from '../../audio.ts';
import { ember, drift } from '../../palette.ts';

/**
 * Harmonograph。
 *
 * 何が動くか: 2軸の振動が花びら状に重なって描くバラ曲線を、太い先頭が
 * なぞっていく。軌跡は帯として常に一周ぶん残り続け、頭から離れるほど
 * 細く暗く沈んでいく。
 * 気持ちよさの芯: 軌跡の長さをちょうど周期と揃えてあるので、帯の末端は
 * 数学的に必ず先頭の現在位置と重なる。花びらの形は常に閉じたまま、
 * 明るい頭だけがその輪郭を巡り続ける。
 * ループの周期: PERIOD 秒（花びらの数 PETALS*2 が決める形は、角度が
 * ちょうど1周する PERIOD 秒ごとに寸分違わず同じ形へ戻る）。
 * カメラ: ほぼ真上からの俯瞰。
 * 音: 先頭点が中心から離れるほど低い持続音がわずかに膨らみ、頭が一周して
 * 元の位相へ戻るたびに澄んだ一音を鳴らす。
 * スコープ外: 複数の振り子や手を加えた操作、曲線の色分けによる速度表示。
 */

/** 1 周にかかる秒数。曲線の速さはここで決まる */
const PERIOD = 24;
/** 軌跡を何本の線分でつなぐか。ちょうど 1 周ぶんを描くように間隔が決まる */
const SEGMENTS = 220;
/** 曲線の広がり（花びらの先端までの距離） */
const RADIUS = 6;
/** 花びらの対の数（2 なら花びら4枚、3 なら6枚） */
const PETALS = 2;
/** 高さの上下（整数倍でないと閉じない） */
const NY = 1;
/** 帯の基本の太さ */
const TUBE_R = 0.05;
/** 先頭付近だけ太く明るくする範囲（軌跡全体に対する割合） */
const HEAD_FRAC = 0.06;

const ANGULAR = (Math.PI * 2) / PERIOD;

const dummy = new THREE.Object3D();
const color = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);
const p0 = new THREE.Vector3();
const p1 = new THREE.Vector3();
const segDir = new THREE.Vector3();

let mesh: THREE.InstancedMesh;

/** 頭が一周して元の位相へ戻った回数を数える。build のたびに作り直す。 */
let tick = ticker();

function curveX(u: number): number {
  const a = ANGULAR * u;
  return RADIUS * Math.cos(PETALS * a) * Math.cos(a);
}
function curveZ(u: number): number {
  const a = ANGULAR * u;
  return RADIUS * Math.cos(PETALS * a) * Math.sin(a);
}
function curveY(u: number): number {
  return 0.55 + 0.25 * Math.sin(NY * ANGULAR * u);
}

/** 頭が一周の区切りにどれだけ近いか。0=遠い、1=区切りそのもの */
function wrapPulse(t: number): number {
  const cycle = ((t / PERIOD) % 1 + 1) % 1;
  const dist = Math.min(cycle, 1 - cycle);
  return Math.exp(-(dist * dist) / (2 * 0.012 * 0.012));
}

export const harmonograph: SceneModule = {
  name: 'Harmonograph',
  desc: '振り子が描く花びら状の曲線を、明るい先頭が常に閉じたまま巡り続ける。',
  camera: { pos: [0, 18, 7], target: [0, 0.4, 0] },

  build(root) {
    tick = ticker();

    const geo = new THREE.CylinderGeometry(TUBE_R, TUBE_R, 1, 8);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.3, metalness: 0.4 });
    mesh = new THREE.InstancedMesh(geo, mat, SEGMENTS);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    root.add(mesh);
  },

  // 形は毎フレーム t から作り直す。各線分の両端は「t からどれだけ過去か」を
  // 表す固定オフセットで求めるので、差分を積み上げることにはならない。
  update(t) {
    const step = PERIOD / SEGMENTS;
    const pulse = wrapPulse(t);
    const hue = drift(t);

    for (let i = 0; i < SEGMENTS; i++) {
      const u0 = t - i * step;
      const u1 = u0 - step;
      p0.set(curveX(u0), curveY(u0), curveZ(u0));
      p1.set(curveX(u1), curveY(u1), curveZ(u1));

      const frac = i / (SEGMENTS - 1); // 0 = 先頭、1 = 尾の端（= 先頭の1周前）
      const headBoost = Math.max(0, 1 - frac / HEAD_FRAC);

      segDir.subVectors(p1, p0);
      const len = segDir.length() || 0.0001;
      dummy.position.copy(p0).addScaledVector(segDir, 0.5);
      dummy.quaternion.setFromUnitVectors(UP, segDir.normalize());
      const radiusScale = 1 + headBoost ** 2 * 3 + pulse * headBoost ** 4 * 2;
      dummy.scale.set(radiusScale, len, radiusScale);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);

      const n = 1 - frac * 0.65;
      const glow = headBoost * (0.5 + pulse * 0.5);
      ember(color, n, hue, glow);
      mesh.setColorAt(i, color);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  },

  // 音が ON のときだけ、update と同じ t で呼ばれる。
  // ここに映像へ影響する処理を書かないこと（OFF の間は呼ばれない）。
  sound(t, _dt, sfx) {
    const r = Math.hypot(curveX(t), curveZ(t)) / RADIUS; // 0..1、中心からの距離
    sfx.drone(tone(-5), 0.05 + 0.05 * r);

    for (let k = tick(t / PERIOD); k > 0; k--) {
      sfx.pluck(tone(0), { gain: 0.5, decay: 3.4, pan: 0 });
    }
  },
};
