import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, ticker } from '../audio.ts';
import { ember, drift } from '../palette.ts';

const N = 54; // リングの本数
const R = 8.5; // 球の半径

const color = new THREE.Color();
const rings: THREE.Mesh<THREE.TorusGeometry, THREE.MeshStandardMaterial>[] = [];
let pivot: THREE.Group;

/** 呼吸 1 回ぶんを数える */
let tickBreath = ticker();

/** 球を緯度で輪切りにしたリング群。上下に走る波で半径が脈打つ。 */
export const breathingRings: SceneModule = {
  name: 'Breathing Rings',
  desc: '球体を輪切りにした 54 本のリング。上下に走る波でゆっくり呼吸する。',
  camera: { pos: [0, 7, 28], target: [0, 0, 0] },

  build(root) {
    tickBreath = ticker();

    rings.length = 0;
    pivot = new THREE.Group();
    root.add(pivot);

    const geo = new THREE.TorusGeometry(1, 0.018, 8, 128);
    for (let i = 0; i < N; i++) {
      const mesh = new THREE.Mesh(
        geo,
        new THREE.MeshStandardMaterial({
          roughness: 0.25,
          metalness: 0.5,
          emissive: new THREE.Color(),
          emissiveIntensity: 0.7,
        }),
      );
      mesh.rotation.x = Math.PI / 2; // トーラスを XZ 平面に寝かせる
      pivot.add(mesh);
      rings.push(mesh);
    }
  },

  update(t, dt) {
    pivot.rotation.y += dt * 0.14;
    const d = drift(t);

    for (let i = 0; i < N; i++) {
      const th = (Math.PI * (i + 0.5)) / N; // 0..π（北極 → 南極）
      const wave = Math.sin(th * 5 - t * 1.6);
      const n = 0.5 + 0.5 * wave;

      const mesh = rings[i]!;
      mesh.position.y = R * Math.cos(th) * 1.02;
      mesh.scale.setScalar(Math.max(R * Math.sin(th) * (1 + 0.14 * wave), 0.02));
      // 1本おきに逆回転させると、静止画でも縞が生きる
      mesh.rotation.z = th * 2 + t * 0.25 * (i % 2 ? 1 : -1);

      ember(color, n * 0.82, d); // 就寝前に眩しくならない明るさへ抑える
      mesh.material.color.copy(color);
      mesh.material.emissive.copy(color).multiplyScalar(0.45);
    }
  },

  sound(t, _dt, sfx) {
    // 半径の脈動（約 3.9 秒周期）に音量を合わせ、呼吸そのものを聞かせる
    const breath = 0.5 + 0.5 * Math.sin(t * 1.6);
    sfx.drone(tone(0), 0.18 + breath * 0.22);

    for (let k = tickBreath((t * 1.6) / (Math.PI * 2)); k > 0; k--) {
      sfx.air({ gain: 0.22, decay: 2.2, freq: 420, q: 1.2, sweep: 1.6 });
    }
  },
};
