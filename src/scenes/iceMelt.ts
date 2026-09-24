import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import type { SceneModule } from '../types.ts';
import { tone, tickers } from '../audio.ts';
import { SURFACE, ember, drift } from '../palette.ts';

/**
 * Ice Melt。
 *
 * 丸い池に、角ばった氷山が大小 7 つ浮かんでいる。小さく岸に近いものから順に、
 * ゆっくり沈みながら縮んで溶けていく。溶けている間は水際から小さな波紋が滴るように
 * 広がり、溶けきった瞬間に大きな波紋がひとつ広がる。真ん中の大きな氷山が最後に消えると、
 * あとにはうねる水面だけが残る。しばらくして氷山は水の下から静かに浮かび上がり、元の姿に戻る。
 * 36 秒で一巡する。音は氷山が溶けきるたびに雫の音、溶けている間はごく小さな滴りの音。
 *
 * スコープ外: 氷山が割れて欠片が落ちる動き、水中に透けて見える氷山の根元。
 */

/** 一巡の秒数 */
const PERIOD = 36;
/** 池の半径（水面のメッシュは一辺 2R の正方形で、角は岸の石で隠す） */
const R = 6.2;
/** 氷山ごとの [x, z, 大きさ, 溶け始め, 溶ける秒数]。大きく中心に近いものほど遅い */
const BERGS: [number, number, number, number, number][] = [
  [0.3, -0.2, 1.55, 9.0, 8.0],
  [-2.9, -1.4, 0.95, 5.5, 6.0],
  [2.8, 1.6, 1.05, 6.5, 6.5],
  [-1.6, 2.6, 0.8, 4.2, 5.0],
  [3.1, -2.3, 0.7, 3.4, 4.5],
  [-3.9, 1.0, 0.55, 2.8, 4.0],
  [1.2, 3.6, 0.6, 3.8, 4.2],
];
const COUNT = BERGS.length;
/** 水面から出ている高さ（大きさに対する比） */
const TALL = 1.25;
/** 浮かび上がりの始まりと、1 つずつのずれ、1 つが浮かび上がるまでの秒数 */
const RISE_FROM = 26.5;
const RISE_STAGGER = 0.6;
const RISE_DUR = 4.5;
/** 溶けている間に水際から滴る波紋の間隔（秒） */
const DRIP = 1.4;

/** 波紋: 振幅 / 滴りの振幅 / 広がる速さ / 波束の幅 / 波数 / 寿命 */
const RIP_AMP = 0.16;
const DRIP_AMP = 0.05;
const RIP_SPEED = 1.9;
const RIP_WIDTH = 1.2;
const RIP_K = 2.2;
const RIP_LIFE = 8;
/** 水面を割る細かさ */
const SEG = 88;

const color = new THREE.Color();
const ICE_TINT = new THREE.Color(0xf4eee9);
/** 氷の明るさ（ブルームのしきい値を大きく超えないよう、白から少し落とす） */
const ICE_VALUE = 0.78;

let bergs: THREE.Mesh[] = [];
let foams: THREE.Mesh[] = [];
let sky: THREE.DataTexture | null = null;
let water: THREE.Mesh;
let base: Float32Array;
let gone = tickers(COUNT);
let drips = tickers(COUNT);

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (x: number): number => {
  const c = clamp01(x);
  return c * c * (3 - 2 * c);
};
/** 一巡の中の時刻 */
const phaseOf = (t: number): number => ((t % PERIOD) + PERIOD) % PERIOD;
const goneAt = (i: number): number => BERGS[i][3] + BERGS[i][4];
const riseAt = (i: number): number => RISE_FROM + (COUNT - 1 - i) * RISE_STAGGER;

/**
 * 水と氷に映り込ませる、ぼんやりした暖色の空。stage に環境マップが無いので自前で作る。
 * 仰角 15〜40 度あたりをいちばん明るくして、水面の傾きが明暗の縞として読めるようにする。
 */
function skyTexture(): THREE.DataTexture {
  const W = 64;
  const H = 32;
  const data = new Uint8Array(W * H * 4);
  const c = new THREE.Color();
  for (let y = 0; y < H; y++) {
    const el = (y / (H - 1) - 0.5) * Math.PI; // -90..90 度
    const deg = (el * 180) / Math.PI;
    const band = Math.exp(-(((deg - 26) / 16) ** 2));
    const lift = deg < 0 ? 0 : 0.25;
    for (let x = 0; x < W; x++) {
      const az = (x / W) * Math.PI * 2;
      // 奥の方角だけ少し明るい。映り込みに向きのむらが出て、平板にならない
      const glow = 0.7 + 0.3 * Math.cos(az - Math.PI * 1.5);
      ember(c, 0.35 + 0.5 * band, 0, 0);
      c.multiplyScalar((lift + band) * glow);
      const o = (y * W + x) * 4;
      data[o] = Math.min(255, c.r * 255);
      data[o + 1] = Math.min(255, c.g * 255);
      data[o + 2] = Math.min(255, c.b * 255);
      data[o + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, W, H);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/** 角ばった氷山の形を 1 つ作る。頂点を固定シードで押し引きし、上へ尖らせる */
function bergGeometry(seed: number): THREE.BufferGeometry {
  let s = seed;
  const rnd = (): number => (s = (s * 9301 + 0.49297) % 1);
  let g: THREE.BufferGeometry = new THREE.IcosahedronGeometry(1, 1);
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  g = mergeVertices(g); // 共有頂点をまとめてから動かす（面が裂けないように）
  const pos = g.attributes.position as THREE.BufferAttribute;
  const peakA = rnd() * Math.PI * 2;
  const top = TALL + 0.5;
  for (let v = 0; v < pos.count; v++) {
    const k = 0.78 + rnd() * 0.4;
    let x = pos.getX(v) * k;
    let y = pos.getY(v) * k;
    let z = pos.getZ(v) * k;
    if (y > 0) {
      // 上半分は細く高く。片側に峰を寄せて、左右非対称の稜線にする
      const lean = 0.5 + 0.5 * Math.cos(Math.atan2(z, x) - peakA);
      y = y * (TALL + 0.5 * lean) + rnd() * 0.12;
      x *= 1 - (0.35 * y) / top;
      z *= 1 - (0.35 * y) / top;
    } else {
      y *= 0.6;
    }
    pos.setXYZ(v, x, y, z);
  }
  g = g.toNonIndexed(); // 面ごとに法線を分けて、切り立った面を見せる
  g.computeVertexNormals();
  return g;
}

export const iceMelt: SceneModule = {
  name: 'Ice Melt',
  desc: '池に浮かぶ氷山が小さいものから沈みながら溶け、波紋を残して水面に戻る。やがてまた浮かび上がる。',
  camera: { pos: [0, 5.6, 9.2], target: [0, 0.5, 0.3] },

  build(root) {
    gone = tickers(COUNT);
    drips = tickers(COUNT);

    // 切替時の disposeGroup() はテクスチャを捨てないので、1 枚を作り置きして使い回す
    sky ??= skyTexture();

    // 水面
    const wg = new THREE.PlaneGeometry(R * 2, R * 2, SEG, SEG);
    wg.rotateX(-Math.PI / 2);
    base = Float32Array.from(wg.attributes.position.array as ArrayLike<number>);
    (wg.attributes.position as THREE.BufferAttribute).setUsage(THREE.DynamicDrawUsage);
    water = new THREE.Mesh(
      wg,
      new THREE.MeshStandardMaterial({
        color: ember(new THREE.Color(), 0.22, 0, -0.1),
        roughness: 0.1,
        metalness: 0.05,
        envMap: sky,
        envMapIntensity: 1.6,
      }),
    );
    root.add(water);

    // 氷山
    bergs = [];
    foams = [];
    for (let i = 0; i < COUNT; i++) {
      const m = new THREE.Mesh(
        bergGeometry(0.173 + i * 0.097),
        new THREE.MeshPhysicalMaterial({
          roughness: 0.12,
          metalness: 0,
          transmission: 0.7,
          thickness: 1.2,
          ior: 1.31,
          clearcoat: 1,
          clearcoatRoughness: 0.04,
          envMap: sky,
          envMapIntensity: 1.2,
          flatShading: true,
        }),
      );
      root.add(m);
      bergs.push(m);
      // 喫水線のまわりの淡い泡。浮いていることを見せる
      const foam = new THREE.Mesh(
        new THREE.RingGeometry(0.72, 1.05, 40, 1),
        new THREE.MeshBasicMaterial({
          color: ember(new THREE.Color(), 0.9, 0, 0).lerp(ICE_TINT, 0.5),
          transparent: true,
          opacity: 0.22,
          depthWrite: false,
        }),
      );
      foam.rotation.x = -Math.PI / 2;
      root.add(foam);
      foams.push(foam);
    }

    // 岸: 正方形の水面の角を覆う低い石の輪
    const bank = new THREE.Mesh(
      new THREE.RingGeometry(R, R * 2.2, 128, 1),
      new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.95, metalness: 0 }),
    );
    bank.rotation.x = -Math.PI / 2;
    bank.position.y = 0.4; // 水面のうねりの山より上に置き、池の輪郭を円に保つ
    root.add(bank);
    // 岸の内壁。持ち上げた岸と水面のあいだのすき間を塞ぐ
    const wall = new THREE.Mesh(
      new THREE.CylinderGeometry(R, R, 0.6, 128, 1, true),
      new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.95, metalness: 0, side: THREE.BackSide }),
    );
    wall.position.y = 0.1;
    root.add(wall);
  },

  update(t) {
    const p = phaseOf(t);
    const hue = drift(t);

    // --- 氷山 ---
    ember(color, 0.95, hue * 0.4, -0.1);
    color.lerp(ICE_TINT, 0.78).multiplyScalar(ICE_VALUE);
    for (let i = 0; i < COUNT; i++) {
      const [x, z, size, start, dur] = BERGS[i];
      const m = (p - start) / dur;
      let k = 1; // 大きさ
      let sink = 0; // 沈んだ量（水面上の高さに対する比）
      if (p >= riseAt(i)) {
        // 水の下から浮かび上がる
        const e = smooth((p - riseAt(i)) / RISE_DUR);
        k = 0.6 + 0.4 * e;
        sink = 1.4 * (1 - e);
      } else if (m > 0) {
        const e = smooth(m);
        k = m >= 1 ? 0 : 1 - 0.8 * e;
        sink = 1.1 * e;
      }
      const b = bergs[i];
      b.visible = k > 0.001;
      const bob = Math.sin(t * 0.6 + i * 1.9) * 0.04 * size;
      b.scale.setScalar(size * k);
      b.position.set(x, (bob - sink * size * TALL) * k, z);
      b.rotation.set(Math.sin(t * 0.45 + i) * 0.03, i * 1.37 + t * 0.02, Math.cos(t * 0.4 + i * 2) * 0.03);
      (b.material as THREE.MeshPhysicalMaterial).color.copy(color);
      // 泡は水面の高さに置き、氷山の喫水線の太さに合わせる
      const f = foams[i];
      const w = size * k * 0.95 * (1 - 0.2 * clamp01(sink));
      f.visible = b.visible;
      f.scale.setScalar(Math.max(w, 0.001));
      f.position.set(x, 0.035, z);
    }

    // --- 水面 ---
    // 開いている水面の割合。氷山が減るほど、池全体のうねりを大きくする
    const open = smooth((p - 3) / 15) * (1 - smooth((p - RISE_FROM) / 5));

    // いま広がっている波紋を拾う: [x, z, 振幅, 年齢, 出発点の半径]
    const act: number[] = [];
    for (let i = 0; i < COUNT; i++) {
      const [x, z, size, start, dur] = BERGS[i];
      const age = p - (start + dur);
      if (age > 0 && age < RIP_LIFE) act.push(x, z, RIP_AMP, age, 0);
      // 溶けている間に水際から滴る小さな波紋
      for (let n = 0; n * DRIP < dur; n++) {
        const a = p - (start + n * DRIP);
        if (a <= 0 || a >= RIP_LIFE * 0.6) continue;
        const k = 1 - 0.8 * smooth((n * DRIP) / dur);
        act.push(x, z, DRIP_AMP, a, size * k * 0.9);
      }
    }

    const pos = water.geometry.attributes.position as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    for (let v = 0; v < arr.length; v += 3) {
      const x = base[v];
      const z = base[v + 2];
      let h = 0.02 + 0.08 * open * (Math.sin(x * 0.55 + t * 0.7) + Math.sin(z * 0.7 - t * 0.55 + x * 0.3));
      for (let a = 0; a < act.length; a += 5) {
        const age = act[a + 3];
        const d = Math.hypot(x - act[a], z - act[a + 1]) - act[a + 4];
        if (d < 0) continue;
        const u = (d - RIP_SPEED * age) / RIP_WIDTH;
        if (u < -3 || u > 3) continue;
        const fade = (1 - age / RIP_LIFE) * smooth(age * 2);
        h += (act[a + 2] * fade * Math.exp(-u * u) * Math.cos(RIP_K * (d - RIP_SPEED * age))) / (1 + d * 0.2);
      }
      arr[v + 1] = h;
    }
    pos.needsUpdate = true;
    water.geometry.computeVertexNormals();
  },

  sound(t, _dt, sfx) {
    const p = phaseOf(t);
    for (let i = 0; i < COUNT; i++) {
      const [x, , size, start, dur] = BERGS[i];
      const pan = (x / R) * 0.6;
      // 溶けきった瞬間
      for (let k = gone[i]((t - goneAt(i)) / PERIOD); k > 0; k--) {
        sfx.drop(tone(6 + i), { gain: 0.2 + size * 0.08, decay: 0.8, pan });
      }
      // 溶けている間の滴り
      for (let k = drips[i]((t - start) / DRIP); k > 0; k--) {
        if (p > start && p < start + dur) sfx.drop(tone(11 + (i % 3)), { gain: 0.06, decay: 0.35, pan });
      }
    }
  },
};
