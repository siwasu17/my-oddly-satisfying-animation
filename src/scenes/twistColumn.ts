import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, ticker, tickers } from '../audio.ts';
import { ember, drift } from '../palette.ts';

const COUNT = 58; // 積み上げる板の枚数
const GAP = 0.22; // 板と板の間隔。板の厚みに近づけて、揃ったときに面として読めるようにする
const BASE = 0.55; // いちばん下の板の高さ
const WIDTH = 5.4; // いちばん幅の広い板の長さ
const CYCLE = 22; // ねじれがほどけて、まっすぐ揃うまでの秒数
const SPEED = 0.5; // ねじれの波が上っていく速さ（ラジアン/秒）
const WAVES = 1.5; // 柱の高さに入る、ねじれの波の数
const TWIST = 1.15; // 板 1 枚あたりの最大の振れ角（ラジアン）
/**
 * 柱全体の自転。CYCLE 秒でちょうど半回転するので、ねじれがほどけて
 * 揃う瞬間には必ず板の面がこちらを向く。
 */
const SPIN = Math.PI / CYCLE;

/** 高さ方向の位相の刻み。ねじれの波はこの刻みで上へ進む。 */
const K = (Math.PI * 2 * WAVES) / COUNT;

const dummy = new THREE.Object3D();
const color = new THREE.Color();

let mesh: THREE.InstancedMesh;
/** 板ごとの長さの倍率。中ほどを太らせて紡錘形にする。 */
const widths: number[] = [];

/** 音にする板の数と、その間隔 */
const VOICES = 5;
const VOICE_STEP = Math.floor(COUNT / VOICES);
/**
 * 波が来るのを待たずに 2 秒ほどで鳴り始めるよう、位相を前へ倒しておく。
 * これがないと、いちばん下の板の 1 音目まで 12 秒かかる。
 */
const LEAD = 0.85;

/** 板ごとに、ねじれの波が通り過ぎた回数と、柱が揃った回数 */
let ticks = tickers(VOICES);
let tickAlign = ticker();

/**
 * 薄い板を積み上げた柱。
 *
 * 板の向きを高さの正弦波で決めているので、ねじれが下から上へ立ち上る。
 * 振れ幅そのものも CYCLE 秒で 0 に戻るため、ほどけきった瞬間だけ
 * 全部の板が平行に揃い、一枚の面のように見える。
 */
export const twistColumn: SceneModule = {
  name: 'Twisting Column',
  desc: '58 枚の板がゆっくりねじれ上がり、22 秒ごとに一枚の面へほどける。',
  camera: { pos: [0, 8.2, 22], target: [0, 6.9, 0] },

  build(root) {
    ticks = tickers(VOICES);
    tickAlign = ticker();

    widths.length = 0;
    for (let i = 0; i < COUNT; i++) {
      const u = i / (COUNT - 1);
      // 上下の端をすぼめると、ねじれたときの輪郭が紡錘形になる
      widths.push(0.3 + 0.7 * Math.pow(Math.sin(Math.PI * u), 0.7));
    }

    const geo = new THREE.BoxGeometry(WIDTH, 0.15, 0.3);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.3, metalness: 0.5 });

    mesh = new THREE.InstancedMesh(geo, mat, COUNT);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    root.add(mesh);

    // 板を貫く芯。ねじれても中心がぶれないことが見えるようにする
    const core = new THREE.Mesh(
      new THREE.CylinderGeometry(0.07, 0.07, COUNT * GAP + BASE, 16),
      new THREE.MeshStandardMaterial({ color: 0x241d1c, roughness: 0.4, metalness: 0.8 }),
    );
    core.position.y = (COUNT * GAP + BASE) / 2;
    root.add(core);
  },

  update(t) {
    const hue = drift(t);
    // 0 = まっすぐ揃った状態、1 = いちばんねじれた状態
    const wind = 0.5 - 0.5 * Math.cos((Math.PI * 2 * t) / CYCLE);
    const spin = t * SPIN;
    // 揃いきる一瞬だけ光を足して、ほどけた瞬間を見逃さないようにする
    const glow = Math.pow(1 - wind, 10) * 0.12;

    for (let i = 0; i < COUNT; i++) {
      const w = Math.sin(K * i - t * SPEED);

      dummy.position.set(0, BASE + i * GAP, 0);
      dummy.rotation.set(0, spin + TWIST * wind * w, 0);
      dummy.scale.set(widths[i]!, 1, 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);

      ember(color, 0.3 + 0.55 * (0.5 + 0.5 * w), hue, glow);
      mesh.setColorAt(i, color);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  },

  sound(t, _dt, sfx) {
    const wind = 0.5 - 0.5 * Math.cos((Math.PI * 2 * t) / CYCLE);
    // ねじれが強いほど、低い唸りもわずかに増す
    sfx.drone(tone(0), 0.13 + wind * 0.1);

    // 波が板を通り過ぎる瞬間。下から順に来るので、音程も上がっていく
    for (let v = 0; v < VOICES; v++) {
      const i = v * VOICE_STEP;
      for (let k = ticks[v]!((t * SPEED - K * i) / (Math.PI * 2) + LEAD); k > 0; k--) {
        sfx.pluck(tone(3 + v * 2), {
          gain: 0.3,
          decay: 3.2,
          pan: Math.sin(K * i) * 0.6, // その板が向いている側へ寄せる
        });
      }
    }

    // CYCLE 秒ごと、柱がまっすぐ揃った瞬間
    for (let k = tickAlign(t / CYCLE); k > 0; k--) {
      sfx.pluck(tone(0), { gain: 0.42, decay: 5.5 });
      sfx.pluck(tone(3), { gain: 0.3, decay: 5.5 });
      sfx.air({ gain: 0.22, decay: 2.6, freq: 700, q: 0.7, sweep: 0.45 });
    }
  },
};
