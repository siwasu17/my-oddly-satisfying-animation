import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tickers } from '../audio.ts';
import { SURFACE, ember, drift } from '../palette.ts';

/**
 * Spiral Fall。
 *
 * 何が動くか: 先端が尖った葉の形をした板が中心の高い位置から放たれ、螺旋を描きながら
 *   ゆっくり降下する。降下の途中で不規則に上昇気流に乗り、ふわっと持ち上がって
 *   巻き返す瞬間を挟みながら地面へ近づいていく。
 * 気持ちよさの芯: 一定速度で落ちるのではなく、落下と巻き返しが不規則に
 *   織り交ざることで生まれる滞空感。
 * ループの周期: 各葉は 10〜12 秒の個別サイクルで降下しきると、頂点からまた放たれる。
 *   開始位相を葉ごとに等間隔でずらしてあるので、常にどこかの葉が巻き返している。
 * カメラ: 少し見上げる角度の斜め俯瞰。
 * 音: 巻き返しの瞬間に、風を切るような短い一音を数枚おきに鳴らす。
 * スコープ外: 風向きの変化、葉の種類分け、地面に積もる演出。
 */

/** 葉の枚数 */
const COUNT = 30;
/** 音を鳴らす間引き間隔（この数枚に 1 枚だけ鳴らす） */
const SOUND_STRIDE = 5;

/** 半径は降下が進むほど中心から外側へ広がる（+ 葉ごとの微小なばらつき） */
const R_MIN = 2.2;
const R_MAX = 7.6;
const R_JITTER = 0.5;
/** 角速度と周期のばらつき幅を狭くし、葉どうしの相対位置を保って螺旋の腕として見せる */
const ANGULAR_SPEED_BASE = 0.24;
const ANGULAR_SPEED_JITTER = 0.05;
const PERIOD_BASE = 11;
const PERIOD_JITTER = 2;
/** 降下する高さの範囲 */
const TOP_Y = 11;
const BOTTOM_Y = -1;
const SPAN_Y = TOP_Y - BOTTOM_Y;
/** 巻き返しで持ち上がる量 */
const BUMP_AMP = SPAN_Y * 0.14;

/** 葉 1 枚あたりのパラメータ数と意味 */
const STRIDE = 9; // [angle0, angularSpeed, radiusJitter, period, phaseOffset, bumpFreq, bumpPhase, flutterPhase, flutterSpeed]

const dummy = new THREE.Object3D();
const color = new THREE.Color();

let mesh: THREE.InstancedMesh;
const params = new Float32Array(COUNT * STRIDE);

/** 巻き返しの位相が整数をまたいだ回数を数える。build のたびに作り直す */
let ticks: ((phase: number) => number)[] = [];

let s = 0.731;
const rnd = (): number => (s = (s * 9301 + 0.49297) % 1);

/** 先端が尖った葉のシルエット。原点は葉の中心、長さ方向は Z 軸に合わせてある */
function leafGeometry(): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(0, -0.5);
  shape.quadraticCurveTo(0.2, -0.3, 0.15, 0.08);
  shape.lineTo(0.045, 0.4);
  shape.lineTo(0, 0.52);
  shape.lineTo(-0.045, 0.4);
  shape.lineTo(-0.15, 0.08);
  shape.quadraticCurveTo(-0.2, -0.3, 0, -0.5);

  const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.015, bevelEnabled: false });
  geo.rotateX(-Math.PI / 2);
  return geo;
}

export const spiralFall: SceneModule = {
  name: 'Spiral Fall',
  desc: '葉が螺旋を描きながら落ち、時おり上昇気流にふわりと巻き返される。',
  camera: { pos: [8, 7, 19], target: [0, 5.5, 0] },

  build(root) {
    s = 0.731;
    ticks = tickers(Math.ceil(COUNT / SOUND_STRIDE));

    for (let i = 0; i < COUNT; i++) {
      const b = i * STRIDE;
      params[b + 0] = rnd() * Math.PI * 2; // angle0
      params[b + 1] = ANGULAR_SPEED_BASE + (rnd() - 0.5) * ANGULAR_SPEED_JITTER; // angularSpeed
      params[b + 2] = (rnd() - 0.5) * R_JITTER; // radiusJitter
      params[b + 3] = PERIOD_BASE + (rnd() - 0.5) * PERIOD_JITTER; // period
      params[b + 4] = (i / COUNT) * PERIOD_BASE; // phaseOffset（等間隔に配置し、螺旋の腕として見せる）
      params[b + 5] = 2 + Math.floor(rnd() * 2); // bumpFreq (2 or 3)
      params[b + 6] = rnd() * Math.PI * 2; // bumpPhase
      params[b + 7] = rnd() * Math.PI * 2; // flutterPhase
      params[b + 8] = 1.3 + rnd() * 1.7; // flutterSpeed
    }

    const geo = leafGeometry();
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.08 });

    mesh = new THREE.InstancedMesh(geo, mat, COUNT);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    root.add(mesh);

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(R_MAX * 1.4, 96),
      new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.72, metalness: 0.06 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = BOTTOM_Y - 0.4;
    root.add(floor);
  },

  update(t) {
    const hue = drift(t);
    for (let i = 0; i < COUNT; i++) {
      const b = i * STRIDE;
      const angle0 = params[b + 0];
      const angularSpeed = params[b + 1];
      const radiusJitter = params[b + 2];
      const period = params[b + 3];
      const phaseOffset = params[b + 4];
      const bumpFreq = params[b + 5];
      const bumpPhase = params[b + 6];
      const flutterPhase = params[b + 7];
      const flutterSpeed = params[b + 8];

      const cyclePos = ((t + phaseOffset) % period + period) % period;
      const u = cyclePos / period;
      const a = angle0 + t * angularSpeed;
      const radius = R_MIN + (R_MAX - R_MIN) * u + radiusJitter;

      const bumpWave = Math.max(0, Math.sin(u * Math.PI * 2 * bumpFreq + bumpPhase));
      const bump = bumpWave * bumpWave;

      const y = TOP_Y - SPAN_Y * u + bump * BUMP_AMP;

      dummy.position.set(Math.cos(a) * radius, y, Math.sin(a) * radius);
      dummy.rotation.set(
        0.28 + Math.sin(t * flutterSpeed + flutterPhase) * 0.18,
        -a,
        Math.sin(t * flutterSpeed * 1.3 + flutterPhase * 1.7) * 0.25,
      );
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);

      ember(color, 0.16 + bump * 0.12, hue);
      mesh.setColorAt(i, color);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  },

  sound(t, _dt, sfx) {
    for (let i = 0; i < COUNT; i += SOUND_STRIDE) {
      const b = i * STRIDE;
      const angle0 = params[b + 0];
      const angularSpeed = params[b + 1];
      const period = params[b + 3];
      const phaseOffset = params[b + 4];
      const bumpFreq = params[b + 5];
      const bumpPhase = params[b + 6];

      const phase = ((t + phaseOffset) / period) * bumpFreq + bumpPhase / (Math.PI * 2);
      const idx = i / SOUND_STRIDE;
      const a = angle0 + t * angularSpeed;

      for (let k = ticks[idx](phase); k > 0; k--) {
        sfx.air({
          gain: 0.2,
          decay: 0.8,
          freq: 520 + (i % 7) * 60,
          pan: Math.sin(a) * 0.6,
        });
      }
    }
  },
};
