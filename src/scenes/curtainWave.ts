import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { ember, drift } from '../palette.ts';

const STRANDS = 32; // 垂らす紐の本数
const BEADS = 22; // 1 本あたりの珠の数
const ARC = 20; // 紐を並べる弧の半径。まっすぐ並べるより奥行きが出る
const STEP = 0.042; // 紐 1 本ぶんの角度
const GAP_Y = 0.6; // 珠の間隔
const TOP = 6.4; // 吊り元の高さ
const SWAY = 1.9; // 裾の振れ幅

const COUNT = STRANDS * BEADS;

const dummy = new THREE.Object3D();
const color = new THREE.Color();

let mesh: THREE.InstancedMesh;
/** 紐ごとの [x, z] */
const anchors = new Float32Array(STRANDS * 2);

/** 暗がりに下がった珠のれん。見えない風が端から端へ通り抜けていく。 */
export const curtainWave: SceneModule = {
  name: 'Curtain Wave',
  desc: '暗がりに下がった珠のれんを、見えない風が端から端へ通り抜けていく。',
  camera: { pos: [0, 0.6, 26], target: [0, 0.2, 0] },

  build(root) {
    const half = (STRANDS - 1) / 2;
    for (let s = 0; s < STRANDS; s++) {
      const a = (s - half) * STEP;
      anchors[s * 2] = Math.sin(a) * ARC;
      anchors[s * 2 + 1] = (Math.cos(a) - 1) * ARC; // 端ほど奥へ回り込む
    }

    mesh = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.22, 16, 12),
      new THREE.MeshStandardMaterial({ roughness: 0.25, metalness: 0.45 }),
      COUNT,
    );
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    root.add(mesh);
  },

  update(t) {
    const hue = drift(t);
    let i = 0;

    for (let s = 0; s < STRANDS; s++) {
      const x0 = anchors[s * 2]!;
      const z0 = anchors[s * 2 + 1]!;
      // 紐ごとに位相をずらすと、横方向へ進む一続きの波になる
      const phase = t * 1.05 - s * 0.3;

      for (let b = 0; b < BEADS; b++, i++) {
        const v = b / (BEADS - 1); // 0 = 吊り元、1 = 裾
        const amp = SWAY * v * v; // 吊り元は動かず、裾ほど大きく振れる
        const sway = Math.sin(phase - v * 1.4) * amp;

        dummy.position.set(
          x0 + sway,
          TOP - b * GAP_Y,
          z0 + Math.sin(phase * 0.75 - v * 1.2) * amp * 0.5,
        );
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);

        ember(color, 0.34 + v * 0.32 + (sway / SWAY) * 0.24, hue);
        // 吊り元は暗がりへ溶かして、どこから下がっているかを曖昧にする
        if (v < 0.14) color.multiplyScalar(v / 0.14);
        mesh.setColorAt(i, color);
      }
    }

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  },
};
