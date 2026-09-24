import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { SceneModule } from '../types.ts';
import { tone, tickers } from '../audio.ts';
import { SURFACE, ember, drift } from '../palette.ts';

/**
 * Ice Melt。
 *
 * 四角い池に張った氷が、岸に近いところから一枚ずつ割れて離れ、角を丸めながら小さくなって
 * 水に溶ける。消えた瞬間にその場所から波紋がひとつ広がり、最後の一枚が池の真ん中で
 * 溶けきると、あとには波紋の重なる水面だけが残る。しばらくして岸から薄い氷が這うように
 * 張り直し、厚みを取り戻して最初の一枚板に戻る。36 秒で一巡する。
 * 音は氷が溶けきるたびに、数枚おきに小さな雫の音を鳴らす。
 *
 * スコープ外: 氷の中の気泡やひび割れの模様、水面の映り込み（反射用の描画パス）。
 */

/** 一巡の秒数 */
const PERIOD = 36;
/** 氷の並び（GRID × GRID 枚） */
const GRID = 8;
const COUNT = GRID * GRID;
/** 池の一辺 */
const POND = 12;
/** 氷 1 枚の一辺（すき間なしで並べたときの間隔） */
const TILE = 1.4;
/** 氷の厚み */
const THICK = 0.3;
/** 水面から出ている高さ */
const ABOVE = 0.15;
/** 溶け始めの時刻（岸側）と、最後の 1 枚が溶け始める時刻（中心） */
const MELT_FROM = 3.5;
const MELT_TO = 13;
/** 1 枚が溶けきるまでの秒数 */
const MELT_DUR = 4.2;
/** 張り直しの始まり（岸側）と、最後の 1 枚が張り始める時刻 */
const FREEZE_FROM = 26.5;
const FREEZE_TO = 30.5;
/** 1 枚が薄い膜から元の厚みに戻るまでの秒数 */
const FREEZE_DUR = 3.5;
/** 割れて離れるときのすき間 */
const GAP = 0.12;
/** 離れたあとの向きと大きさのばらつき */
const JIT_ROT = 0.22;
const JIT_SIZE = 0.1;

/** 波紋: 振幅 / 広がる速さ / 波束の幅 / 波数 / 寿命 */
const RIP_AMP = 0.22;
const RIP_SPEED = 2.3;
const RIP_WIDTH = 0.8;
const RIP_K = 5.2;
const RIP_LIFE = 7;
/** 水面を割る細かさ */
const SEG = 96;

const dummy = new THREE.Object3D();
const color = new THREE.Color();
const ICE_TINT = new THREE.Color(0xfff0e2);

let ice: THREE.InstancedMesh;
let water: THREE.Mesh;
let base: Float32Array;

/** 氷ごとの [x, z, 溶け始め, 張り始め, 揺れの位相] */
const tiles = new Float32Array(COUNT * 5);
/** 氷ごとの [向きのずれ, 大きさのずれ]（-1..1） */
const jit = new Float32Array(COUNT * 2);

let ticks = tickers(COUNT);

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (x: number): number => {
  const c = clamp01(x);
  return c * c * (3 - 2 * c);
};
/** 一巡の中の時刻 */
const phaseOf = (t: number): number => ((t % PERIOD) + PERIOD) % PERIOD;
/** 氷 i が溶けきる時刻 */
const goneAt = (i: number): number => tiles[i * 5 + 2] + MELT_DUR;

export const iceMelt: SceneModule = {
  name: 'Ice Melt',
  desc: '張りつめた氷が岸から一枚ずつ溶けて波紋になり、池が水面に戻る。やがてまた薄氷が張る。',
  camera: { pos: [0, 12.5, 13.5], target: [0, -0.4, 0.4] },

  build(root) {
    ticks = tickers(COUNT);

    // 配置と時刻は固定シードで決める（開き直しても同じ順に溶ける）
    let s = 0.417;
    const rnd = (): number => (s = (s * 9301 + 0.49297) % 1);
    const half = (GRID - 1) / 2;
    const maxD = Math.hypot(half, half);
    for (let i = 0; i < COUNT; i++) {
      const gx = (i % GRID) - half;
      const gz = Math.floor(i / GRID) - half;
      // 岸に近いほど先に溶ける。正方形の池なので、辺への近さ（チェビシェフ距離）と
      // 角からの近さを混ぜて、角から丸く削れていくようにする
      const edge = Math.max(Math.abs(gx), Math.abs(gz)) / half;
      const round = Math.hypot(gx, gz) / maxD;
      const outer = 0.55 * edge + 0.45 * round;
      const j = (rnd() - 0.5) * 0.14;
      tiles[i * 5 + 0] = gx * TILE;
      tiles[i * 5 + 1] = gz * TILE;
      tiles[i * 5 + 2] = MELT_FROM + (MELT_TO - MELT_FROM) * clamp01(1 - outer + j);
      tiles[i * 5 + 3] = FREEZE_FROM + (FREEZE_TO - FREEZE_FROM) * clamp01(1 - outer + j * 0.5);
      tiles[i * 5 + 4] = rnd() * Math.PI * 2;
      jit[i * 2] = rnd() * 2 - 1;
      jit[i * 2 + 1] = rnd() * 2 - 1;
    }

    // 水面
    const wg = new THREE.PlaneGeometry(POND, POND, SEG, SEG);
    wg.rotateX(-Math.PI / 2);
    base = Float32Array.from(wg.attributes.position.array as ArrayLike<number>);
    (wg.attributes.position as THREE.BufferAttribute).setUsage(THREE.DynamicDrawUsage);
    water = new THREE.Mesh(
      wg,
      new THREE.MeshStandardMaterial({
        color: ember(new THREE.Color(), 0.02, 0, -0.07),
        roughness: 0.2,
        metalness: 0.85,
      }),
    );
    root.add(water);

    // 氷
    const ig = new RoundedBoxGeometry(TILE, THICK, TILE, 3, 0.12);
    const im = new THREE.MeshPhysicalMaterial({
      roughness: 0.08,
      metalness: 0.0,
      clearcoat: 1,
      clearcoatRoughness: 0.05,
      transparent: true,
      opacity: 0.62,
    });
    ice = new THREE.InstancedMesh(ig, im, COUNT);
    ice.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    root.add(ice);

    // 池の縁と、その外の床
    const rimMat = new THREE.MeshStandardMaterial({ color: ember(new THREE.Color(), 0.3), roughness: 0.6, metalness: 0.2 });
    const W = 0.7;
    const L = POND + W * 2;
    for (let k = 0; k < 4; k++) {
      const rim = new THREE.Mesh(new THREE.BoxGeometry(k < 2 ? L : W, 0.7, k < 2 ? W : POND), rimMat);
      const o = POND / 2 + W / 2;
      rim.position.set(k < 2 ? 0 : k === 2 ? -o : o, 0, k < 2 ? (k === 0 ? -o : o) : 0);
      root.add(rim);
    }
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(POND * 1.5, 96),
      new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.8, metalness: 0.2 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.34;
    root.add(floor);
  },

  update(t) {
    const p = phaseOf(t);
    const hue = drift(t);

    // --- 氷 ---
    for (let i = 0; i < COUNT; i++) {
      const x = tiles[i * 5 + 0];
      const z = tiles[i * 5 + 1];
      const m = (p - tiles[i * 5 + 2]) / MELT_DUR; // 溶け具合
      const f = (p - tiles[i * 5 + 3]) / FREEZE_DUR; // 張り直し具合
      const ph = tiles[i * 5 + 4];

      let sxz = 1;
      let sy = 1;
      let gap = 0;
      let bob = 0;
      let frost = 1;
      let loose = 0; // 割れて離れた度合い。向きと大きさのばらつきをこれで効かせる // 1 = 白く締まった氷、0 = 張ったばかりの透けた膜
      if (p >= tiles[i * 5 + 3]) {
        // 岸から薄い膜が張り、厚みを増していく
        const e = smooth(f);
        sy = 0.06 + 0.94 * e;
        sxz = 0.9 + 0.1 * smooth(f * 2);
        frost = e;
      } else if (m > 0) {
        if (m >= 1) {
          sxz = 0;
          sy = 0;
        } else {
          const e = m * m * (3 - 2 * m);
          sxz = 1 - e;
          sy = 1 - e * 0.92;
          loose = smooth(m * 5);
          gap = GAP * loose;
          bob = Math.sin(p * 1.7 + ph) * 0.035 * smooth(m * 4) * (1 - m);
        }
      }

      const len = Math.hypot(x, z) || 1;
      dummy.position.set(x + (x / len) * gap, ABOVE * sy - (THICK * sy) / 2 + bob, z + (z / len) * gap);
      dummy.rotation.set(bob * 0.8 * Math.cos(ph), jit[i * 2] * JIT_ROT * loose, bob * 0.8 * Math.sin(ph));
      const js = 1 - JIT_SIZE * loose * (0.5 + 0.5 * jit[i * 2 + 1]);
      dummy.scale.set(sxz * js, sy, sxz * js);
      dummy.updateMatrix();
      ice.setMatrixAt(i, dummy.matrix);

      ember(color, 0.85 + 0.1 * frost, hue * 0.5, -0.02);
      color.lerp(ICE_TINT, 0.55 + 0.2 * frost);
      ice.setColorAt(i, color);
    }
    ice.instanceMatrix.needsUpdate = true;
    if (ice.instanceColor) ice.instanceColor.needsUpdate = true;

    // --- 水面 ---
    // 開いている水面の割合。氷の下の水は見えないので、うねりはこれに比例させる
    const open = smooth((p - MELT_FROM) / (MELT_TO + MELT_DUR - MELT_FROM)) * (1 - smooth((p - FREEZE_FROM) / 4));

    // いま広がっている波紋だけを拾う
    const act: number[] = [];
    for (let i = 0; i < COUNT; i++) {
      const age = p - goneAt(i);
      if (age > 0 && age < RIP_LIFE) act.push(i, age);
    }

    const pos = water.geometry.attributes.position as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    for (let v = 0; v < arr.length; v += 3) {
      const x = base[v];
      const z = base[v + 2];
      let h =
        0.045 * open * (Math.sin(x * 0.85 + t * 1.05) + Math.sin(z * 1.2 - t * 0.8 + x * 0.35));
      for (let a = 0; a < act.length; a += 2) {
        const i = act[a];
        const age = act[a + 1];
        const d = Math.hypot(x - tiles[i * 5], z - tiles[i * 5 + 1]);
        const u = (d - RIP_SPEED * age) / RIP_WIDTH;
        if (u < -3 || u > 3) continue;
        const fade = (1 - age / RIP_LIFE) * smooth(age * 3);
        h += (RIP_AMP * fade * Math.exp(-u * u) * Math.cos(RIP_K * (d - RIP_SPEED * age))) / (1 + d * 0.25);
      }
      arr[v + 1] = h;
    }
    pos.needsUpdate = true;
    water.geometry.computeVertexNormals();
  },

  sound(t, _dt, sfx) {
    // 氷が溶けきった瞬間に、数枚おきに雫の音を鳴らす
    for (let i = 0; i < COUNT; i++) {
      for (let k = ticks[i]((t - goneAt(i)) / PERIOD); k > 0; k--) {
        if (i % 3 !== 0) continue;
        const x = tiles[i * 5] / (POND / 2);
        sfx.drop(tone(8 + ((i * 7) % 6)), { gain: 0.22, decay: 0.7, pan: x * 0.6 });
      }
    }
  },
};
