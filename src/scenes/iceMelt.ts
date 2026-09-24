import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, tickers } from '../audio.ts';
import { SURFACE, ember, drift } from '../palette.ts';

/**
 * Ice Melt。
 *
 * 丸い池を薄い氷が覆っている。氷は不揃いな蓮の葉のような板の寄せ集めで、岸に近いものから
 * 順にすき間を空けて離れ、ゆっくり縮んで水に溶ける。溶けきった場所からは柔らかい波紋が
 * ひとつ広がり、最後の一枚が真ん中で消えると、あとにはうねる水面だけが残る。
 * しばらくして岸から透けた薄氷が這うように張り直し、白く締まって最初の氷面に戻る。
 * 36 秒で一巡する。音は氷が溶けきるたびに、数枚おきに小さな雫の音を鳴らす。
 *
 * スコープ外: 氷の中の気泡やひび割れの模様、水面の映り込み（反射用の描画パス）。
 */

/** 一巡の秒数 */
const PERIOD = 36;
/** 池の半径（水面のメッシュは一辺 2R の正方形で、角は岸の石で隠す） */
const R = 6.2;
/** 氷を並べる範囲の半径 */
const ICE_R = 5.7;
/** 氷の板の間隔（六方に詰める）と、板 1 枚の半径 */
const PITCH = 1.12;
const PLATE = 0.64;
/** 板の角の数（少なめにして不揃いな多角形に見せる） */
const SIDES = 7;
/** 氷の厚みと、水面から出ている高さ */
const THICK = 0.14;
const ABOVE = 0.07;
/** 溶け始めの時刻（岸側）と、最後の 1 枚が溶け始める時刻（中心） */
const MELT_FROM = 3.5;
const MELT_TO = 13;
/** 1 枚が溶けきるまでの秒数 */
const MELT_DUR = 4.2;
/** 張り直しの始まり（岸側）と、最後の 1 枚が張り始める時刻 */
const FREEZE_FROM = 26.5;
const FREEZE_TO = 30.5;
/** 1 枚が透けた膜から白く締まるまでの秒数 */
const FREEZE_DUR = 3.5;
/** 割れて離れるときに外へずれる量 */
const GAP = 0.14;

/** 波紋: 振幅 / 広がる速さ / 波束の幅 / 波数 / 寿命 */
const RIP_AMP = 0.1;
const RIP_SPEED = 1.9;
const RIP_WIDTH = 1.3;
const RIP_K = 2.0;
const RIP_LIFE = 6;
/** 水面を割る細かさ */
const SEG = 88;

const dummy = new THREE.Object3D();
const color = new THREE.Color();
const ICE_TINT = new THREE.Color(0xfff3e8);

// --- 氷の配置（固定シード。モジュールを読んだときに 1 度だけ決める） ---
/** 氷ごとの [x, z, 溶け始め, 張り始め, 位相, 向き, 横の伸び, 縦の伸び] */
const STRIDE = 8;
const layout: number[] = [];
{
  let s = 0.417;
  const rnd = (): number => (s = (s * 9301 + 0.49297) % 1);
  const rows = Math.ceil(ICE_R / (PITCH * 0.866)) + 1;
  for (let r = -rows; r <= rows; r++) {
    for (let c = -rows; c <= rows; c++) {
      const x = (c + (r & 1) * 0.5) * PITCH + (rnd() - 0.5) * 0.22;
      const z = r * PITCH * 0.866 + (rnd() - 0.5) * 0.22;
      const d = Math.hypot(x, z);
      if (d > ICE_R - PLATE * 0.55) continue;
      // 岸に近いほど先に溶け、先に張る
      const outer = d / ICE_R;
      const j = (rnd() - 0.5) * 0.16;
      layout.push(
        x,
        z,
        MELT_FROM + (MELT_TO - MELT_FROM) * Math.min(1, Math.max(0, 1 - outer + j)),
        FREEZE_FROM + (FREEZE_TO - FREEZE_FROM) * Math.min(1, Math.max(0, 1 - outer + j * 0.5)),
        rnd() * Math.PI * 2,
        rnd() * Math.PI * 2,
        0.88 + rnd() * 0.28,
        0.88 + rnd() * 0.28,
      );
    }
  }
}
const tiles = Float32Array.from(layout);
const COUNT = tiles.length / STRIDE;

let ice: THREE.InstancedMesh;
let water: THREE.Mesh;
let base: Float32Array;
let ticks = tickers(COUNT);

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (x: number): number => {
  const c = clamp01(x);
  return c * c * (3 - 2 * c);
};
/** 一巡の中の時刻 */
const phaseOf = (t: number): number => ((t % PERIOD) + PERIOD) % PERIOD;
/** 氷 i が溶けきる時刻 */
const goneAt = (i: number): number => tiles[i * STRIDE + 2] + MELT_DUR;

export const iceMelt: SceneModule = {
  name: 'Ice Melt',
  desc: '池を覆う薄氷が岸から一枚ずつ溶けて波紋になり、水面に戻る。やがてまた薄氷が張る。',
  camera: { pos: [0, 11.5, 12.5], target: [0, -0.4, 0.3] },

  build(root) {
    ticks = tickers(COUNT);

    // 水面
    const wg = new THREE.PlaneGeometry(R * 2, R * 2, SEG, SEG);
    wg.rotateX(-Math.PI / 2);
    base = Float32Array.from(wg.attributes.position.array as ArrayLike<number>);
    (wg.attributes.position as THREE.BufferAttribute).setUsage(THREE.DynamicDrawUsage);
    water = new THREE.Mesh(
      wg,
      new THREE.MeshStandardMaterial({
        color: ember(new THREE.Color(), 0.12, 0.02, -0.02),
        roughness: 0.34,
        metalness: 0.5,
      }),
    );
    root.add(water);

    // 氷: 角の少ない薄い円柱を、向きと縦横の伸びでばらして不揃いな板にする
    const ig = new THREE.CylinderGeometry(PLATE, PLATE * 0.94, THICK, SIDES, 1);
    const im = new THREE.MeshPhysicalMaterial({
      roughness: 0.12,
      metalness: 0,
      clearcoat: 1,
      clearcoatRoughness: 0.08,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
    });
    ice = new THREE.InstancedMesh(ig, im, COUNT);
    ice.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    root.add(ice);

    // 岸: 正方形の水面の角を覆う低い石の輪
    const stone = new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.75, metalness: 0.15 });
    const bank = new THREE.Mesh(new THREE.RingGeometry(R, R * 2.2, 128, 1), stone);
    bank.rotation.x = -Math.PI / 2;
    bank.position.y = 0.16;
    root.add(bank);
    const lip = new THREE.Mesh(
      new THREE.TorusGeometry(R + 0.05, 0.24, 12, 128),
      new THREE.MeshStandardMaterial({ color: ember(new THREE.Color(), 0.16, 0, -0.05), roughness: 0.7 }),
    );
    lip.rotation.x = -Math.PI / 2;
    lip.position.y = 0.1;
    root.add(lip);
  },

  update(t) {
    const p = phaseOf(t);
    const hue = drift(t);

    // --- 氷 ---
    for (let i = 0; i < COUNT; i++) {
      const o = i * STRIDE;
      const x = tiles[o];
      const z = tiles[o + 1];
      const m = (p - tiles[o + 2]) / MELT_DUR; // 溶け具合
      const f = (p - tiles[o + 3]) / FREEZE_DUR; // 張り直し具合
      const ph = tiles[o + 4];

      let size = 1;
      let sy = 1;
      let gap = 0;
      let bob = 0;
      let frost = 1; // 1 = 白く締まった氷、0 = 張ったばかりの透けた膜
      if (p >= tiles[o + 3]) {
        const e = smooth(f);
        sy = 0.15 + 0.85 * e;
        size = 0.55 + 0.45 * smooth(f * 1.6);
        frost = e;
      } else if (m > 0) {
        if (m >= 1) {
          size = 0;
          sy = 0;
        } else {
          const e = m * m * (3 - 2 * m);
          size = 1 - e;
          sy = 1 - e * 0.6;
          gap = GAP * smooth(m * 4);
          bob = Math.sin(p * 1.5 + ph) * 0.03 * smooth(m * 4) * (1 - m);
        }
      }

      const len = Math.hypot(x, z) || 1;
      // 板どうしが重なるところのちらつきを避けて、高さをわずかにずらす
      const lift = (i % 5) * 0.004;
      dummy.position.set(x + (x / len) * gap, ABOVE * sy - (THICK * sy) / 2 + bob + lift, z + (z / len) * gap);
      dummy.rotation.set(bob * Math.cos(ph), tiles[o + 5], bob * Math.sin(ph));
      dummy.scale.set(size * tiles[o + 6], sy, size * tiles[o + 7]);
      dummy.updateMatrix();
      ice.setMatrixAt(i, dummy.matrix);

      ember(color, 0.9, hue * 0.5, -0.04);
      color.lerp(ICE_TINT, 0.45 + 0.3 * frost);
      ice.setColorAt(i, color);
    }
    ice.instanceMatrix.needsUpdate = true;
    if (ice.instanceColor) ice.instanceColor.needsUpdate = true;

    // --- 水面 ---
    // 開いている水面の割合。氷の下は見えないので、うねりはこれに比例させる
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
      let h = 0.05 * open * (Math.sin(x * 0.55 + t * 0.7) + Math.sin(z * 0.7 - t * 0.55 + x * 0.3));
      for (let a = 0; a < act.length; a += 2) {
        const o = act[a] * STRIDE;
        const age = act[a + 1];
        const d = Math.hypot(x - tiles[o], z - tiles[o + 1]);
        const u = (d - RIP_SPEED * age) / RIP_WIDTH;
        if (u < -3 || u > 3) continue;
        const fade = (1 - age / RIP_LIFE) * smooth(age * 2);
        h += (RIP_AMP * fade * Math.exp(-u * u) * Math.cos(RIP_K * (d - RIP_SPEED * age))) / (1 + d * 0.2);
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
        const x = tiles[i * STRIDE] / R;
        sfx.drop(tone(8 + ((i * 7) % 6)), { gain: 0.22, decay: 0.7, pan: x * 0.6 });
      }
    }
  },
};
