import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { ember, drift } from '../palette.ts';

const STRANDS = 3;
const BEADS = 150; // 1 本あたりの粒の数
const LEN = 30; // 縄の長さ
const R = 1.9; // 芯からの距離
const TWIST = 0.42; // 単位長さあたりのねじれ
const SPEED = 0.55; // 縄が流れていく速さ

const COUNT = STRANDS * BEADS;

const dummy = new THREE.Object3D();
const color = new THREE.Color();

let mesh: THREE.InstancedMesh;

/** 3 本の紐が互いをくぐりながら、ゆっくり編まれていく。 */
export const braidedHelix: SceneModule = {
  name: 'Braided Helix',
  desc: '3 本の紐が互いをくぐり抜けながら、端から端へ編まれ続ける。',
  camera: { pos: [0, 6, 22], target: [0, 0, 0] },

  build(root) {
    mesh = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.3, 16, 12),
      new THREE.MeshStandardMaterial({ roughness: 0.25, metalness: 0.45 }),
      COUNT,
    );
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    root.add(mesh);
  },

  update(t) {
    const d = drift(t);
    let i = 0;

    for (let k = 0; k < STRANDS; k++) {
      const offset = (k / STRANDS) * Math.PI * 2;

      for (let j = 0; j < BEADS; j++, i++) {
        const u = j / (BEADS - 1);
        const x = (u - 0.5) * LEN;
        const w = x * TWIST + t * SPEED; // 位置と時間で決まるねじれの位相
        const ang = w + offset;
        // 半径を脈動させることで、紐が芯をくぐったり外へ出たりして見える
        const r = R * (1 + 0.42 * Math.sin(2 * w + offset * 2));

        dummy.position.set(x, Math.cos(ang) * r, Math.sin(ang) * r);
        // 端では細くして、縄が霧の中へ吸い込まれるように見せる
        const taper = Math.min(u / 0.12, (1 - u) / 0.12, 1);
        dummy.scale.setScalar(Math.max(taper, 0) * (0.85 + 0.3 * (r / R - 1)));
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);

        ember(color, 0.3 + (r / R - 0.58) * 0.9, d);
        mesh.setColorAt(i, color);
      }
    }

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  },
};
