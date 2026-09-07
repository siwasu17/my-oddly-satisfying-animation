import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, tickers } from '../audio.ts';
import { ember, drift } from '../palette.ts';

/**
 * 山脈の上を雲が流れていく。
 *
 * 横へ長く連なる稜線を 1 枚のメッシュで作り、その稜線を雲の帯が一定の速さで
 * 渡っていく。山の形そのものは動かない。動くのは雲と、雲が山肌へ落とす影だけで、
 * 稜線に引っかかった雲がほどけていくところと、影の帯が斜面をゆっくり撫でていく
 * ところがこのシーンの芯になる。
 *
 * 雲は 13 の塊（うち 3 つは手前の谷にたまる低い霧）で、1 塊は 42 枚の
 * 「縁の溶けた丸い染み」を積んで作る。板はカメラのほうを向くので、どこから見ても
 * 塊の内側が透けて見える。染みは底が平らで上が盛り上がる積雲の形に配り、
 * 上ほど明るく底ほど沈むよう色を付けてある（雲が自分に落とす影の代わり）。
 *
 * 流体らしさは 3 つの仕掛けで出している。ひとつは渦のポテンシャルの回転
 * （curl）で染みを押し流すこと。湧き出しの無い流れなので、隣り合う染みが
 * まとまって渦を巻き、内側が練られているように見える。ふたつめは風のせん断で、
 * 上ほど先へ押し出して塊を進行方向へ倒す。影も塊を左右に割った重心から落とすので、
 * 雲がねじれると影も一緒にねじれる。
 *
 * みっつめが山との衝突。雲の帯は稜線（PEAK = 13）より低いところを流れるので、
 * 山頂が雲の底を突き破る。染みは 1 枚ずつ真下の地形の高さと傾きを引き、
 * 斜面に乗り上げたぶんだけ持ち上がり（ただし持ち上げきらないので山頂は雲を貫く）、
 * 風上の斜面では前へ進めずに溜まって濃くなり、風下では引き伸ばされてほどける。
 * 地面に近い染みほど渦を強くしてあるので、稜線をまたぐたびに流れが波立つ。
 *
 * 雲は長さ 116 の帯を 2.4/秒 で流れるので、約 48 秒で最初の並びへ戻る。
 * 渦も揺れも色のゆらぎもこの周期の整数倍にしてあり、一巡すると絵がぴたりと重なる。
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
/** 稜線のいちばん高いところ。雲の帯（y = 7〜10）を突き破る高さに取る。 */
const PEAK = 13;

/** 雲の塊の数と、1 塊を組む染みの数。 */
const CLOUDS = 13;
const PUFFS = 42;
const TOTAL = CLOUDS * PUFFS;
/** 塊のうち、手前の谷にたまる低い霧の数（配列の末尾から数える）。 */
const LOW = 3;

/** 雲が流れる帯の長さと速さ。地形より長く取って、端の出入りを画面の外で済ませる。 */
const WIND_SPAN = 116;
const WIND = 2.4;
/** 帯を渡りきるまでの秒数 = ループの周期。ゆらぎの周期はこれの整数分の 1 にする。 */
const LOOP = WIND_SPAN / WIND;
const OMEGA = (Math.PI * 2) / LOOP;

/** 雲が地面との間に空けておく高さ。染みの大きさに応じてもう少し足す。 */
const CLEAR = 0.6;
/**
 * 山にぶつかったと見なす高さの差。これより低く飛ぶほど流れが乱れる。
 * 大きく取ると雲の帯じゅうが常に乱れて、山のせいで乱れているように見えない。
 */
const REACH = 7;
/** 風上をどれだけ先読みするか。空気は障害物の手前から持ち上がる。 */
const LOOK = 6;

/** 影のいちばん濃いところで、明るさをどれだけ引くか。 */
const SHADOW = 0.7;
/** 影は塊を左右に割った 2 つの重心から落とす。 */
const LOBES = CLOUDS * 2;

/** 渦を見る目の細かさ。粗い渦が塊を練り、細かい渦が縁をほつれさせる。 */
const K1 = 0.3;
const K2 = K1 * 2.4;

/** 共通ライトのキーライトを水平に潰した向き。日の当たる側を決めるのに使う。 */
const SUN_X = 0.625;
const SUN_Z = 0.781;

/**
 * 地形の高さを粗く写した表。
 *
 * 雲は毎フレーム 546 枚が「自分の下に山があるか」を訊くので、そのたびに
 * heightAt()（正弦 12 本）を回すと重い。build で 1 度だけ格子へ焼いて、
 * あとは双一次補間で読む。ならされた高さのほうが、雲が細かい岩の凹凸ではなく
 * 山の大きなうねりに反応するので、都合もよい。
 */
const LX = 128;
const LZ = 64;
const LAND_X0 = -WIND_SPAN / 2 - 4;
const LAND_X1 = WIND_SPAN / 2 + 4;
const LAND_Z0 = SHIFT_Z - 34;
const LAND_Z1 = SHIFT_Z + 34;
const LAND_DX = (LAND_X1 - LAND_X0) / LX;
const LAND_DZ = (LAND_Z1 - LAND_Z0) / LZ;
const field = new Float32Array((LX + 1) * (LZ + 1));
/** sampleLand() の答え [高さ, 斜面の x 方向の傾き, z 方向の傾き]。 */
const landAt = new Float32Array(3);

/** 塊ごとの [初期 x, z, y, 半径]。 */
const clouds = new Float32Array(CLOUDS * 4);
/** 染み 1 枚あたりの控えの数。 */
const P = 8;
/** 染みごとの [塊内 x, y, z, 差し渡し, 位相, 縁への近さ 0..1, 高さ 0..1, 日の側 -1..1]。 */
const puffs = new Float32Array(TOTAL * P);
/** 毎フレーム作り直す影の楕円 [中心 x, 中心 z, 1/rx², 1/rz², 濃さ]。 */
const shade = new Float32Array(LOBES * 5);
/** 染みごとの不透明度。インスタンス属性として GPU へ渡す。 */
const alphas = new Float32Array(TOTAL);

const dummy = new THREE.Object3D();
const color = new THREE.Color();
const spin = new THREE.Quaternion();
const SPIN_AXIS = new THREE.Vector3(0, 0, 1);
/** カメラの向き。板をカメラへ正対させるために、描画の直前に控えておく。 */
const faceCam = new THREE.Quaternion();
const flow1 = new THREE.Vector3();
const flow2 = new THREE.Vector3();

let cloudMesh: THREE.InstancedMesh;
let alphaAttr: THREE.InstancedBufferAttribute;
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

/** 地形の表を双一次補間で読み、高さと傾きを landAt に入れる。 */
function sampleLand(x: number, z: number): void {
  let u = ((x - LAND_X0) / (LAND_X1 - LAND_X0)) * LX;
  let v = ((z - LAND_Z0) / (LAND_Z1 - LAND_Z0)) * LZ;
  u = u < 0 ? 0 : u > LX ? LX : u;
  v = v < 0 ? 0 : v > LZ ? LZ : v;
  const iu = u >= LX ? LX - 1 : Math.floor(u);
  const iv = v >= LZ ? LZ - 1 : Math.floor(v);
  const fu = u - iu;
  const fv = v - iv;
  const row = LX + 1;
  const h00 = field[iv * row + iu];
  const h10 = field[iv * row + iu + 1];
  const h01 = field[(iv + 1) * row + iu];
  const h11 = field[(iv + 1) * row + iu + 1];
  const a = h00 + (h10 - h00) * fu;
  const b = h01 + (h11 - h01) * fu;
  landAt[0] = a + (b - a) * fv;
  landAt[1] = ((h10 - h00) * (1 - fv) + (h11 - h01) * fv) / LAND_DX;
  landAt[2] = (b - a) / LAND_DZ;
}

/**
 * 渦のポテンシャル場の回転（curl）を out に入れる。各成分はおおよそ ±2。
 *
 * 適当な向きへ揺らすと雲は「散る」が、回転を取った流れは湧き出しが無いので
 * かさが変わらず、隣り合う染みが揃って渦を巻く。これが水や空気らしさになる。
 * ポテンシャルは正弦の積なので、微分は手で書き下せる。
 */
function curl(x: number, y: number, z: number, ph: number, out: THREE.Vector3): void {
  const sy = Math.sin(y + ph);
  const cy = Math.cos(y + ph);
  const s07z = Math.sin(z * 0.7);
  const c07z = Math.cos(z * 0.7);
  const sz = Math.sin(z + ph * 1.3);
  const cz = Math.cos(z + ph * 1.3);
  const s05x = Math.sin(x * 0.5);
  const c05x = Math.cos(x * 0.5);
  const s08x = Math.sin(x * 0.8 + ph * 0.7);
  const c08x = Math.cos(x * 0.8 + ph * 0.7);
  const sy2 = Math.sin(y);
  const cy2 = Math.cos(y);

  // ポテンシャル P = (sy·c07z, sz·c05x, s08x·cy2) の rot P
  out.set(
    -s08x * sy2 - cz * c05x,
    -0.7 * sy * s07z - 0.8 * c08x * cy2,
    -0.5 * sz * s05x - cy * c07z,
  );
}

/** 縁が溶けていく丸い染み。1 枚を全インスタンスで使い回す。 */
let blob: THREE.Texture | null = null;
function blobTexture(): THREE.Texture {
  if (blob) return blob;
  const S = 96;
  const canvas = document.createElement('canvas');
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(S, S);
  const d = img.data;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = (x + 0.5) / S - 0.5;
      const v = (y + 0.5) / S - 0.5;
      const th = Math.atan2(v, u);
      // 真円だと同じ判子を並べたように見えるので、輪郭をわずかに歪ませる
      const q =
        Math.sqrt(u * u + v * v) * 2 * (1 + 0.1 * Math.sin(th * 3 + 0.7) + 0.07 * Math.sin(th * 5 - 1.9));
      // 中心から外へ二乗で薄れる。板の縁を目立たせないため 0 まで落としきる
      const a = q >= 1 ? 0 : Math.pow(1 - q * q, 2.1);
      const k = (y * S + x) * 4;
      d[k] = 255;
      d[k + 1] = 255;
      d[k + 2] = 255;
      d[k + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  blob = new THREE.CanvasTexture(canvas);
  blob.colorSpace = THREE.SRGBColorSpace;
  return blob;
}

/**
 * 染み用のマテリアル。
 *
 * InstancedMesh のインスタンス色は RGB しか持てないので、濃さを別に渡したい。
 * 属性 aAlpha を 1 本足して、組み上がったシェーダの不透明度に掛ける。
 */
function puffMaterial(): THREE.MeshBasicMaterial {
  const mat = new THREE.MeshBasicMaterial({
    map: blobTexture(),
    transparent: true,
    // 重なりを素直に混ぜたいので、深度は書かない
    depthWrite: false,
  });
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aAlpha;\nvarying float vAlpha;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvAlpha = aAlpha;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vAlpha;')
      .replace(
        'vec4 diffuseColor = vec4( diffuse, opacity );',
        'vec4 diffuseColor = vec4( diffuse, opacity * vAlpha );',
      );
  };
  return mat;
}

export const cloudRidge: SceneModule = {
  name: 'Cloud Ridge',
  desc: '稜線に引っかかった雲が渦を巻いてほどけ、その影が山肌を撫でていく。',
  // 稜線と、そこへ引っかかる雲の帯を画面の中ほどへ置く
  camera: { pos: [3, 16.5, 30], target: [0, 10.5, -8] },

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

    // 雲が山を避けるために読む高さの表。地形と同じ式から焼くのでずれない
    for (let iz = 0; iz <= LZ; iz++) {
      const z = LAND_Z0 + iz * LAND_DZ;
      for (let ix = 0; ix <= LX; ix++) {
        field[iz * (LX + 1) + ix] = heightAt(LAND_X0 + ix * LAND_DX, z);
      }
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
      // 塊どうしの間隔は WIND_SPAN/CLOUDS ≒ 8.9。広げすぎると隣とつながって
      // 一枚の靄になるので、半径はその半分あたりで止める
      const r = low ? 9 + rnd() * 4 : 5 + rnd() * 3;
      // 塊ごとの背の高さ。低く広がるものと、こんもり湧き上がるものを混ぜる
      const tall = low ? 0.22 : 0.55 + rnd() * 0.45;
      clouds[i * 4] = x0;
      // 高い雲は稜線の帯の上、低い霧はその手前の谷にたまらせる
      clouds[i * 4 + 1] = low ? SHIFT_Z + 13 + rnd() * 8 : SHIFT_Z - 14 + rnd() * 20;
      // 高い雲は稜線（PEAK = 13）に食い込む高さ。山頂が雲の底を突き破る
      clouds[i * 4 + 2] = low ? 1.8 + rnd() * 1.2 : 7 + rnd() * 3;
      clouds[i * 4 + 3] = r;

      for (let j = 0; j < PUFFS; j++) {
        const k = (i * PUFFS + j) * P;
        const a = rnd() * Math.PI * 2;
        // 中心を厚く、外へ行くほどまばらに。芯があると塊の輪郭が立つ
        const rr = Math.pow(rnd(), 0.75);
        // 横へ長い楕円に散らす。風に流れる雲は進行方向へ伸びている
        const ox = Math.cos(a) * rr * r * (low ? 1.2 : 0.95);
        const oz = Math.sin(a) * rr * r * (low ? 0.8 : 0.52);
        // 底は平ら、上はドーム。積雲はこの形をしている
        const cap = Math.sqrt(Math.max(0, 1 - rr * rr));
        const up = Math.pow(rnd(), 0.8);
        puffs[k] = ox;
        puffs[k + 1] = -r * 0.05 + r * tall * cap * up;
        puffs[k + 2] = oz;
        // 隣どうしが十分に重なる大きさにする。粒が離れると雲ではなく点の群れに見える
        puffs[k + 3] = r * (low ? 0.55 : 0.62) * (0.6 + 0.5 * (1 - rr)) * (0.8 + 0.4 * rnd());
        puffs[k + 4] = rnd() * Math.PI * 2;
        puffs[k + 5] = rr;
        // 明るさとせん断に使う高さは、ドームの天井までの割合ではなく塊全体での高さ。
        // これを取り違えると、低い縁のふくらみまで日なた色になってしまう
        puffs[k + 6] = up * cap;
        puffs[k + 7] = (ox * SUN_X + oz * SUN_Z) / (r * 1.4);
      }
    }

    // 板は 1 枚 1 枚がカメラを向く。どの角度から見ても塊の内側が透ける
    const puffGeo = new THREE.PlaneGeometry(1, 1);
    puffGeo.setAttribute('aAlpha', new THREE.InstancedBufferAttribute(alphas, 1));
    alphaAttr = puffGeo.attributes.aAlpha as THREE.InstancedBufferAttribute;
    alphaAttr.setUsage(THREE.DynamicDrawUsage);

    cloudMesh = new THREE.InstancedMesh(puffGeo, puffMaterial(), TOTAL);
    cloudMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    cloudMesh.renderOrder = 1;
    // 板の中心が画面の外へ出ても切られないように、視錐台のふるいから外す
    cloudMesh.frustumCulled = false;
    // update はカメラを受け取れないので、描画の直前に向きだけ控えておく
    cloudMesh.onBeforeRender = (_r, _s, cam) => {
      faceCam.copy(cam.quaternion);
    };
    root.add(cloudMesh);
  },

  update(t) {
    const hue = drift(t, 1 / LOOP);
    // 渦の位相。LOOP の整数倍で回すので、一巡すると同じ形へ戻る
    const churn = t * OMEGA;

    // --- 雲を流し、同時に影の楕円を作る -----------------------------------
    for (let i = 0; i < CLOUDS; i++) {
      const low = i >= CLOUDS - LOW;
      const cx = wrapX(clouds[i * 4] + t * WIND);
      const cz = clouds[i * 4 + 1];
      const cy = clouds[i * 4 + 2];
      const r = clouds[i * 4 + 3];
      // 風は上ほど速い。塊は進行方向へ倒れ、その倒れ具合もゆっくり変わる
      const shear = r * (low ? 0.2 : 0.5) * (0.7 + 0.3 * Math.sin(churn * 2 + i));

      // 影は塊を左右に割った 2 つの重心から落とす。雲がねじれれば影もねじれる
      let lx = 0;
      let lz = 0;
      let ln = 0;
      let rx = 0;
      let rz = 0;
      let rn = 0;

      for (let j = 0; j < PUFFS; j++) {
        const k = (i * PUFFS + j) * P;
        const ox = puffs[k];
        const oy = puffs[k + 1];
        const oz = puffs[k + 2];
        const ph = puffs[k + 4];
        const rr = puffs[k + 5];
        const up = puffs[k + 6];
        const sunSide = puffs[k + 7];

        // 塊の中の座標で流れを見る。x が帯の端で折り返しても継ぎ目が出ない
        curl(ox * K1 + i * 13.7, oy * K1 * 1.7, oz * K1, churn * 3, flow1);
        curl(ox * K2 + i * 13.7, oy * K2 * 1.7, oz * K2, churn * 7 + 1.9, flow2);

        let px = cx + ox + shear * (up - 0.35);
        let py = cy + oy;
        let pz = cz + oz;

        // --- 山にぶつかったところで流れが変わる ---------------------------
        // 少し風下（+x 側）を先読みする。空気は斜面へ着く前から持ち上がる
        sampleLand(px + LOOK, pz);
        const ground = landAt[0];
        const gx = landAt[1];
        const gz = landAt[2];

        // 斜面に乗り上げたぶんだけ持ち上げる。ただし持ち上げきらないので、
        // 高い山頂は雲の底を突き破り、雲は稜線に引っかかったまま流れていく
        const floor = ground + CLEAR + puffs[k + 3] * 0.35;
        if (py < floor) py += (floor - py) * 0.35;

        // 地面への近さ 0..1。触れているほど流れが荒れる
        const near = 1 - Math.min(1, Math.max(0, (py - ground) / REACH));
        // 風上の斜面（gx > 0）では前へ進めず溜まり、風下では引き伸ばされる
        const slope = gx > 1 ? 1 : gx < -1 ? -1 : gx;
        px -= slope * near * 2.6;
        // 山頂は左右へよける
        pz -= gz * near * 2.2;

        // 触れているところは渦を強める。稜線をまたぐたびに雲が波立つ
        const stir = r * (1 + 1.6 * near);
        px += (flow1.x + flow2.x * 0.45) * stir * 0.16;
        py += (flow1.y + flow2.y * 0.45) * stir * 0.1 + near * 1.2;
        pz += (flow1.z + flow2.z * 0.45) * stir * 0.13;

        // わき上がるように、染めそのものも息をする。山際ではさらに膨らむ
        const s =
          puffs[k + 3] * (0.86 + 0.2 * Math.sin(churn * 5 + ph * 2.3)) * (1 + 0.25 * near);
        dummy.position.set(px, py, pz);
        spin.setFromAxisAngle(SPIN_AXIS, ph + 0.35 * Math.sin(churn * 3 + ph));
        dummy.quaternion.copy(faceCam).multiply(spin);
        // 横へ広げ縦を潰すと、丸い粒ではなく風にたなびく雲に見える
        dummy.scale.set(s * 1.3, s * (low ? 0.6 : 0.85), 1);
        dummy.updateMatrix();
        cloudMesh.setMatrixAt(i * PUFFS + j, dummy.matrix);

        // 上ほど日を浴び、底は自分の影で沈む。縁が日の側なら少しだけ光る
        // 風上の斜面では湧いて濃く、風下ではほどけて薄くなる
        const oro = slope * near;
        const n = low ? 0.3 + up * 0.08 : 0.5 + up * 0.24 + sunSide * 0.06;
        const glow = low
          ? -0.06 + up * 0.07
          : -0.15 + up * 0.26 + rr * rr * Math.max(0, sunSide) * 0.05 + oro * 0.04;
        ember(color, n, hue, glow);
        cloudMesh.setColorAt(i * PUFFS + j, color);

        // 縁ほど薄い。ほつれた染みが背景へ溶けていく
        alphas[i * PUFFS + j] =
          (low ? 0.24 : 0.37) *
          (1 - 0.8 * rr * rr) *
          (0.9 + 0.1 * Math.sin(churn * 4 + ph)) *
          // 風下側の消えかたを強くする。山を越えた雲はほどけて薄くなる
          (1 + (oro > 0 ? 0.5 : 0.85) * oro);

        if (ox < 0) {
          lx += px;
          lz += pz;
          ln++;
        } else {
          rx += px;
          rz += pz;
          rn++;
        }
      }

      // 影はキーライトと反対側（左奥）へ、雲の高さに比例してずれる。
      // ずらしすぎると影が稜線の裏へ落ちて見えなくなるので、日は高めに構える
      const dx = cy * 0.2;
      const dz = cy * 0.26;
      const str = low ? 0.4 : 0.75;
      // 塊の伸びと同じく、影も進行方向へ長い楕円にする
      const invX = 1 / (r * 0.95 * (r * 0.95));
      const invZ = 1 / (r * 0.7 * (r * 0.7));
      const a = i * 10;
      shade[a] = (ln > 0 ? lx / ln : cx) - dx;
      shade[a + 1] = (ln > 0 ? lz / ln : cz) - dz;
      shade[a + 2] = invX;
      shade[a + 3] = invZ;
      shade[a + 4] = str;
      shade[a + 5] = (rn > 0 ? rx / rn : cx) - dx;
      shade[a + 6] = (rn > 0 ? rz / rn : cz) - dz;
      shade[a + 7] = invX;
      shade[a + 8] = invZ;
      shade[a + 9] = str;
    }
    cloudMesh.instanceMatrix.needsUpdate = true;
    if (cloudMesh.instanceColor) cloudMesh.instanceColor.needsUpdate = true;
    alphaAttr.needsUpdate = true;

    // --- 山肌を塗り直す ---------------------------------------------------
    const pos = land.geometry.attributes.position as THREE.BufferAttribute;
    const col = land.geometry.attributes.color as THREE.BufferAttribute;
    const p = pos.array as Float32Array;
    const c = col.array as Float32Array;

    for (let v = 0; v < pos.count; v++) {
      const x = p[v * 3];
      const z = p[v * 3 + 2];

      let s = 0;
      for (let i = 0; i < LOBES; i++) {
        const dx = x - shade[i * 5];
        const dz = z - shade[i * 5 + 1];
        // 1 -（距離/半径）^2 を 2 乗して、縁のぼやけた楕円にする
        const f = 1 - dx * dx * shade[i * 5 + 2] - dz * dz * shade[i * 5 + 3];
        if (f > 0) s += f * f * shade[i * 5 + 4];
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
