import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { SURFACE, ember, drift } from '../palette.ts';

const N = 46; // 1辺のバー本数
const GAP = 0.66; // バーの間隔

const dummy = new THREE.Object3D();
const color = new THREE.Color();

let mesh: THREE.InstancedMesh;

/** 中心から円形に広がる正弦波で、格子状のバーを持ち上げる。 */
export const waveLattice: SceneModule = {
  name: 'Wave Lattice',
  desc: '中心から広がる正弦波が、格子状のバーを一本ずつ持ち上げていく。',
  camera: { pos: [8, 19, 30], target: [0, 1.2, 0] },

  build(root) {
    const geo = new THREE.BoxGeometry(0.42, 1, 0.42);
    geo.translate(0, 0.5, 0); // 原点を底面へ移し、Y スケールだけで伸ばせるようにする
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.32, metalness: 0.45 });

    mesh = new THREE.InstancedMesh(geo, mat, N * N);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    root.add(mesh);

    // 金属質の床。バーが薄く映り込んで奥行きが出る
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(N * GAP * 0.78, 96),
      new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.25, metalness: 0.9 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.02;
    root.add(floor);
  },

  update(t) {
    const hue = drift(t);
    const half = (N - 1) / 2;
    let i = 0;
    for (let a = 0; a < N; a++) {
      const x = (a - half) * GAP;
      for (let b = 0; b < N; b++, i++) {
        const z = (b - half) * GAP;
        const d = Math.hypot(x, z);
        const ang = Math.atan2(z, x);
        // 外向きに進む波に、ゆっくり回るスパイラルを重ねて単調さを消す
        const w = Math.sin(d * 0.62 - t * 1.9 + Math.sin(ang * 3 + t * 0.4) * 0.6);
        const n = 0.5 + 0.5 * w; // 0..1
        const falloff = 1 / (1 + d * 0.055); // 外周ほど低くして視線を中央に集める

        dummy.position.set(x, 0, z);
        dummy.scale.set(1, 0.35 + n * 5.4 * falloff, 1);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);

        ember(color, n, hue);
        mesh.setColorAt(i, color);
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  },
};
