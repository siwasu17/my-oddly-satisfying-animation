import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { emberColor } from '../palette.ts';

const COUNT = 26;
const CYCLE = 30; // 全体が一列に揃うまでの秒数
const TOP = 9.2; // 支点の高さ
const SPAN = 13; // 左右の広がり
const AMP = 0.62; // 振れ角（ラジアン）
const N_BASE = 51; // 一番左が CYCLE 秒間に振れる回数
const LONGEST = 7.0;

const balls: THREE.Mesh[] = [];
const lines: THREE.Line[] = [];
const lengths: number[] = [];
const anchors: number[] = [];

/**
 * 長さを L = K / n² で決めた振り子の列。
 * n が 1 ずつ増えるので、CYCLE 秒ごとに必ず全体が一列に戻る。
 */
export const pendulumWave: SceneModule = {
  name: 'Pendulum Wave',
  desc: '長さの違う 26 本の振り子。30 秒で必ず一列に揃い、また波へ崩れていく。',
  camera: { pos: [0, 6.0, 15], target: [0, 5.4, 0] },

  build(root) {
    balls.length = 0;
    lines.length = 0;
    lengths.length = 0;
    anchors.length = 0;

    const k = LONGEST * N_BASE * N_BASE;

    const bar = new THREE.Mesh(
      new THREE.CylinderGeometry(0.1, 0.1, SPAN + 1.4, 16),
      new THREE.MeshStandardMaterial({ color: 0x241d1c, roughness: 0.4, metalness: 0.8 }),
    );
    bar.rotation.z = Math.PI / 2;
    bar.position.y = TOP;
    root.add(bar);

    const ballGeo = new THREE.SphereGeometry(0.34, 32, 24);
    for (let i = 0; i < COUNT; i++) {
      const n = N_BASE + i;
      lengths.push(k / (n * n));
      anchors.push(-SPAN / 2 + (SPAN * i) / (COUNT - 1));

      // 左端を薔薇色、右端を琥珀色にして、揃った瞬間にグラデーションが出る
      const col = emberColor(i / (COUNT - 1), 0, 0.05);
      const ball = new THREE.Mesh(
        ballGeo,
        new THREE.MeshStandardMaterial({
          color: col,
          emissive: col,
          emissiveIntensity: 0.4,
          roughness: 0.25,
          metalness: 0.3,
        }),
      );
      root.add(ball);
      balls.push(ball);

      const lineGeo = new THREE.BufferGeometry();
      lineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
      const line = new THREE.Line(
        lineGeo,
        new THREE.LineBasicMaterial({ color: 0x7a6259, transparent: true, opacity: 0.4 }),
      );
      root.add(line);
      lines.push(line);
    }
  },

  update(t) {
    for (let i = 0; i < COUNT; i++) {
      const len = lengths[i]!;
      const x = anchors[i]!;
      const theta = AMP * Math.cos((Math.PI * 2 * (N_BASE + i) * t) / CYCLE);
      const y = TOP - len * Math.cos(theta);
      const z = len * Math.sin(theta); // 手前と奥へ振らせる

      balls[i]!.position.set(x, y, z);

      const pos = lines[i]!.geometry.attributes.position as THREE.BufferAttribute;
      pos.setXYZ(0, x, TOP, 0);
      pos.setXYZ(1, x, y, z);
      pos.needsUpdate = true;
    }
  },
};
