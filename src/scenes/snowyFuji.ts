import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, ticker } from '../audio.ts';
import { ember, drift } from '../palette.ts';

/**
 * 冠雪した富士山。静かな湖に逆さ富士を映しながら、雪の冠が伸び縮みする。
 *
 * 山体は裾を長く引く凹んだ円錐で、山頂に浅い火口がある。平たい裾は湖に沈め、
 * 斜面が立ち上がりかけたところを岸にしてある。山腹には放射状に
 * 沢が刻んであり、雪はこの沢筋に沿って指のように山すそへ降りていく。
 * 40 秒で一巡し、14 秒かけて山の半分近くまで白く覆い（降雪）、6 秒そのまま、
 * 16 秒かけて沢に白い筋を残しながら山頂へ引いていく（融雪）。沢は尾根より
 * 雪が長く残るので、引いていくときほど筋がくっきり浮かぶ。この冠の縁が
 * 数十本の沢でいっせいに伸び縮みするところがシーンの芯。
 *
 * 雪の多い季節ほど、8 秒ごとの突風で山頂から雪煙が風下へ流れる。
 * 湖面の下には山を上下に裏返したものを置き、水の揺らぎで横へわずかに波打たせて
 * 逆さ富士にしている。山の後ろの地平には残照の帯を置き、山の輪郭を浮かせる。
 *
 * カメラは湖面の少し上から山を正面に見る。音は突風の風、低い持続音、
 * 冠が満ちたときと引ききったときの一音ずつ。
 * 雲・笠雲、降る雪の粒、光の移ろい、手前の山並みはスコープ外。
 */

// ---- 山の形 ----------------------------------------------------------------

/** 山の高さの式の最大値。湖面は y = 0 */
const H = 11;
/** 裾の半径。ここで山の高さの式が 0 になる */
const R = 25;
/**
 * 山全体を沈める量。平たく長い裾は湖の底に沈め、斜面が立ち上がりかけたところを岸にする。
 * 裾を水面より上に残すと、手前へ張り出した裾が台座の円盤に見え、逆さ富士も隠してしまう。
 */
const SINK = 2.6;
/** 斜面の反り。大きいほど裾が長く引いて、上が尖る */
const PROFILE = 1.75;
/** 火口の半径と深さ */
const CRATER_R = 1.5;
const CRATER_DEPTH = 0.9;
/** 周方向と半径方向の分割数。沢の幅が 1〜3 分割に乗るくらいの細かさ */
const NA = 432;
const NR = 72;
/** 沢の本数・深さ */
const GULLIES = 46;
const GULLY_DEPTH = 0.38;

// ---- 雪 --------------------------------------------------------------------

/** 一巡の秒数 */
const PERIOD = 40;
/** 周期の中の区切り（0..1）: 降り始め / 満ちる / 引き始め / 引ききる */
const FALL0 = 0.05;
const FALL1 = 0.4;
const MELT0 = 0.55;
const MELT1 = 0.95;
/** 雪線（山の高さ 0..1 で測る）。夏はここより上だけ、冬はここまで白い */
const LINE_SUMMER = 0.84;
const LINE_WINTER = 0.45;
/** 沢の中は雪線がこれだけ下がる。夏ほど大きく、筋が長く残る */
const GULLY_SNOW_SUMMER = 0.36;
const GULLY_SNOW_WINTER = 0.1;
/** 雪の縁のぼかし幅と、縁のでこぼこ */
const SNOW_SOFT = 0.012;
const SNOW_EDGE_NOISE = 0.035;
/** 雪の明るさ（ember の glow） */
const SNOW_GLOW = 0.08;

// ---- 雪煙 ------------------------------------------------------------------

const DUST = 90;
/** 1 粒の寿命と突風の周期（どちらも PERIOD を割り切る） */
const DUST_LIFE = 5;
const GUST = 8;
/** 風下へ流れる距離 */
const DUST_DRIFT = 10;
const DUST_SIZE = 1.5;
const DUST_ALPHA = 0.2;
/** 風の向き（水平） */
const WIND = new THREE.Vector3(1, 0, -0.35).normalize();
const WIND_SIDE = new THREE.Vector3(-WIND.z, 0, WIND.x);

// ---- 湖と空 ----------------------------------------------------------------

const WATER_R = 200;
const WATER_OPACITY = 0.4;
/** 逆さ富士の暗さ（頂点色に掛ける） */
const REFLECT_TINT = 0xc8bcb4;
/** 逆さ富士の横揺れの振れ幅 */
const RIPPLE_AMP = 0.07;
/** 残照の帯。空の筒の半径・高さと、帯の太さ・明るさ */
// 縦長画面ではカメラが最大 3 倍まで下がるので、それより外に置く
const SKY_R = 160;
const SKY_H = 90;
const GLOW_H = 9;
const GLOW_GAIN = 0.55;

/** 湖面すれすれから、わずかに見下ろす。岸が画面の中ほど、逆さ富士がその下に収まる */
const CAMERA_POS: [number, number, number] = [0, 1, 34];
const CAMERA_TARGET: [number, number, number] = [0, -0.25, 0];

// ---------------------------------------------------------------------------

const TAU = Math.PI * 2;

let seed = 0.6173;
/** 固定シードの乱数。Math.random() を使うと開き直すたびに絵が変わる。 */
const rnd = (): number => (seed = (seed * 9301 + 0.49297) % 1);

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (a: number, b: number, x: number): number => {
  const k = clamp01((x - a) / (b - a));
  return k * k * (3 - 2 * k);
};
const smoother = (x: number): number => x * x * x * (x * (x * 6 - 15) + 10);
const frac = (x: number): number => x - Math.floor(x);

/** 周期の中での雪の多さ 0（夏の冠）〜 1（冬の満冠） */
function coverage(t: number): number {
  const p = frac(t / PERIOD);
  if (p < FALL0) return 0;
  if (p < FALL1) return smoother((p - FALL0) / (FALL1 - FALL0));
  if (p < MELT0) return 1;
  if (p < MELT1) return 1 - smoother((p - MELT0) / (MELT1 - MELT0));
  return 0;
}

/** 突風の強さ 0..1。周期の半ばで吹き切る */
function gust(t: number): number {
  return Math.pow(0.5 - 0.5 * Math.cos((t / GUST) * TAU), 2.5);
}

/** 山の高さの式（0..1）。火口の中は皿状に凹む */
function profile(r: number): number {
  if (r >= CRATER_R) return Math.pow(Math.max(0, (R - r) / (R - CRATER_R)), PROFILE);
  const k = r / CRATER_R;
  return 1 - (CRATER_DEPTH / H) * (1 - k * k) * (1 - k * k);
}

/** 柔らかい丸い点。雪煙の粒に使う。材質を破棄してもテクスチャは残るので 1 枚を使い回す */
let dotTex: THREE.DataTexture | null = null;
function dotTexture(): THREE.DataTexture {
  if (dotTex) return dotTex;
  const S = 32;
  const data = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = (x + 0.5) / S - 0.5;
      const v = (y + 0.5) / S - 0.5;
      const q = Math.sqrt(u * u + v * v) * 2;
      const a = q >= 1 ? 0 : Math.pow(1 - q * q, 2);
      const k = (y * S + x) * 4;
      data[k] = 255;
      data[k + 1] = 255;
      data[k + 2] = 255;
      data[k + 3] = Math.round(a * 255);
    }
  }
  dotTex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  dotTex.magFilter = THREE.LinearFilter;
  dotTex.minFilter = THREE.LinearFilter;
  dotTex.needsUpdate = true;
  return dotTex;
}

// ---- build で作り直すもの ---------------------------------------------------

let mountainGeo: THREE.BufferGeometry;
let colors: Float32Array;
/** 頂点ごとの雪の判定値（高さ + 縁のでこぼこ）と、沢の深さ 0..1 */
let snowBase: Float32Array;
let gullyW: Float32Array;
/** 頂点ごとの岩の色の混ぜ具合（0 = 裾の樹海の暗さ、1 = 上の赤い砂礫）と沢の陰 */
let rockMix: Float32Array;
let rockShade: Float32Array;

let dustGeo: THREE.BufferGeometry;
let dustPos: Float32Array;
let dustCol: Float32Array;
/** 粒ごとの [火口の縁の角度, 位相, 速さ, 持ち上がり, 横の広がり, 揺れの位相] */
let dust: Float32Array;

const uTime = { value: 0 };

const rockLo = new THREE.Color();
const rockHi = new THREE.Color();
const snowCol = new THREE.Color();
const dustTint = new THREE.Color();

let gustTick = ticker();
let fullTick = ticker();
let bareTick = ticker();
let gustCount = 0;

function buildMountain(): THREE.BufferGeometry {
  // 沢の配置: [角度, 幅, 深さ, 始まり, 終わり, 曲がり]
  const g = new Float32Array(GULLIES * 6);
  for (let i = 0; i < GULLIES; i++) {
    const o = i * 6;
    g[o] = ((i + (rnd() - 0.5) * 0.7) / GULLIES) * TAU;
    g[o + 1] = 0.022 + rnd() * 0.045;
    g[o + 2] = 0.45 + rnd() * 0.55;
    g[o + 3] = 0.03 + rnd() * 0.12;
    g[o + 4] = 0.42 + rnd() * 0.4;
    g[o + 5] = (rnd() - 0.5) * 0.25;
  }
  // 山肌と雪の縁のでこぼこ。周方向の周波数は整数にして、ぐるりと継ぎ目なくつなぐ
  const WAVES = 7;
  const w = new Float32Array(WAVES * 4);
  for (let k = 0; k < WAVES; k++) {
    w[k * 4] = 3 + Math.floor(rnd() * 22);
    w[k * 4 + 1] = 2 + rnd() * 9;
    w[k * 4 + 2] = rnd() * TAU;
    w[k * 4 + 3] = 1 / (1 + k * 0.6);
  }
  const bumpy = (th: number, u: number): number => {
    let s = 0;
    for (let k = 0; k < WAVES; k++) {
      s += w[k * 4 + 3]! * Math.sin(w[k * 4]! * th + w[k * 4 + 1]! * u + w[k * 4 + 2]!);
    }
    return s / 2.2;
  };

  const V = NA * (NR + 1);
  const pos = new Float32Array(V * 3);
  colors = new Float32Array(V * 3);
  snowBase = new Float32Array(V);
  gullyW = new Float32Array(V);
  rockMix = new Float32Array(V);
  rockShade = new Float32Array(V);

  for (let j = 0; j <= NR; j++) {
    // 山頂側を細かく刻む（雪の縁が動くのは上半分）
    const u = Math.pow((j + 0.5) / (NR + 0.5), 1.3);
    const r = u * R;
    const f = profile(r);
    for (let i = 0; i < NA; i++) {
      const th = (i / NA) * TAU;
      let gv = 0;
      for (let k = 0; k < GULLIES; k++) {
        const o = k * 6;
        const bell = smooth(g[o + 3]!, g[o + 3]! + 0.07, u) * (1 - smooth(g[o + 4]! - 0.22, g[o + 4]!, u));
        if (bell <= 0) continue;
        let d = th - g[o]! - g[o + 5]! * u;
        d -= Math.round(d / TAU) * TAU;
        const x = d / g[o + 1]!;
        const v = g[o + 2]! * Math.exp(-x * x) * bell;
        if (v > gv) gv = v;
      }
      const n = bumpy(th, u);
      // 沢と凹凸は斜面の中ほどで効かせ、火口の縁と水際では消す
      const mid = smooth(0.04, 0.12, u) * (1 - smooth(0.7, 0.98, u));
      const rim = Math.pow(1 - u, 6) * 0.14 * Math.sin(3 * th + 1.1);
      const h = H * f - SINK - GULLY_DEPTH * gv * mid - 0.12 * n * mid + rim;

      const v = j * NA + i;
      pos[v * 3] = Math.cos(th) * r;
      pos[v * 3 + 1] = h;
      pos[v * 3 + 2] = Math.sin(th) * r;

      snowBase[v] = f + SNOW_EDGE_NOISE * n;
      gullyW[v] = gv;
      rockMix[v] = smooth(0.24, 0.62, f);
      rockShade[v] = 1 - 0.35 * gv * mid;
    }
  }

  const idx: number[] = [];
  for (let j = 0; j < NR; j++) {
    for (let i = 0; i < NA; i++) {
      const i2 = (i + 1) % NA;
      const a = j * NA + i;
      const b = j * NA + i2;
      const c = (j + 1) * NA + i;
      const d = (j + 1) * NA + i2;
      // 角度は +X から +Z へ回るので、この順で法線が外（上）を向く
      idx.push(a, b, c, b, d, c);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const col = new THREE.BufferAttribute(colors, 3);
  col.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('color', col);
  geo.setIndex(idx);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/** 実物の山の材質。水面より下は描かない（沈んだ裾が手前で逆さ富士を隠さないように） */
function cutMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0 });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', 'varying float vUp;\nvoid main() {')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vUp = transformed.y;');
    shader.fragmentShader = shader.fragmentShader.replace(
      'void main() {',
      'varying float vUp;\nvoid main() {\n  if ( vUp < 0.0 ) discard;',
    );
  };
  return mat;
}

/** 逆さ富士の材質。法線を裏返し直して光の当たり方を実物と揃え、水面より上に出た部分は捨てる */
function mirrorMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    color: REFLECT_TINT,
    roughness: 0.9,
    metalness: 0,
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTime;
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', 'uniform float uTime;\nvarying float vUp;\nvoid main() {')
      // 鏡に写した物体は法線も上下が入れ替わり、上からの光が当たらなくなる。
      // 裏返す前の法線に戻しておくと、実物と同じ面が明るく写る
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n  objectNormal.y = -objectNormal.y;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vUp = transformed.y;
        // 水面のさざ波で、写った像が画面の横方向へ揺れる
        vec2 toCam = normalize( cameraPosition.xz + vec2( 1e-4 ) );
        vec2 side = vec2( -toCam.y, toCam.x );
        float dep = max( transformed.y, 0.0 );
        float wob = sin( dep * 1.9 - uTime * 1.5707963 ) + 0.6 * sin( dep * 4.3 + uTime * 2.3561945 );
        transformed.xz += side * wob * ${RIPPLE_AMP.toFixed(3)} * smoothstep( 0.0, 2.5, dep );`,
      );
    shader.fragmentShader = shader.fragmentShader.replace(
      'void main() {',
      'varying float vUp;\nvoid main() {\n  if ( vUp < 0.0 ) discard;',
    );
  };
  return mat;
}

/** 残照の帯を塗った空の筒。水面の下にも同じ帯が続くので、湖に空が写って見える */
function buildSky(): THREE.Mesh {
  const geo = new THREE.CylinderGeometry(SKY_R, SKY_R, SKY_H, 96, 36, true);
  const p = geo.attributes.position!;
  const c = new Float32Array(p.count * 3);
  const glow = ember(new THREE.Color(), 0.62, 0.0);
  const bg = new THREE.Color(0x080607);
  const tmp = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    // 山の真後ろ（-Z）ほど濃く、横へ回るほど薄れる
    const back = Math.pow(0.5 - 0.5 * (z / SKY_R), 1.6);
    const side = 0.25 + 0.75 * back;
    const band = Math.exp(-Math.pow(Math.abs(y) / GLOW_H, 1.4));
    const k = GLOW_GAIN * band * side * (1 - 0.15 * Math.abs(x / SKY_R));
    tmp.copy(bg).lerp(glow, clamp01(k));
    c[i * 3] = tmp.r;
    c[i * 3 + 1] = tmp.g;
    c[i * 3 + 2] = tmp.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
  const mat = new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.BackSide,
    fog: false,
    depthWrite: false,
  });
  const sky = new THREE.Mesh(geo, mat);
  sky.renderOrder = -1;
  return sky;
}

function buildDust(): THREE.BufferGeometry {
  dust = new Float32Array(DUST * 6);
  for (let i = 0; i < DUST; i++) {
    const o = i * 6;
    dust[o] = rnd() * TAU;
    dust[o + 1] = rnd();
    dust[o + 2] = 0.7 + rnd() * 0.6;
    dust[o + 3] = 0.2 + rnd() * 0.9;
    dust[o + 4] = (rnd() - 0.5) * 2;
    dust[o + 5] = rnd() * TAU;
  }
  dustPos = new Float32Array(DUST * 3);
  dustCol = new Float32Array(DUST * 4);
  const geo = new THREE.BufferGeometry();
  const p = new THREE.BufferAttribute(dustPos, 3);
  p.setUsage(THREE.DynamicDrawUsage);
  const c = new THREE.BufferAttribute(dustCol, 4);
  c.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', p);
  geo.setAttribute('color', c);
  // 位置は毎フレーム書き換えるので、囲む球は手で与える
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(DUST_DRIFT * 0.5, H, 0), DUST_DRIFT + 4);
  return geo;
}

export const snowyFuji: SceneModule = {
  name: 'Snowy Fuji',
  desc: '湖に逆さ富士を映す冠雪の富士山。雪が沢筋を伝って山すそへ降り、白い筋を残して山頂へ引いていく。',
  camera: { pos: CAMERA_POS, target: CAMERA_TARGET },

  build(root) {
    seed = 0.6173;
    gustTick = ticker();
    fullTick = ticker();
    bareTick = ticker();
    gustCount = 0;

    root.add(buildSky());

    mountainGeo = buildMountain();
    const mountain = new THREE.Mesh(mountainGeo, cutMaterial());
    root.add(mountain);

    // 逆さ富士。同じジオメトリを上下に裏返して水面の下へ置く
    const mirror = new THREE.Mesh(mountainGeo, mirrorMaterial());
    mirror.scale.y = -1;
    root.add(mirror);

    // 水面は光を受けない。受けるとステージの点光源が光の柱になって湖に写り込む
    const water = new THREE.Mesh(
      new THREE.CircleGeometry(WATER_R, 96),
      new THREE.MeshBasicMaterial({ color: 0x0c0808, transparent: true, opacity: WATER_OPACITY }),
    );
    water.rotation.x = -Math.PI / 2;
    water.renderOrder = 2;
    root.add(water);

    dustGeo = buildDust();
    const dustMat = new THREE.PointsMaterial({
      size: DUST_SIZE,
      map: dotTexture(),
      vertexColors: true,
      transparent: true,
      depthWrite: false,
    });
    const dustPts = new THREE.Points(dustGeo, dustMat);
    dustPts.renderOrder = 3;
    root.add(dustPts);

    // 雪煙も湖に写す。水面より先に描いて、水の色をかぶせる
    const dustMirror = new THREE.Points(
      dustGeo,
      new THREE.PointsMaterial({
        size: DUST_SIZE,
        map: dotTexture(),
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        color: REFLECT_TINT,
      }),
    );
    dustMirror.scale.y = -1;
    dustMirror.renderOrder = 1;
    root.add(dustMirror);
  },

  update(t) {
    uTime.value = t % PERIOD;
    const hue = drift(t);
    const c = coverage(t);

    // ---- 雪の冠 ----
    const line = LINE_SUMMER + (LINE_WINTER - LINE_SUMMER) * c;
    const gb = GULLY_SNOW_SUMMER + (GULLY_SNOW_WINTER - GULLY_SNOW_SUMMER) * c;
    ember(rockLo, 0.03, hue);
    ember(rockHi, 0.2, hue - 0.01);
    ember(snowCol, 1, hue * 0.5, SNOW_GLOW);
    const lo0 = line - SNOW_SOFT;
    const span = 2 * SNOW_SOFT;
    const V = snowBase.length;
    for (let v = 0; v < V; v++) {
      const m = rockMix[v]!;
      const sh = rockShade[v]!;
      const rr = (rockLo.r + (rockHi.r - rockLo.r) * m) * sh;
      const rg = (rockLo.g + (rockHi.g - rockLo.g) * m) * sh;
      const rb = (rockLo.b + (rockHi.b - rockLo.b) * m) * sh;
      let s = (snowBase[v]! + gb * gullyW[v]! - lo0) / span;
      s = s <= 0 ? 0 : s >= 1 ? 1 : s * s * (3 - 2 * s);
      const o = v * 3;
      colors[o] = rr + (snowCol.r - rr) * s;
      colors[o + 1] = rg + (snowCol.g - rg) * s;
      colors[o + 2] = rb + (snowCol.b - rb) * s;
    }
    mountainGeo.attributes.color!.needsUpdate = true;

    // ---- 雪煙 ----
    ember(dustTint, 1, hue * 0.5, SNOW_GLOW * 0.6);
    const top = H - SINK + 0.1;
    for (let i = 0; i < DUST; i++) {
      const o = i * 6;
      const a = frac(t / DUST_LIFE + dust[o + 1]!);
      const born = t - a * DUST_LIFE;
      // 生まれた瞬間の風と雪の多さで濃さが決まる（夏は雪煙がほとんど立たない）
      const strength = gust(born) * (0.08 + 0.92 * coverage(born));
      const alpha = DUST_ALPHA * strength * Math.pow(Math.sin(Math.PI * a), 1.3);

      const ang = dust[o]!;
      const along = DUST_DRIFT * dust[o + 2]! * (1 - Math.pow(1 - a, 1.6));
      const spread = dust[o + 4]! * a * 2.2 + 0.25 * Math.sin(a * 7 + dust[o + 5]!);
      const x0 = Math.cos(ang) * CRATER_R;
      const z0 = Math.sin(ang) * CRATER_R;
      const p = i * 3;
      dustPos[p] = x0 + WIND.x * along + WIND_SIDE.x * spread;
      dustPos[p + 1] =
        top + dust[o + 3]! * 1.3 * Math.sin(Math.PI * a) - 1.9 * a * a + 0.15 * Math.sin(a * 9 + dust[o + 5]!);
      dustPos[p + 2] = z0 + WIND.z * along + WIND_SIDE.z * spread;

      const q = i * 4;
      dustCol[q] = dustTint.r;
      dustCol[q + 1] = dustTint.g;
      dustCol[q + 2] = dustTint.b;
      dustCol[q + 3] = alpha;
    }
    dustGeo.attributes.position!.needsUpdate = true;
    dustGeo.attributes.color!.needsUpdate = true;
  },

  sound(t, _dt, sfx) {
    const c = coverage(t);
    sfx.drone(tone(-3), 0.035 + 0.035 * c);

    // 突風が吹き切るたびに、山頂を渡る風
    for (let k = gustTick(t / GUST - 0.5); k > 0; k--) {
      gustCount++;
      sfx.air({
        gain: 0.1 + 0.22 * c,
        decay: 2.8,
        freq: 420 + (gustCount % 3) * 90,
        q: 0.9,
        pan: 0.35,
      });
    }
    // 冠が満ちたとき、引ききったとき
    for (let k = fullTick(t / PERIOD - FALL1); k > 0; k--) {
      sfx.pluck(tone(12), { gain: 0.22, decay: 3.2, pan: -0.2 });
    }
    for (let k = bareTick(t / PERIOD - MELT1); k > 0; k--) {
      sfx.pluck(tone(9), { gain: 0.18, decay: 3.2, pan: 0.2 });
    }
  },
};
