import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, ticker, tickers } from '../audio.ts';
import { emberColor } from '../palette.ts';

const N = 15; // 入れ子にする輪の数
const OUTER = 10.5; // いちばん外側の半径
const STEP = 0.62; // 1 枚内側へ入るごとに縮む量
const LOOP = 44; // すべてが同じ向きへ戻るまでの秒数
const SWING = Math.PI * 0.5; // 振れ幅

const rings: THREE.Group[] = [];
let core: THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial>;

/** 音にする輪の数。内側は速すぎて音が潰れるので外側だけ使う。 */
const VOICES = 6;

/** 輪ごとに真横を向いた回数と、全部が揃った回数 */
let ticks = tickers(VOICES);
let tickAlign = ticker();

/**
 * ジンバルのように入れ子になった輪。
 *
 * i 番目は LOOP/(i+1) 秒周期で振れるので、周期が整数比になり
 * LOOP 秒ごとに必ず全部が平らに揃った状態へ戻る。
 */
export const gimbalRings: SceneModule = {
  name: 'Gimbal Rings',
  desc: '入れ子の輪がそれぞれの周期で首を振り、44 秒ごとにぴたりと重なる。',
  camera: { pos: [0, 7, 29], target: [0, 0, 0] },

  build(root) {
    ticks = tickers(VOICES);
    tickAlign = ticker();

    rings.length = 0;

    let parent: THREE.Object3D = root;
    for (let i = 0; i < N; i++) {
      const g = new THREE.Group();
      parent.add(g);

      const r = OUTER - i * STEP;
      const col = emberColor(i / (N - 1));
      const torus = new THREE.Mesh(
        new THREE.TorusGeometry(r, 0.055, 8, 160),
        new THREE.MeshStandardMaterial({
          color: col,
          emissive: col.clone().multiplyScalar(0.5),
          roughness: 0.3,
          metalness: 0.6,
        }),
      );
      // 1 枚おきに面の向きを変えて、ジンバルらしく直交させる
      if (i % 2 === 0) torus.rotation.x = Math.PI / 2;
      else torus.rotation.y = Math.PI / 2;
      g.add(torus);

      rings.push(g);
      parent = g;
    }

    const col = emberColor(0.9);
    core = new THREE.Mesh(
      new THREE.SphereGeometry(OUTER - N * STEP, 32, 24),
      new THREE.MeshStandardMaterial({
        color: col,
        emissive: col,
        emissiveIntensity: 0.35,
        roughness: 0.35,
        metalness: 0.2,
      }),
    );
    parent.add(core);
  },

  update(t) {
    for (let i = 0; i < N; i++) {
      const th = Math.sin((Math.PI * 2 * (i + 1) * t) / LOOP) * SWING;
      const g = rings[i]!;
      // 親の回転が積み上がるので、軸を交互にするだけで複雑な軌跡になる
      if (i % 2 === 0) g.rotation.x = th;
      else g.rotation.z = th;
    }

    // 揃った瞬間だけ芯が明るくなる
    const align = Math.abs(Math.cos((Math.PI * t) / LOOP));
    core.material.emissiveIntensity = 0.25 + Math.pow(align, 16) * 0.9;
  },

  sound(t, _dt, sfx) {
    // 外側 6 枚が振り切る瞬間。半周期ごとに来るよう 0.5 ずらしてある
    // （ずらさないと、いちばん外の 1 枚は最初の 1 音まで LOOP 秒待つことになる）
    for (let i = 0; i < VOICES; i++) {
      for (let k = ticks[i]!((2 * (i + 1) * t) / LOOP + 0.5); k > 0; k--) {
        sfx.pluck(tone(4 + i), { gain: 0.3, decay: 2.8, pan: (i / VOICES - 0.5) * 1.2 });
      }
    }

    // LOOP 秒ごと、全部が揃った瞬間だけ芯が和音で鳴る
    for (let k = tickAlign(t / LOOP); k > 0; k--) {
      sfx.pluck(tone(0), { gain: 0.5, decay: 5 });
      sfx.pluck(tone(2), { gain: 0.36, decay: 5 });
      sfx.pluck(tone(4), { gain: 0.28, decay: 5 });
    }
  },
};
