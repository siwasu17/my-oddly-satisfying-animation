import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { SURFACE, ember, drift } from '../palette.ts';

const COUNT = 44; // 同時に走らせる雨だれの数
const AREA = 17; // 落ちる範囲の半径
const LIFE = 5.2; // 1 滴が落ちてから輪が消えるまでの秒数
const FALL = 0.3; // そのうち落下に使う割合
const MAX_R = 5.4; // 広がりきったときの輪の半径
const DROP_TOP = 11; // 雫が現れる高さ

const dummy = new THREE.Object3D();
const color = new THREE.Color();

let rings: THREE.InstancedMesh;
let drops: THREE.InstancedMesh;
/** 滴ごとの [x, z, 位相のずれ] */
const seeds = new Float32Array(COUNT * 3);

const smooth = (x: number): number => x * x * (3 - 2 * x);

/** 暗い水面に雫が落ち、輪が広がっては消えるのを延々と眺める。 */
export const rainRings: SceneModule = {
  name: 'Rain Rings',
  desc: '静かな水面に雫が落ち、広がった輪がゆっくり消えていく。',
  camera: { pos: [0, 9.5, 24], target: [0, 0.6, 0] },

  build(root) {
    // 疑似乱数。毎回同じ配置になるよう固定の漸化式で散らす
    let s = 0.317;
    for (let i = 0; i < COUNT; i++) {
      s = (s * 9301 + 0.49297) % 1;
      const a = s * Math.PI * 2;
      s = (s * 9301 + 0.49297) % 1;
      const r = Math.sqrt(s) * AREA;
      seeds[i * 3] = Math.cos(a) * r;
      seeds[i * 3 + 1] = Math.sin(a) * r;
      seeds[i * 3 + 2] = i / COUNT + s * 0.02;
    }

    const water = new THREE.Mesh(
      new THREE.CircleGeometry(AREA * 1.9, 96),
      new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.12, metalness: 0.95 }),
    );
    water.rotation.x = -Math.PI / 2;
    root.add(water);

    const ringGeo = new THREE.TorusGeometry(1, 0.03, 8, 96);
    ringGeo.rotateX(-Math.PI / 2); // 水面に寝かせる
    rings = new THREE.InstancedMesh(
      ringGeo,
      new THREE.MeshStandardMaterial({ roughness: 0.3, metalness: 0.4 }),
      COUNT,
    );
    rings.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    root.add(rings);

    drops = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.11, 16, 12),
      new THREE.MeshStandardMaterial({ roughness: 0.2, metalness: 0.2 }),
      COUNT,
    );
    drops.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    root.add(drops);
  },

  update(t) {
    const d = drift(t);

    for (let i = 0; i < COUNT; i++) {
      const x = seeds[i * 3]!;
      const z = seeds[i * 3 + 1]!;
      const p = ((t / LIFE + seeds[i * 3 + 2]!) % 1 + 1) % 1;

      if (p < FALL) {
        // 落下中。等加速度なので着水直前がいちばん速い
        const k = p / FALL;
        dummy.position.set(x, DROP_TOP * (1 - k * k), z);
        dummy.scale.set(1, 1 + k * 0.6, 1); // 速いほど縦に伸びる
      } else {
        dummy.scale.setScalar(0); // 着水後は隠す
        dummy.position.set(x, 0, z);
      }
      dummy.updateMatrix();
      drops.setMatrixAt(i, dummy.matrix);
      ember(color, 0.75, d, 0.05);
      drops.setColorAt(i, color);

      // 着水後は輪。広がるほど速度を落として、消えぎわをゆっくり見せる
      const q = p < FALL ? 0 : (p - FALL) / (1 - FALL);
      const r = Math.max(Math.sqrt(q) * MAX_R, 0.001);
      const fade = 1 - smooth(q);

      dummy.position.set(x, 0.012, z);
      dummy.scale.set(r, 1, r);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      rings.setMatrixAt(i, dummy.matrix);

      ember(color, 0.35 + fade * 0.5, d, -0.06);
      color.multiplyScalar(fade * fade); // 背景へ溶かして消す
      rings.setColorAt(i, color);
    }

    rings.instanceMatrix.needsUpdate = true;
    drops.instanceMatrix.needsUpdate = true;
    if (rings.instanceColor) rings.instanceColor.needsUpdate = true;
    if (drops.instanceColor) drops.instanceColor.needsUpdate = true;
  },
};
