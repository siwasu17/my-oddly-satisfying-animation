import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, tickers } from '../audio.ts';
import { ember, drift } from '../palette.ts';

const COUNT = 190;
const SPREAD = 11; // 湧き出す範囲の半径
const TOP = 15; // 消えていく高さ
const BOTTOM = -9; // 生まれる高さ

const dummy = new THREE.Object3D();
const color = new THREE.Color();

let mesh: THREE.InstancedMesh;
let pivot: THREE.Group;
/** 泡ごとの [x, z, 半径, 上る速さ, 位相] */
const bubbles = new Float32Array(COUNT * 5);

/** 泡ごとに、水面へ抜けた回数を数える */
let ticks = tickers(COUNT);

/** ぬるい水の中を、大小の泡がゆっくり昇っていく。 */
export const driftingBubbles: SceneModule = {
  name: 'Drifting Bubbles',
  desc: '大きさの違う泡が、ゆらゆらと横に揺れながら暗がりを昇っていく。',
  camera: { pos: [0, 3, 31], target: [0, 1.5, 0] },

  build(root) {
    ticks = tickers(COUNT);

    let s = 0.731;
    const rnd = (): number => (s = (s * 9301 + 0.49297) % 1);

    for (let i = 0; i < COUNT; i++) {
      const a = rnd() * Math.PI * 2;
      const r = Math.sqrt(rnd()) * SPREAD;
      bubbles[i * 5] = Math.cos(a) * r;
      bubbles[i * 5 + 1] = Math.sin(a) * r;
      bubbles[i * 5 + 2] = 0.13 + rnd() * 0.42;
      bubbles[i * 5 + 3] = 0.02 + rnd() * 0.028; // 大きい泡ほど速い、とはしない
      bubbles[i * 5 + 4] = rnd();
    }

    pivot = new THREE.Group();
    root.add(pivot);

    mesh = new THREE.InstancedMesh(
      new THREE.SphereGeometry(1, 20, 14),
      new THREE.MeshStandardMaterial({ roughness: 0.18, metalness: 0.25 }),
      COUNT,
    );
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    pivot.add(mesh);
  },

  update(t, dt) {
    pivot.rotation.y += dt * 0.03; // 視点がわずかに流れて、同じ絵が続かない
    const d = drift(t);
    const span = TOP - BOTTOM;

    for (let i = 0; i < COUNT; i++) {
      const x = bubbles[i * 5]!;
      const z = bubbles[i * 5 + 1]!;
      const rad = bubbles[i * 5 + 2]!;
      const speed = bubbles[i * 5 + 3]!;
      const ph = bubbles[i * 5 + 4]!;

      const u = ((t * speed + ph) % 1 + 1) % 1; // 0 = 底、1 = 上端
      const y = BOTTOM + u * span;
      // 昇りながら左右に蛇行する。位相をずらして全体が同じ動きにならないように
      const sway = Math.sin(t * 0.5 + ph * 40 + u * 6) * (0.5 + rad);

      dummy.position.set(x + sway, y, z + Math.cos(t * 0.42 + ph * 27) * 0.5);
      dummy.scale.setScalar(rad);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);

      // 上下の端では背景へ溶けるように暗くして、湧き出しと消滅を隠す
      const fade = Math.min(u / 0.18, (1 - u) / 0.22, 1);
      ember(color, 0.4 + rad * 0.7, d);
      color.multiplyScalar(Math.max(fade, 0));
      mesh.setColorAt(i, color);
    }

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  },

  sound(t, _dt, sfx) {
    sfx.drone(tone(-5), 0.14); // 水の底に溜まった低い唸り

    // 4 個に 1 つ、水面へ抜けた瞬間だけ鳴らす
    for (let i = 0; i < COUNT; i += 4) {
      const rad = bubbles[i * 5 + 2]!;
      const phase = t * bubbles[i * 5 + 3]! + bubbles[i * 5 + 4]!;
      for (let k = ticks[i]!(phase); k > 0; k--) {
        sfx.drop(tone(13 - Math.round(rad * 12)), { // 大きい泡ほど低く鳴る
          gain: 0.3,
          decay: 0.7,
          pan: bubbles[i * 5]! / SPREAD,
          bend: 0.4,
        });
      }
    }
  },
};
