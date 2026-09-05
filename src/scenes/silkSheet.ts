import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { ember, drift } from '../palette.ts';

const W = 26; // 布の横幅
const H = 18; // 布の奥行き
const SEG_X = 72;
const SEG_Y = 48;
const AMP = 1.5; // うねりの高さ

const color = new THREE.Color();

let mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>;
let base: Float32Array; // 平らな状態の頂点座標
let pos: THREE.BufferAttribute;
let col: THREE.BufferAttribute;

/** 空中に浮かんだ絹が、ゆっくりとした大きなうねりで波打つ。 */
export const silkSheet: SceneModule = {
  name: 'Silk Sheet',
  desc: '宙に浮いた一枚の絹が、ゆっくりとした大きなうねりで波打つ。',
  camera: { pos: [0, 16, 32], target: [0, 0, 0] },

  build(root) {
    const geo = new THREE.PlaneGeometry(W, H, SEG_X, SEG_Y);
    geo.rotateX(-Math.PI / 2); // XZ 平面へ寝かせる

    const attr = geo.attributes.position as THREE.BufferAttribute;
    base = Float32Array.from(attr.array);
    pos = attr;

    const n = attr.count;
    col = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
    geo.setAttribute('color', col);

    mesh = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        side: THREE.DoubleSide,
        roughness: 0.45,
        metalness: 0.35,
      }),
    );
    root.add(mesh);
  },

  update(t) {
    const d = drift(t);
    const n = pos.count;

    for (let i = 0; i < n; i++) {
      const x = base[i * 3]!;
      const z = base[i * 3 + 2]!;

      // 周期の違う波を3つ重ねる。整数比を避けているので同じ形に戻らない
      const y =
        Math.sin(x * 0.28 - t * 0.62) * AMP +
        Math.sin(z * 0.21 + t * 0.47) * AMP * 0.8 +
        Math.sin((x + z) * 0.13 - t * 0.31) * AMP * 0.6;

      pos.setY(i, y);

      const k = 0.5 + y / (AMP * 4.4); // 稜線ほど明るく
      ember(color, k, d);
      col.setXYZ(i, color.r, color.g, color.b);
    }

    pos.needsUpdate = true;
    col.needsUpdate = true;
    mesh.geometry.computeVertexNormals(); // 面の向きが変わるので毎フレーム取り直す
  },
};
