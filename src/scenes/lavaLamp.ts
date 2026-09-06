import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, tickers } from '../audio.ts';
import { SURFACE, ember, emberColor, drift } from '../palette.ts';

/**
 * Lava Lamp。
 *
 * 何が動くか: ガラス筒の底に溜まった蝋が盛り上がり、細い首を引きながら
 * ちぎれて塊になり、天井近くまで昇って冷え、平たくなって沈み、また溜まりへ融け戻る。
 * 気持ちよさの芯: 塊が母体から離れる瞬間の「首が細くなってふっと切れる」ところ。
 * ループの周期: 塊 1 つが一巡するのに約 30 秒。塊ごとに周期と位相をずらしてあるので、
 * 画面のどこかでは常に何かが起きていて、全体としては同じ絵が戻ってこない。
 * カメラ: ランプの高さの中ほどから、少し斜めに見る。
 * 音: ちぎれた瞬間と融け戻った瞬間に水滴を 1 つ。底のヒーターに見立てた低い持続音。
 * スコープ外: 本物のメタボール。首は球を数個並べて、つなぎ目を近似している。
 */

/** 上下する塊の数 */
const BLOBS = 6;
/** 1 つの塊と母体をつなぐ首を、いくつの球で描くか */
const NECK = 6;
/** 球の総数（塊本体 + 首） */
const COUNT = BLOBS * (1 + NECK);

/** 塊 1 つが一巡する秒数 */
const CYCLE = 30;
/** 首がちぎれる位相 */
const BREAK = 0.2;
/** 上昇を終える位相 */
const RISE = 0.5;
/** 天井での滞留を終える位相 */
const HANG = 0.66;
/** 母体へ首をつなぎ直し始める位相 */
const MERGE = 0.9;

/** ガラス筒の下端・上端の高さと、そこでの半径 */
const GLASS_BOTTOM = 2;
const GLASS_TOP = 17;
const GLASS_R_LOW = 3.6;
const GLASS_R_HIGH = 2.4;

/** 底の溜まりの上面・厚み・半径 */
const POOL_SURF = 3.2;
const POOL_H = 1.05;
const POOL_R = 3.1;

/** 塊の中心が生まれる高さ（溜まりに半ば埋もれた位置）と、昇りきる高さ */
const Y_LOW = POOL_SURF - 0.45;
const Y_HIGH = GLASS_TOP - 1.9;

const dummy = new THREE.Object3D();
const color = new THREE.Color();

let mesh: THREE.InstancedMesh;
let pool: THREE.Mesh;

/** 塊ごとの [位相, 半径, 周期の倍率, 横揺れの位相, 横揺れの幅] */
const blobs = new Float32Array(BLOBS * 5);

/** ちぎれた瞬間・融け戻った瞬間を数える。build のたびに作り直す。 */
let breakTicks = tickers(BLOBS);
let mergeTicks = tickers(BLOBS);

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (x: number): number => x * x * (3 - 2 * x);
const lerp = (a: number, b: number, x: number): number => a + (b - a) * x;
/** 区間 [a,b) の中での進み具合を 0..1 で返す */
const seg = (u: number, a: number, b: number): number => clamp01((u - a) / (b - a));

/** その高さでのガラス内壁の半径 */
const wallR = (y: number): number =>
  lerp(GLASS_R_LOW, GLASS_R_HIGH, clamp01((y - GLASS_BOTTOM) / (GLASS_TOP - GLASS_BOTTOM)));

export const lavaLamp: SceneModule = {
  name: 'Lava Lamp',
  desc: '底の蝋が盛り上がってちぎれ、ゆっくり昇り、冷えて平たくなって沈む。',
  camera: { pos: [6.5, 9.5, 30], target: [0, 8.2, 0] },

  build(root) {
    breakTicks = tickers(BLOBS);
    mergeTicks = tickers(BLOBS);

    let s = 0.417;
    const rnd = (): number => (s = (s * 9301 + 0.49297) % 1);

    for (let i = 0; i < BLOBS; i++) {
      // 位相は均等割りを基準に少しだけ散らす（塊が団子にならない程度に）
      blobs[i * 5] = i / BLOBS + (rnd() - 0.5) * 0.06;
      blobs[i * 5 + 1] = 0.62 + rnd() * 0.5; // 半径
      blobs[i * 5 + 2] = 0.82 + rnd() * 0.46; // 周期の倍率。大きいほどゆっくり
      blobs[i * 5 + 3] = rnd() * Math.PI * 2; // 横揺れの位相
      blobs[i * 5 + 4] = 0.5 + rnd() * 0.7; // 横揺れの幅
    }

    // 塊も首も同じ球なので、まとめて 1 つの InstancedMesh で描く
    mesh = new THREE.InstancedMesh(
      new THREE.SphereGeometry(1, 26, 18),
      new THREE.MeshStandardMaterial({ roughness: 0.22, metalness: 0.12 }),
      COUNT,
    );
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    root.add(mesh);

    // 底の溜まり。上端が POOL_SURF に来るように中心を沈めてある
    pool = new THREE.Mesh(
      new THREE.SphereGeometry(1, 40, 24),
      new THREE.MeshStandardMaterial({ color: emberColor(0.6), roughness: 0.24, metalness: 0.1 }),
    );
    pool.position.y = POOL_SURF - POOL_H;
    pool.scale.set(POOL_R, POOL_H, POOL_R);
    root.add(pool);

    // ガラス筒。中身が透けるよう depthWrite を切り、最後に描く
    const glass = new THREE.Mesh(
      new THREE.CylinderGeometry(GLASS_R_HIGH, GLASS_R_LOW, GLASS_TOP - GLASS_BOTTOM, 56, 1, true),
      new THREE.MeshStandardMaterial({
        color: 0xffd8bb,
        roughness: 0.08,
        metalness: 0.85,
        transparent: true,
        opacity: 0.11,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    glass.position.y = (GLASS_BOTTOM + GLASS_TOP) / 2;
    glass.renderOrder = 2;
    root.add(glass);

    // 台座と笠。真っ黒だと闇に溶けるので、いちばん暗い暖色を薄く乗せてある
    const metal = new THREE.MeshStandardMaterial({
      color: emberColor(0.2),
      roughness: 0.34,
      metalness: 0.86,
    });

    // ガラスの端を隠して形を締める
    const base = new THREE.Mesh(new THREE.CylinderGeometry(3.7, 4.7, 2.1, 56), metal);
    base.position.y = 1.02;
    root.add(base);

    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 3.3, 1.7, 56), metal);
    cap.position.y = GLASS_TOP + 0.8;
    root.add(cap);

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(15, 96),
      new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.26, metalness: 0.9 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.02;
    root.add(floor);

    // 台座の中の電球。溜まりを下から炙っているように見せる
    const bulb = new THREE.PointLight(0xff9a5a, 26, 18, 2);
    bulb.position.set(0, POOL_SURF - 1.4, 0);
    root.add(bulb);
  },

  update(t) {
    const hue = drift(t);
    let bulge = 0; // 誕生・合流の分だけ溜まりが盛り上がる

    for (let i = 0; i < BLOBS; i++) {
      const r = blobs[i * 5 + 1]!;
      const raw = t / (CYCLE * blobs[i * 5 + 2]!) + blobs[i * 5]!;
      const u = raw - Math.floor(raw);

      // 高さ。生まれる → 昇る → 天井で漂う → 沈む、を区間ごとに補間する
      let y: number;
      if (u < BREAK) y = lerp(Y_LOW, Y_LOW + 2.9, smooth(seg(u, 0, BREAK)));
      else if (u < RISE) y = lerp(Y_LOW + 2.9, Y_HIGH, smooth(seg(u, BREAK, RISE)));
      else if (u < HANG) y = Y_HIGH - 0.22 * Math.sin(seg(u, RISE, HANG) * Math.PI);
      // 沈むときは底へ近づくほど速い。ここを減速させると塊が底に溜まって団子になる
      else y = lerp(Y_HIGH, Y_LOW, Math.pow(seg(u, HANG, 1), 1.7));

      // 横揺れ。ガラスの内壁にめり込まない範囲へ押し戻す
      const ph = blobs[i * 5 + 3]!;
      const sway = blobs[i * 5 + 4]!;
      const room = Math.max(0, wallR(y) - r - 0.35);
      // 塊ごとに軸から少しずらした定位置を持たせ、縦一列に重ならないようにする
      const sx = Math.cos(ph) * 0.85 + Math.sin(t * 0.21 + ph) * sway;
      const sz = Math.sin(ph) * 0.85 + Math.cos(t * 0.17 + ph * 1.7) * sway;
      const d = Math.hypot(sx, sz);
      const k = d > room ? room / d : 1;
      const bx = sx * k;
      const bz = sz * k;

      // 母体とのつながり。1 = 一続き、0 = 完全に離れている
      const link = u < BREAK ? 1 - smooth(seg(u, 0, BREAK)) : smooth(seg(u, MERGE, 1));
      bulge += link * r * 0.42;

      // 昇るときは縦に伸び、冷えて沈むときは平たくなる
      const e = 1 + 0.26 * Math.sin(u * Math.PI * 2);
      // 高いところほど冷えている
      const heat = 0.76 - 0.44 * clamp01((y - Y_LOW) / (Y_HIGH - Y_LOW));

      const at = i * (1 + NECK);
      dummy.position.set(bx, y, bz);
      dummy.scale.set(r / Math.sqrt(e), r * e, r / Math.sqrt(e));
      dummy.updateMatrix();
      mesh.setMatrixAt(at, dummy.matrix);
      ember(color, heat, hue);
      mesh.setColorAt(at, color);

      // 首。溜まりの上面と塊を、中ほどがくびれる球の列でつなぐ
      const w = link * link;
      const footY = POOL_SURF - 0.25;
      for (let j = 0; j < NECK; j++) {
        const p = (j + 1) / (NECK + 1);
        const bell = Math.sin(Math.PI * p);
        // つながっている間もわずかに、ちぎれる間際はきつく、中ほどがくびれる
        const waist = (1 - 0.3 * bell) * (1 - 0.6 * bell * (1 - w));
        dummy.position.set(bx * p * p, lerp(footY, y, p), bz * p * p);
        dummy.scale.setScalar(r * lerp(0.86, 0.72, p) * waist * w);
        dummy.updateMatrix();
        mesh.setMatrixAt(at + 1 + j, dummy.matrix);
        ember(color, lerp(0.76, heat, p), hue);
        mesh.setColorAt(at + 1 + j, color);
      }
    }

    pool.scale.y = POOL_H * (1 + Math.min(0.55, bulge));
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  },

  sound(t, _dt, sfx) {
    // 台座の中で灯りっぱなしのヒーター
    sfx.drone(tone(-3), 0.05);

    for (let i = 0; i < BLOBS; i++) {
      const raw = t / (CYCLE * blobs[i * 5 + 2]!) + blobs[i * 5]!;
      const pan = Math.sin(i * 1.9) * 0.5;

      // ちぎれた瞬間（位相が BREAK をまたぐ）
      for (let n = breakTicks[i]!(raw - BREAK); n > 0; n--) {
        sfx.drop(tone(4 + (i % 3)), { gain: 0.24, decay: 2.6, pan, bend: -0.35 });
      }
      // 溜まりへ融け戻った瞬間（位相が 0 をまたぐ）
      for (let n = mergeTicks[i]!(raw); n > 0; n--) {
        sfx.drop(tone(-1 + (i % 2)), { gain: 0.2, decay: 3.4, pan: -pan });
      }
    }
  },
};
