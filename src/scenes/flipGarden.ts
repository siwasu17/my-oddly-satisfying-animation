import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { ember, drift } from '../palette.ts';

const COUNT = 1800;
const RADIUS = 15;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

const dummy = new THREE.Object3D();
dummy.rotation.order = 'YXZ'; // 先に向きを決めてから、その軸まわりにめくる
const color = new THREE.Color();

let mesh: THREE.InstancedMesh;
/** タイルごとの [x, z, 中心からの距離] */
const tiles = new Float32Array(COUNT * 3);

/** ひまわりの種の並び（黄金角スパイラル）にタイルを敷き、外へ向かって順にめくる。 */
export const flipGarden: SceneModule = {
  name: 'Flip Garden',
  desc: 'ひまわりの黄金角で並んだ 1800 枚のタイルが、外へ向かって順にめくれる。',
  camera: { pos: [0, 16, 26], target: [0, 0.6, 0] },

  build(root) {
    for (let i = 0; i < COUNT; i++) {
      const r = Math.sqrt((i + 0.5) / COUNT) * RADIUS;
      const a = i * GOLDEN_ANGLE;
      tiles[i * 3] = Math.cos(a) * r;
      tiles[i * 3 + 1] = Math.sin(a) * r;
      tiles[i * 3 + 2] = r;
    }

    const geo = new THREE.CylinderGeometry(0.26, 0.26, 0.045, 24);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.28, metalness: 0.6 });
    mesh = new THREE.InstancedMesh(geo, mat, COUNT);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    root.add(mesh);
  },

  update(t) {
    const d = drift(t);
    for (let i = 0; i < COUNT; i++) {
      const x = tiles[i * 3]!;
      const z = tiles[i * 3 + 1]!;
      const r = tiles[i * 3 + 2]!;
      const phase = r * 0.5 - t * 1.5; // 位相が外周へ遅れていくので波として見える
      const flip = Math.sin(phase) * Math.PI * 0.85;
      const n = 0.5 + 0.5 * Math.cos(phase);

      dummy.position.set(x, 0.1 + n * 0.9, z);
      dummy.rotation.set(flip, Math.atan2(z, x), 0);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);

      ember(color, n, d);
      mesh.setColorAt(i, color);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  },
};
