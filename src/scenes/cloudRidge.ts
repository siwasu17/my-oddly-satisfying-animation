import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, tickers } from '../audio.ts';
import { ember, drift } from '../palette.ts';

/**
 * 山脈の上を雲が流れていく。
 *
 * 横へ長く連なる稜線を 1 枚のメッシュで作り、その上を雲の塊が一定の速さで
 * 渡っていく。山の形そのものは動かない。動くのは雲と、雲が山肌へ落とす影だけで、
 * 影の帯が斜面をゆっくり撫でていくところがこのシーンの芯になる。
 *
 * 雲は 13 の塊（うち 3 つは手前の谷にたまる低い霧）に分かれ、1 塊は 6 個の
 * ふくらみで組んである。影は塊の中心から二次関数で落とし、地形の頂点色へ毎フレーム
 * 焼き込んでいる。雲は長さ 116 の帯を 2.4/秒 で流れるので、約 48 秒で最初の並びへ戻る。
 * 雲のたなびきや色のゆらぎもこの周期の整数倍にしてあり、一巡すると絵がぴたりと重なる。
 *
 * カメラは山脈を斜め上から見下ろす位置。音は雲が稜線をまたぐたびの風と、低い持続音だけ。
 */

/** 地形の広がり。X が稜線の走る向き、Z が奥行き。 */
const SPAN_X = 84;
// 手前は画面の下端より先まで伸ばす。切ると板の縁が地平線のように見えてしまう
const SPAN_Z = 64;
/** 地形を奥へずらす量。手前の裾野がカメラに寄りすぎて白飛びするのを防ぐ。 */
const SHIFT_Z = -10;
/** 地形の分割数。頂点は (GX+1)×(GZ+1) 個で、その全部を毎フレーム塗り替える。 */
const GX = 100;
const GZ = 60;
/** 稜線のいちばん高いところ。雲（y = 16〜19）をかすめる高さに取る。 */
const PEAK = 13;

/** 雲の塊の数と、1 塊を組むふくらみの数。 */
const CLOUDS = 13;
const PUFFS = 6;
/** 塊のうち、手前の谷にたまる低い霧の数（配列の末尾から数える）。 */
const LOW = 3;

/** 雲が流れる帯の長さと速さ。地形より長く取って、端の出入りを画面の外で済ませる。 */
const WIND_SPAN = 116;
const WIND = 2.4;
/** 帯を渡りきるまでの秒数 = ループの周期。ゆらぎの周期はこれの整数分の 1 にする。 */
const LOOP = WIND_SPAN / WIND;
const OMEGA = (Math.PI * 2) / LOOP;

/** 影のいちばん濃いところで、明るさをどれだけ引くか。 */
const SHADOW = 0.7;

/** 雲の塊ごとの [初期 x, z, y, 半径]。 */
const clouds = new Float32Array(CLOUDS * 4);
/** ふくらみごとの [塊内 dx, dy, dz, 大きさ, 揺れの位相]。 */
const puffs = new Float32Array(CLOUDS * PUFFS * 5);
/** 毎フレーム作り直す影の円 [中心 x, 中心 z, 半径の 2 乗の逆数, 濃さ]。 */
const shade = new Float32Array(CLOUDS * 4);

const dummy = new THREE.Object3D();
const color = new THREE.Color();

let cloudMesh: THREE.InstancedMesh;
let land: THREE.Mesh;
/** 地形の頂点ごとの、高さ 0..1 と斜面の受ける光 0..1。build で 1 度だけ求める。 */
let hNorm = new Float32Array(0);
let lit = new Float32Array(0);

/** 塊ごとに 1 周を数える。build のたびに作り直す。 */
let ticks = tickers(CLOUDS);

/** 固定シード。開き直しても同じ山と同じ雲が出るようにする。 */
let seed = 0.317;
const rnd = (): number => (seed = (seed * 9301 + 0.49297) % 1);

/** 雲の帯を [-WIND_SPAN/2, WIND_SPAN/2) に折り返す。 */
function wrapX(x: number): number {
  const w = WIND_SPAN;
  return ((((x + w / 2) % w) + w) % w) - w / 2;
}

/** 稜線の中心線。まっすぐだと定規に見えるので、2 つの正弦波で蛇行させる。 */
function crestZ(x: number): number {
  return SHIFT_Z + Math.sin(x * 0.075) * 5 + Math.sin(x * 0.03 + 1.3) * 3.5;
}

/**
 * 尾根状のノイズ 0..1。
 *
 * 正弦波の絶対値を 1 から引くと、山頂が尖って谷が丸い「尾根」になる。
 * 向きと周波数を変えて 4 枚重ねると、それらしい起伏の粗密が出る。
 */
function ridge(x: number, z: number): number {
  let h = 0;
  let sum = 0;
  let amp = 1;
  // 波長 2π/0.16 ≒ 39。絶対値で折り返すので、山は 84 の帯に 4〜5 個ぶん立つ
  let f = 0.16;
  let a = 0.4;
  for (let o = 0; o < 4; o++) {
    const u = x * Math.cos(a) + z * Math.sin(a);
    const v = -x * Math.sin(a) + z * Math.cos(a);
    const s = Math.sin(u * f + Math.sin(v * f * 0.6) * 1.4 + o * 2.1);
    h += amp * (1 - Math.abs(s));
    sum += amp;
    amp *= 0.46;
    // いちばん細かい層でも波長が格子 5 マスぶんは残るように、倍率は控えめにする
    f *= 1.9;
    a += 1.9;
  }
  return h / sum;
}

/** 中心線から離れるほど低くなる包絡をかけ、山脈の帯にまとめる。 */
function heightAt(x: number, z: number): number {
  const d = (z - crestZ(x)) / 13;
  const env = Math.exp(-d * d);
  // 0.1 を足して、帯の外にもなだらかな裾野を残す
  return PEAK * ridge(x, z) * (env * 0.94 + 0.1);
}

export const cloudRidge: SceneModule = {
  name: 'Cloud Ridge',
  desc: '連なる稜線の上を雲がゆっくり渡り、その影が山肌を撫でていく。',
  // 見上げ気味に構えて、稜線の上へ雲の通り道ぶんの空を空けておく
  camera: { pos: [3, 16, 30], target: [0, 8.5, -8] },

  build(root) {
    seed = 0.317;
    ticks = tickers(CLOUDS);

    // --- 山脈 -------------------------------------------------------------
    const geo = new THREE.PlaneGeometry(SPAN_X, SPAN_Z, GX, GZ);
    geo.rotateX(-Math.PI / 2); // XZ 平面へ寝かせる。以降 position は (x, 高さ, z)
    geo.translate(0, 0, SHIFT_Z); // 高さを入れる前にずらす。影の計算と座標系を揃えるため
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const p = pos.array as Float32Array;
    const count = pos.count;

    for (let v = 0; v < count; v++) {
      p[v * 3 + 1] = heightAt(p[v * 3], p[v * 3 + 2]);
    }
    geo.computeVertexNormals();

    // 頂点色は毎フレーム書き換えるので、入れ物だけ先に用意する
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(count * 3), 3));

    // 高さと斜面の向きは動かないので、ここで 1 度だけ求めて使い回す
    hNorm = new Float32Array(count);
    lit = new Float32Array(count);
    const nrm = geo.attributes.normal.array as Float32Array;
    // 共通ライトのキーライトと同じ向き（右上手前）から当てる
    const sun = new THREE.Vector3(8, 18, 10).normalize();
    for (let v = 0; v < count; v++) {
      hNorm[v] = Math.min(1, p[v * 3 + 1] / PEAK);
      const d = nrm[v * 3] * sun.x + nrm[v * 3 + 1] * sun.y + nrm[v * 3 + 2] * sun.z;
      lit[v] = d < 0 ? 0 : d;
    }

    land = new THREE.Mesh(
      geo,
      // 完全につや消しにする。少しでも光沢を残すと、手前の裾野が点光源で白く飛ぶ
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 }),
    );
    root.add(land);

    // --- 雲 ---------------------------------------------------------------
    for (let i = 0; i < CLOUDS; i++) {
      const low = i >= CLOUDS - LOW;
      // 帯の上へおおよそ等間隔に、少しだけ崩して置く
      const x0 = -WIND_SPAN / 2 + (i + 0.15 + rnd() * 0.7) * (WIND_SPAN / CLOUDS);
      const r = low ? 9 + rnd() * 4 : 5 + rnd() * 3.5;
      clouds[i * 4] = x0;
      // 高い雲は稜線の帯の上、低い霧はその手前の谷にたまらせる
      clouds[i * 4 + 1] = low ? SHIFT_Z + 13 + rnd() * 8 : SHIFT_Z - 14 + rnd() * 20;
      // 高い雲は共通ライトの点光源（y=10 前後）から離す。近づくと 1 個だけ白く飛ぶ
      clouds[i * 4 + 2] = low ? 1.8 + rnd() * 1.2 : 16 + rnd() * 3;
      clouds[i * 4 + 3] = r;

      for (let j = 0; j < PUFFS; j++) {
        const k = (i * PUFFS + j) * 5;
        const a = rnd() * Math.PI * 2;
        // 平方根寄りに散らすと、中心に寄りすぎず縁も薄くなりすぎない
        const rr = Math.pow(rnd(), 0.6) * r * 0.78;
        puffs[k] = Math.cos(a) * rr;
        puffs[k + 1] = (rnd() - 0.5) * r * 0.2;
        puffs[k + 2] = Math.sin(a) * rr * 0.62;
        puffs[k + 3] = r * (0.34 + rnd() * 0.3);
        puffs[k + 4] = rnd() * Math.PI * 2;
      }
    }

    const puffMat = new THREE.MeshStandardMaterial({
      roughness: 1,
      metalness: 0,
      transparent: true,
      opacity: 0.46,
      // 重なりを素直に混ぜたいので、深度は書かない
      depthWrite: false,
    });
    cloudMesh = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(1, 2),
      puffMat,
      CLOUDS * PUFFS,
    );
    cloudMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    cloudMesh.renderOrder = 1;
    root.add(cloudMesh);
  },

  update(t) {
    const hue = drift(t, 1 / LOOP);

    // --- 雲を流し、同時に影の円を作る -------------------------------------
    for (let i = 0; i < CLOUDS; i++) {
      const low = i >= CLOUDS - LOW;
      const cx = wrapX(clouds[i * 4] + t * WIND);
      const cz = clouds[i * 4 + 1];
      const cy = clouds[i * 4 + 2];
      const r = clouds[i * 4 + 3];

      // 影はキーライトと反対側（左奥）へ、雲の高さに比例してずれる。
      // ずらしすぎると影が稜線の裏へ落ちて見えなくなるので、日は高めに構える
      shade[i * 4] = cx - cy * 0.2;
      shade[i * 4 + 1] = cz - cy * 0.26;
      shade[i * 4 + 2] = 1 / (r * r);
      shade[i * 4 + 3] = low ? 0.45 : 1;

      for (let j = 0; j < PUFFS; j++) {
        const k = (i * PUFFS + j) * 5;
        const ph = puffs[k + 4];
        const s = puffs[k + 3] * (0.92 + 0.08 * Math.sin(t * OMEGA * 5 + ph * 1.7));

        dummy.position.set(
          cx + puffs[k],
          cy + puffs[k + 1] + Math.sin(t * OMEGA * 3 + ph) * 0.45,
          cz + puffs[k + 2],
        );
        dummy.rotation.set(ph, ph * 1.7, 0);
        // 縦に潰すと、丸い塊ではなく横へたなびく雲に見える
        // 低い霧はさらに平たく潰す。丸みが残ると泡のように見えてしまう
        dummy.scale.set(s, s * (low ? 0.18 : 0.42), s * 0.8);
        dummy.updateMatrix();
        cloudMesh.setMatrixAt(i * PUFFS + j, dummy.matrix);

        // 高い雲ほど日を受けて明るい。低い霧は沈ませる
        ember(color, low ? 0.24 : 0.55 + (cy - 16) * 0.03, hue, low ? 0 : 0.02);
        cloudMesh.setColorAt(i * PUFFS + j, color);
      }
    }
    cloudMesh.instanceMatrix.needsUpdate = true;
    if (cloudMesh.instanceColor) cloudMesh.instanceColor.needsUpdate = true;

    // --- 山肌を塗り直す ---------------------------------------------------
    const pos = land.geometry.attributes.position as THREE.BufferAttribute;
    const col = land.geometry.attributes.color as THREE.BufferAttribute;
    const p = pos.array as Float32Array;
    const c = col.array as Float32Array;

    for (let v = 0; v < pos.count; v++) {
      const x = p[v * 3];
      const z = p[v * 3 + 2];

      let s = 0;
      for (let i = 0; i < CLOUDS; i++) {
        const dx = x - shade[i * 4];
        const dz = z - shade[i * 4 + 1];
        // 1 -（距離/半径）^2 を 2 乗して、縁のぼやけた円にする
        const f = 1 - (dx * dx + dz * dz) * shade[i * 4 + 2];
        if (f > 0) s += f * f * shade[i * 4 + 3];
      }
      if (s > 1) s = 1;

      ember(color, 0.04 + hNorm[v] * 0.55 + lit[v] * 0.16 - s * SHADOW, hue);
      c[v * 3] = color.r;
      c[v * 3 + 1] = color.g;
      c[v * 3 + 2] = color.b;
    }
    col.needsUpdate = true;
  },

  sound(t, _dt, sfx) {
    // 雲は帯を 1 周するあいだに 1 度だけ端から端へ渡る。その継ぎ目で風を鳴らす
    for (let i = 0; i < CLOUDS; i++) {
      const phase = (clouds[i * 4] + t * WIND) / WIND_SPAN;
      for (let k = ticks[i](phase); k > 0; k--) {
        const low = i >= CLOUDS - LOW;
        sfx.air({
          gain: low ? 0.16 : 0.24,
          decay: low ? 5.5 : 3.4,
          freq: low ? 240 : 520,
          q: 0.9,
          // sweep は帯域の移動先を表す倍率。1 未満で、渡り終えるほど低く沈む
          sweep: low ? 0.45 : 0.6,
          pan: Math.sin(i * 1.7) * 0.6,
        });
      }
    }
    // 谷にたまった空気のような、切れ目のない低い響き
    sfx.drone(tone(-5), 0.055 + 0.02 * Math.sin(t * OMEGA * 2));
  },
};
