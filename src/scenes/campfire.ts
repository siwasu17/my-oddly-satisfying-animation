import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, ticker } from '../audio.ts';
import { SURFACE, ember, emberColor, drift } from '../palette.ts';

/**
 * Campfire。
 *
 * 円錐に組んだ薪の隙間で炎が舐めるように揺れ、そこから火の粉が
 * 渦を巻いて立ち上り、上空で暗くなって消える。
 * 炎は板に焼いたフラクタルノイズで、下から上へ流れながら舌が千切れていく。
 * 火の粉は GPU 側（頂点シェーダ）で軌跡を組み立てるので、2000 粒を超えても
 * CPU では 1 本のドローコールしか積まない。
 * 色はすべて palette の ember を 24 段の LUT に焼いてシェーダへ渡しているので、
 * 暖色帯から外れることが無い。
 * カメラは焚き火の端に座ったくらいの高さから、少し見下ろしている。
 * 音は数秒に一度パチッと爆ぜる短い音と、その下に敷いた低い唸り。
 */

// ---- 調整する数値はここにまとめる ----------------------------------------

/** 火の粉の粒数（GPU で動かすので CPU 負荷は粒数に依らない） */
const SPARKS = 2200;
/** 薪の本数（円錐に立てかける。手前の 1 本は組まない） */
const LOGS = 5;
/** 炎の板の枚数。奥行きはこの重ね方で作る */
const FLAME_LAYERS = 2;

/** 炎の板の下端。地面に接地させる（浮かせると炎だけ宙に浮いて見える） */
const FIRE_Y = 0.0;
/** 炎の板の高さと幅（層ごとに倍率を掛ける） */
const FLAME_H = 3.2;
const FLAME_W = 1.7;

/** 火の粉が湧き出す高さ */
const SPARK_Y0 = 0.4;
/** 火の粉の画面上の基準サイズ（px。カメラからの距離で割る） */
const SPARK_PX = 22;
/** 火の粉が上りきる高さの範囲 */
const RISE_MIN = 3.2;
const RISE_MAX = 6.4;
/** 一粒が湧いて消えるまでの秒数 */
const LIFE_MIN = 3.0;
const LIFE_MAX = 7.4;
/** 上るにつれて外へ広がる量 */
const SPREAD = 0.85;
/** 上りながら旋回する角度の最大（ラジアン） */
const TWIST = 3.4;

/** 薪の長さと太さ */
const LOG_LEN = 3.4;
const LOG_R = 0.19;
/** 薪を立てかける円の半径 */
const LOG_FOOT = 1.55;
/** 薪の根元が熾火色に焼けて見える高さ */
const BURN_H = 1.45;

/** 床の半径と、地面に落ちる照り返しの半径 */
const FLOOR_R = 8.5;
const GLOW_R = 3.4;

/** 爆ぜる音の刻み（1 秒あたり。ここから間引いて不規則にする） */
const POP_RATE = 1.15;

/** ember を焼き込む LUT の段数。シェーダ側の配列長と必ず揃える */
const LUT_N = 24;

// ---- シェーダから共有する状態 --------------------------------------------

const uTime = { value: 0 };
const uFlick = { value: 0.5 };
const uLut = { value: new Float32Array(LUT_N * 3) };
const uPixelRatio = { value: 1 };

const lutColor = new THREE.Color();

/** palette の ember を 24 段のグラデーションに焼く。drift のゆらぎもここで乗る。 */
const refreshLut = (t: number): void => {
  const hue = drift(t);
  for (let i = 0; i < LUT_N; i++) {
    ember(lutColor, i / (LUT_N - 1), hue);
    lutColor.toArray(uLut.value, i * 3);
  }
};

/**
 * 焼いた LUT を n（0..1）で引く。色は必ずここを通す＝暖色帯から出ない。
 *
 * GLSL ES 1.00 では uniform 配列を「ループ変数以外の添字」で引けないので、
 * 三角形の重み（隣り合う 2 段だけが 0 でない）を全段に掛けて足し合わせる。
 * 結果は線形補間そのものになる。
 */
const GLSL_LUT = /* glsl */ `
  uniform vec3 uLut[${LUT_N}];
  vec3 lut(float n) {
    float f = clamp(n, 0.0, 1.0) * float(${LUT_N - 1});
    vec3 c = vec3(0.0);
    for (int i = 0; i < ${LUT_N}; i++) {
      c += uLut[i] * max(0.0, 1.0 - abs(float(i) - f));
    }
    return c;
  }
`;

/** 値ノイズと、それを 4 オクターブ重ねた fbm。炎の舌はこれ 1 つで作っている。 */
const GLSL_NOISE = /* glsl */ `
  float hash31(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float vnoise(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash31(i), hash31(i + vec3(1, 0, 0)), f.x),
          mix(hash31(i + vec3(0, 1, 0)), hash31(i + vec3(1, 1, 0)), f.x), f.y),
      mix(mix(hash31(i + vec3(0, 0, 1)), hash31(i + vec3(1, 0, 1)), f.x),
          mix(hash31(i + vec3(0, 1, 1)), hash31(i + vec3(1, 1, 1)), f.x), f.y),
      f.z);
  }
  float fbm(vec3 p) {
    float v = 0.0;
    float a = 0.5;
    for (int k = 0; k < 4; k++) {
      v += a * vnoise(p);
      p *= 2.03;
      a *= 0.5;
    }
    return v;
  }
`;

// ---- 火の粉（GPU パーティクル）-------------------------------------------

/** 粒の軌跡はすべて頂点シェーダで組み立てる。CPU は毎フレーム t を渡すだけ。 */
const PARTICLE_VERT = /* glsl */ `
  attribute vec4 aA;   // 初期角 / 初期半径 / 寿命 / 位相ずれ
  attribute vec4 aB;   // 旋回 / 上る高さ / 横揺れ / サイズ倍率
  uniform float uTime;
  uniform float uY0;
  uniform float uSpread;
  uniform float uTwist;
  uniform float uSizePx;
  uniform float uPixelRatio;
  uniform float uFadePow;
  uniform float uRiseCurve;
  varying float vGlow;
  varying float vTwinkle;

  void main() {
    // 位相は t から作り直す。差分を積まないので、いつ開いても同じ軌跡になる
    float u = fract((uTime + aA.w) / aA.z);
    float y = uY0 + aB.y * pow(u, uRiseCurve);
    float r = aA.y * (1.0 + u * 0.9) + uSpread * u * u;
    float ang = aA.x + aB.x * uTwist * u;
    float wob = aB.z * u;

    vec3 p = vec3(
      cos(ang) * r + sin(u * 7.1 + aA.x * 3.3) * wob,
      y,
      sin(ang) * r + cos(u * 6.3 + aA.x * 2.1) * wob);

    // 立ち上がりは速く、消えぎわは長く引く
    vGlow = min(1.0, u / 0.09) * pow(1.0 - u, uFadePow);
    // 熾のちらつき。粒ごとに位相をずらす
    vTwinkle = 0.72 + 0.28 * sin(uTime * 17.0 + aA.x * 21.7);

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = uSizePx * aB.w * (0.35 + 0.65 * vGlow) * uPixelRatio / max(-mv.z, 0.1);
    gl_Position = projectionMatrix * mv;
  }
`;

const PARTICLE_FRAG = /* glsl */ `
  ${GLSL_LUT}
  uniform float uOpacity;
  uniform float uLutLo;
  uniform float uLutHi;
  uniform float uSoft;
  varying float vGlow;
  varying float vTwinkle;

  void main() {
    // 四角い点を丸く抜く。中心へ向かって二乗で締めると芯が残って粒に見える
    float d = length(gl_PointCoord - 0.5) * 2.0;
    float disk = smoothstep(1.0, uSoft, d);
    disk *= disk;
    if (disk <= 0.002) discard;

    float g = vGlow * vTwinkle;
    vec3 col = lut(mix(uLutLo, uLutHi, g));
    gl_FragColor = vec4(col, disk * g * uOpacity);
  }
`;

/** 粒の系統ごとの設定。1 つのシェーダを設定違いで使い回せるようにしてある。 */
interface ParticleCfg {
  count: number;
  lifeMin: number;
  lifeMax: number;
  r0: number;
  riseMin: number;
  riseMax: number;
  wobble: number;
  sizeMin: number;
  sizeMax: number;
  sizePx: number;
  opacity: number;
  lutLo: number;
  lutHi: number;
  y0: number;
  spread: number;
  twist: number;
  fadePow: number;
  riseCurve: number;
  soft: number;
}

let seed = 0.4831;
/** 固定シードの乱数。Math.random() を使うと開き直すたびに絵が変わる。 */
const rnd = (): number => (seed = (seed * 9301 + 0.49297) % 1);

const makeParticles = (cfg: ParticleCfg): THREE.Points => {
  const a = new Float32Array(cfg.count * 4);
  const b = new Float32Array(cfg.count * 4);
  for (let i = 0; i < cfg.count; i++) {
    const o = i * 4;
    a[o] = rnd() * Math.PI * 2; // 初期角
    a[o + 1] = cfg.r0 * (0.15 + rnd() * 0.85); // 初期半径
    a[o + 2] = cfg.lifeMin + rnd() * (cfg.lifeMax - cfg.lifeMin); // 寿命
    a[o + 3] = rnd() * 60; // 位相ずれ（湧く時刻をばらす）
    b[o] = (rnd() < 0.22 ? -1 : 1) * (0.45 + rnd() * 0.85); // 旋回
    b[o + 1] = cfg.riseMin + rnd() * (cfg.riseMax - cfg.riseMin); // 上る高さ
    b[o + 2] = cfg.wobble * (0.3 + rnd()); // 横揺れ
    b[o + 3] = cfg.sizeMin + rnd() * (cfg.sizeMax - cfg.sizeMin); // サイズ倍率
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(cfg.count * 3), 3));
  geo.setAttribute('aA', new THREE.BufferAttribute(a, 4));
  geo.setAttribute('aB', new THREE.BufferAttribute(b, 4));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 3, 0), 12);

  const mat = new THREE.ShaderMaterial({
    vertexShader: PARTICLE_VERT,
    fragmentShader: PARTICLE_FRAG,
    uniforms: {
      uTime,
      uLut,
      uPixelRatio,
      uY0: { value: cfg.y0 },
      uSpread: { value: cfg.spread },
      uTwist: { value: cfg.twist },
      uSizePx: { value: cfg.sizePx },
      uOpacity: { value: cfg.opacity },
      uLutLo: { value: cfg.lutLo },
      uLutHi: { value: cfg.lutHi },
      uFadePow: { value: cfg.fadePow },
      uRiseCurve: { value: cfg.riseCurve },
      uSoft: { value: cfg.soft },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  return new THREE.Points(geo, mat);
};

// ---- 炎 -------------------------------------------------------------------

/** 常にカメラを向く縦板。炎は横から見ても正面から見ても同じ形に見える。 */
const FLAME_VERT = /* glsl */ `
  uniform vec3 uOrigin;
  uniform float uW;
  uniform float uH;
  uniform float uFlick;
  varying vec2 vUv;

  void main() {
    vUv = uv;
    // ビュー行列から「画面の右方向」を取り出し、Y 軸は立てたままビルボードにする
    vec3 right = normalize(vec3(viewMatrix[0][0], 0.0, viewMatrix[2][0]));
    float grow = 0.86 + 0.22 * uFlick;
    vec3 p = uOrigin + right * position.x * uW + vec3(0.0, position.y * uH * grow, 0.0);
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  }
`;

const FLAME_FRAG = /* glsl */ `
  ${GLSL_LUT}
  ${GLSL_NOISE}
  uniform float uTime;
  uniform float uSeed;
  uniform float uSpeed;
  uniform float uOpacity;
  varying vec2 vUv;

  void main() {
    float h = vUv.y;
    float x = vUv.x - 0.5;

    // 下が広く上が細い輪郭。ゆっくりした横揺れで芯を振る
    float taper = pow(1.0 - h, 0.5) * (1.0 - 0.3 * h);
    float sway = (fbm(vec3(uSeed, h * 2.4 - uTime * 0.8, 0.0)) - 0.5) * 0.6 * h;

    // 左右の縁を別々のノイズで食わせる。左右対称の三角形に見えるのを防ぐ
    float edgeL = 0.44 * taper * (0.55 + 0.9 * fbm(vec3(uSeed, h * 3.4 - uTime * 1.25, 0.0)));
    float edgeR = 0.44 * taper * (0.55 + 0.9 * fbm(vec3(uSeed + 11.0, h * 3.4 - uTime * 1.1, 2.0)));
    float xs = x - sway;
    float d = xs < 0.0 ? -xs / max(edgeL, 1e-3) : xs / max(edgeR, 1e-3);
    // 下端は板の縁が水平に出るので、わずかにぼかして熾きの光へ溶かす
    float body = (1.0 - smoothstep(0.25, 1.0, d)) * smoothstep(-0.03, 0.12, h);

    // 上へ流れるノイズで舌を刻む。高いところほど千切れやすくする
    float n = fbm(vec3(x * 6.5 + uSeed, h * 4.2 - uTime * uSpeed * 1.4, uSeed * 3.7));
    float flame = body * smoothstep(0.4, 0.74, n + 0.3 - h * 0.5);
    if (flame <= 0.004) discard;

    // 根元ほど熱い。bloom（明度 0.28 で滲む）で白く飛ばないよう上限を抑える
    float heat = clamp(flame * (1.0 - h * 0.5), 0.0, 1.0);
    gl_FragColor = vec4(lut(0.3 + heat * 0.46), flame * uOpacity);
  }
`;

/** 薪の根元が熾火色に焼けて見えるよう、標準マテリアルに発光項だけ足す。 */
const burnLog = (mat: THREE.MeshStandardMaterial): void => {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uFlick = uFlick;
    shader.uniforms.uBurn = { value: emberColor(0.72) };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vLocal;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLocal = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         varying vec3 vLocal;
         uniform float uFlick;
         uniform vec3 uBurn;
         float bhash(vec3 p){ return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5); }`,
      )
      .replace(
        '#include <dithering_fragment>',
        `#include <dithering_fragment>
         float burn = smoothstep(${BURN_H.toFixed(2)}, 0.0, vLocal.y);
         float mottle = 0.45 + 0.55 * bhash(floor(vLocal * 7.0));
         gl_FragColor.rgb += uBurn * burn * burn * mottle * (0.2 + 0.16 * uFlick);`,
      );
  };
};

// ---------------------------------------------------------------------------

let fireLight: THREE.PointLight;

/** 爆ぜる音の刻み。build のたびに作り直す。 */
let tick = ticker();
let pop = 0;

/** 0..1 を行き来する炎のゆらぎ。update と sound の両方から引くので純関数にする。 */
const flicker = (t: number): number => {
  const a = Math.sin(t * 5.3) + Math.sin(t * 8.7 + 1.4) * 0.6 + Math.sin(t * 13.1 + 2.7) * 0.35;
  return 0.5 + a * 0.255;
};

export const campfire: SceneModule = {
  name: 'Campfire',
  desc: '組んだ薪の隙間で炎が揺れ、火の粉が渦を巻いて立ち上っては消えていく。',
  camera: { pos: [0, 4.1, 7.7], target: [0, 2.2, 0] },

  build(root) {
    tick = ticker();
    pop = 0;
    seed = 0.4831;
    uPixelRatio.value = Math.min(typeof window === 'undefined' ? 1 : window.devicePixelRatio, 2);
    refreshLut(0);

    // ---- 床。薪と炎が薄く映り込んで、焚き火が地面に置かれて見える ----
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(FLOOR_R, 96),
      new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.95, metalness: 0.06 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.01;
    root.add(floor);

    // ---- 地面に落ちる照り返し。炎のゆらぎに合わせて濃さが呼吸する ----
    // 単色の円を置くと外周にふちが出て「円盤」に見えるので、中心から減衰させる
    const glowMat = new THREE.ShaderMaterial({
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        ${GLSL_LUT}
        uniform float uFlick;
        varying vec2 vUv;
        void main() {
          float d = length(vUv - 0.5) * 2.0;
          float a = pow(max(0.0, 1.0 - d), 2.8);
          gl_FragColor = vec4(lut(0.5), a * (0.16 + 0.1 * uFlick));
        }
      `,
      uniforms: { uLut, uFlick },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const glow = new THREE.Mesh(new THREE.CircleGeometry(GLOW_R, 64), glowMat);
    glow.rotation.x = -Math.PI / 2;
    glow.position.y = 0.015;
    root.add(glow);

    // ---- 薪。円錐に立てかけた中に、地面へ寝かせた 2 本を差し込む ----
    const logGeo = new THREE.CylinderGeometry(LOG_R * 0.8, LOG_R, LOG_LEN, 8);
    logGeo.translate(0, LOG_LEN * 0.5, 0); // 原点を根元へ移して、傾けるだけで立てかかる
    const logMat = new THREE.MeshStandardMaterial({
      color: SURFACE,
      roughness: 0.92,
      metalness: 0.06,
    });
    burnLog(logMat);
    for (let i = 0; i < LOGS; i++) {
      // 手前の 1 本は組まない。火の粉の噴き出し口が開いて、三脚の交差が読める
      if (i === 1) continue;
      const a = (i / LOGS) * Math.PI * 2 + 0.3;
      const log = new THREE.Mesh(logGeo, logMat);
      log.position.set(Math.cos(a) * LOG_FOOT, 0, Math.sin(a) * LOG_FOOT);
      log.rotation.order = 'YXZ';
      log.rotation.y = -a;
      log.rotation.z = 0.52 + rnd() * 0.08; // 頂点で束ねるところまで倒す
      log.rotation.x = (rnd() - 0.5) * 0.1;
      root.add(log);
    }
    for (let i = 0; i < 2; i++) {
      const a = 1.1 + i * 2.4;
      const log = new THREE.Mesh(logGeo, logMat);
      log.position.set(Math.cos(a) * 2.1, LOG_R, Math.sin(a) * 2.1);
      log.rotation.order = 'YXZ';
      log.rotation.y = -a + 1.4;
      log.rotation.z = Math.PI * 0.5;
      root.add(log);
    }

    // 薪の足元に熾火の粒も置いていたが、球を火の色まで明るくすると bloom で
    // 白い小石のように浮いてしまうので落とした。火床は炎の根元と照り返しが担う。

    // ---- 炎。幅と速さをずらした板を重ねて奥行きを出す ----
    const flameGeo = new THREE.PlaneGeometry(1, 1);
    flameGeo.translate(0, 0.5, 0); // 下端を原点に置いて、Y スケールだけで伸ばせるようにする
    for (let i = 0; i < FLAME_LAYERS; i++) {
      const k = i / (FLAME_LAYERS - 1);
      const mat = new THREE.ShaderMaterial({
        vertexShader: FLAME_VERT,
        fragmentShader: FLAME_FRAG,
        uniforms: {
          uTime,
          uLut,
          uFlick,
          uOrigin: { value: new THREE.Vector3((k - 0.5) * 0.34, FIRE_Y, (0.5 - k) * 0.3) },
          uW: { value: FLAME_W * (1.05 - k * 0.4) },
          uH: { value: FLAME_H * (0.8 + k * 0.35) },
          uSeed: { value: 3.1 + i * 7.7 },
          uSpeed: { value: 1.15 + k * 0.5 },
          uOpacity: { value: 0.58 - k * 0.12 },
        },
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      });
      root.add(new THREE.Mesh(flameGeo, mat));
    }

    // ---- 火の粉 ----
    root.add(
      makeParticles({
        count: SPARKS,
        lifeMin: LIFE_MIN,
        lifeMax: LIFE_MAX,
        r0: 1.0,
        riseMin: RISE_MIN,
        riseMax: RISE_MAX,
        wobble: 0.32,
        sizeMin: 0.4,
        sizeMax: 1.0,
        sizePx: SPARK_PX,
        opacity: 0.92,
        // 消えぎわまで火の色を保つ。暗い側（薔薇色）まで落とすと煙のように見える
        lutLo: 0.5,
        lutHi: 0.98,
        y0: SPARK_Y0,
        spread: SPREAD,
        twist: TWIST,
        fadePow: 1.9,
        riseCurve: 0.82,
        soft: 0.05,
      }),
    );

    // 煙も同じ仕組みで出していたが、大きな粒が bloom で丸いボケ玉になり、
    // 火の粉の柱の上に泡が浮いて見えたので落とした（粒を小さくすると今度は見えない）。

    // ---- 火そのものが光源なので、ここだけは PointLight を足す ----
    fireLight = new THREE.PointLight(emberColor(0.9), 4.2, 9, 2);
    fireLight.position.set(0, 0.9, 0);
    root.add(fireLight);
  },

  update(t) {
    const fl = flicker(t);

    // シェーダが見るのはこの 3 つだけ。粒の軌跡も炎の形も GPU 側で組み立てる
    uTime.value = t;
    uFlick.value = fl;
    refreshLut(t);

    // ---- 光源と地面の照り返し。炎の揺らぎに合わせて強さが呼吸する ----
    fireLight.intensity = 1.9 + fl * 1.1;
    fireLight.position.x = Math.sin(t * 1.7) * 0.12;
    fireLight.position.z = Math.cos(t * 2.1) * 0.12;
  },

  sound(t, _dt, sfx) {
    // 焚き火の唸り。炎の揺らぎと同じ式から作るので、映像とずれない
    sfx.drone(tone(0), 0.05 + flicker(t) * 0.03);

    for (let k = tick(t * POP_RATE); k > 0; k--) {
      pop++;
      // 刻みを間引いて「数秒に一度、不規則に」爆ぜる形にする
      const h = (Math.sin(pop * 12.9898) * 43758.5453) % 1;
      const r = h < 0 ? h + 1 : h;
      if (r < 0.42) continue;
      sfx.pluck(tone(7 + Math.floor(r * 9)), {
        gain: 0.1 + r * 0.14,
        decay: 0.2 + r * 0.3,
        pan: Math.sin(pop * 2.7) * 0.6,
      });
    }
  },
};
