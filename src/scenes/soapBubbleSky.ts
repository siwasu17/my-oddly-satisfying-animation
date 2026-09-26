import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, tickers } from '../audio.ts';
import { emberColor } from '../palette.ts';

/**
 * Soap Bubble Sky。
 *
 * 暮れかけの空へ、大小のシャボン玉がたくさん昇っていく。玉は画面の下から現れ、
 * 右へ流れる風に押されながらゆらゆらと揺れ、膜の厚みが渦を巻いて干渉色が表面を
 * 流れる。高さはそれぞれ違うところで、ふくらむように弾けて消える。
 * 膜の色は palette の ember を 4 色焼き込んで引くので、薔薇〜琥珀の帯から出ない。
 * 空はドームに描いた夕焼けのグラデーションと、遠くの丘の稜線だけ。
 * 1 個ずつ自分の周期（14〜22 秒）で昇っては弾けて頭に戻るので、全体は永久に途切れない。
 * 音は弾けた瞬間の小さな pluck。3 個に 1 個だけ鳴らす。
 */

// ---- 調整する数値はここにまとめる ----------------------------------------

/** シャボン玉の数 */
const COUNT = 44;
/** 生まれる高さ（画面の下より少し下） */
const BOTTOM = -11;
/** この高さまで昇るあいだに、薄い姿から濃くなる（画面の下端の文字に玉が溜まらない） */
const FADE_FROM = -4;
const FADE_TO = 3;
/** 弾ける高さの範囲 */
const POP_MIN = 7;
const POP_MAX = 21;
/** 昇る速さの範囲（毎秒） */
const SPEED_MIN = 1.3;
const SPEED_MAX = 2.1;
/** 弾けてから次に現れるまでの休み（秒）の最大 */
const REST_MAX = 3;
/** 横と奥行きの散らばり */
const SPREAD_X = 20;
const Z_NEAR = 5;
const Z_FAR = -14;
/** 半径の範囲 */
const R_MIN = 0.35;
const R_MAX = 1.35;
/** 風で右へ流れる速さ（毎秒）と、横揺れの幅 */
const WIND = 0.35;
const SWAY = 0.9;
/** 弾ける演出の長さ（秒）と、そのときふくらむ量 */
const POP_DUR = 0.16;
const POP_GROW = 0.35;
/** 膜の明るさ。bloom（明度 0.28）で滲む量はほぼこれで決まる */
const FILM_GAIN = 0.8;
/** ハイライトの明るさ */
const SPEC_GAIN = 1.1;
/** 空の明るさの倍率 */
const SKY_GAIN = 1;

const CAMERA_POS: [number, number, number] = [0, 8, 27];
const CAMERA_TARGET: [number, number, number] = [0, 7.5, 0];

// ---- シェーダ ------------------------------------------------------------

const BUBBLE_VERT = /* glsl */ `
attribute vec3 aState;   // x = 種, y = 弾ける進み（0 = 無傷, 1 = 消えた）, z = 濃さ

varying vec3 vNormal;
varying vec3 vView;
varying vec3 vLocal;
varying vec3 vState;

void main() {
  vec4 world = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vec4 mv = viewMatrix * world;
  vNormal = normalize(mat3(viewMatrix) * mat3(modelMatrix) * mat3(instanceMatrix) * normal);
  vView = normalize(-mv.xyz);
  vLocal = position;
  vState = aState;
  gl_Position = projectionMatrix * mv;
}
`;

const BUBBLE_FRAG = /* glsl */ `
uniform float uTime;
uniform vec3 uFilm[4];
uniform vec3 uSpec;
uniform float uFilmGain;
uniform float uSpecGain;

varying vec3 vNormal;
varying vec3 vView;
varying vec3 vLocal;
varying vec3 vState;

/** 膜の厚み 0..1 を、4 色の帯へ巡回させて引く */
vec3 film(float k) {
  k = fract(k) * 4.0;
  float f = fract(k);
  f = f * f * (3.0 - 2.0 * f);
  int i = int(floor(k));
  vec3 a = uFilm[0];
  vec3 b = uFilm[1];
  if (i == 1) { a = uFilm[1]; b = uFilm[2]; }
  else if (i == 2) { a = uFilm[2]; b = uFilm[3]; }
  else if (i == 3) { a = uFilm[3]; b = uFilm[0]; }
  return mix(a, b, f);
}

void main() {
  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;
  vec3 v = normalize(vView);
  float ndv = clamp(abs(dot(n, v)), 0.0, 1.0);
  float fres = pow(1.0 - ndv, 2.2);

  float seed = vState.x;
  float pop = vState.y;

  // 膜は重力で下へ流れて下ほど厚い。そこへ渦がゆっくり巻いて帯がうねる
  vec3 p = vLocal;
  float swirl = sin(p.x * 3.1 + uTime * 0.7 + seed * 6.3)
              * sin(p.z * 2.7 - uTime * 0.5 + seed * 3.1)
              + 0.5 * sin(p.y * 4.3 + p.x * 1.7 + uTime * 0.9 + seed * 9.7);
  float thick = -p.y * 0.45 + swirl * 0.22 + (1.0 - ndv) * 0.55 + seed * 3.0 + uTime * 0.03;
  vec3 col = film(thick) * (0.08 + 1.35 * fres) * uFilmGain;

  // 空の明るいほう（左上）を映した窓のようなハイライトと、下の小さな照り返し
  vec3 r = reflect(-v, n);
  float hi = pow(max(dot(r, normalize(vec3(-0.45, 0.75, 0.5))), 0.0), 48.0);
  float lo = pow(max(dot(r, normalize(vec3(0.5, -0.6, 0.6))), 0.0), 90.0) * 0.35;
  col += uSpec * (hi + lo) * uSpecGain;

  // 弾ける瞬間は縁が一瞬明るくなって、すっと抜ける
  float fade = 1.0 - smoothstep(0.0, 1.0, pop);
  col *= fade * vState.z * (1.0 + 1.6 * pop * (1.0 - pop) * 4.0 * fres);

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const SKY_FRAG = /* glsl */ `
uniform vec3 uTop;
uniform vec3 uMid;
uniform vec3 uGlow;
uniform vec3 uHill;
uniform float uGain;
varying vec3 vDir;

void main() {
  vec3 d = normalize(vDir);
  float az = atan(d.z, d.x);
  // 夕焼けは画面の下寄り（地平線の少し上）が明るく、上へ向かって暗く沈む
  float y = d.y;
  vec3 col = mix(uGlow, uMid, smoothstep(-0.2, 0.12, y));
  col = mix(col, uTop, smoothstep(0.05, 0.55, y));
  // 遠くの丘の稜線。ここから下は空の光が届かない
  float ridge = -0.24 + 0.035 * sin(az * 3.0 + 1.2) + 0.018 * sin(az * 11.0) + 0.008 * sin(az * 29.0);
  col = mix(col, uHill, smoothstep(ridge + 0.004, ridge - 0.004, y));
  gl_FragColor = vec4(col * uGain, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// ---- 状態 ----------------------------------------------------------------

const dummy = new THREE.Object3D();

let mesh: THREE.InstancedMesh;
let state: THREE.InstancedBufferAttribute;
let filmMat: THREE.ShaderMaterial;

/** 玉ごとの [x0, z, 半径, 速さ, 弾ける高さ, 休み, 位相, 揺れの速さ] */
const STRIDE = 8;
const bubbles = new Float32Array(COUNT * STRIDE);

/** 玉ごとに、弾けた回数を数える */
let ticks = tickers(COUNT);

/** 1 周（昇る + 弾ける + 休み）の秒数 */
function cycleOf(i: number): number {
  const o = i * STRIDE;
  return (bubbles[o + 4] - BOTTOM) / bubbles[o + 3] + POP_DUR + bubbles[o + 5];
}

/** 暮れかけの空へ、干渉色の膜をまとったシャボン玉が昇っていき、ふくらむように弾ける。 */
export const soapBubbleSky: SceneModule = {
  name: 'Soap Bubble Sky',
  desc: '暮れかけの空へ、たくさんのシャボン玉が揺れながら昇り、それぞれの高さでふっと弾ける。',
  camera: { pos: CAMERA_POS, target: CAMERA_TARGET },
  environment: 0,

  build(root) {
    ticks = tickers(COUNT);

    let s = 0.417;
    const rnd = (): number => (s = (s * 9301 + 0.49297) % 1);
    for (let i = 0; i < COUNT; i++) {
      const o = i * STRIDE;
      const zr = rnd();
      bubbles[o] = (rnd() * 2 - 1) * SPREAD_X;
      bubbles[o + 1] = Z_FAR + (Z_NEAR - Z_FAR) * zr;
      // 大きい玉ほど少なく
      const rr = rnd();
      bubbles[o + 2] = R_MIN + (R_MAX - R_MIN) * rr * rr;
      bubbles[o + 3] = SPEED_MIN + (SPEED_MAX - SPEED_MIN) * rnd();
      bubbles[o + 4] = POP_MIN + (POP_MAX - POP_MIN) * rnd();
      bubbles[o + 5] = REST_MAX * rnd();
      bubbles[o + 6] = rnd();
      bubbles[o + 7] = 0.35 + 0.4 * rnd();
    }

    // ---- 空 ----
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(180, 48, 32),
      new THREE.ShaderMaterial({
        vertexShader: SKY_VERT,
        fragmentShader: SKY_FRAG,
        side: THREE.BackSide,
        depthWrite: false,
        uniforms: {
          uTop: { value: emberColor(0.02, 0, -0.08).multiplyScalar(0.35) },
          uMid: { value: emberColor(0.18, 0.02, -0.02).multiplyScalar(0.6) },
          uGlow: { value: emberColor(0.62, 0, 0).multiplyScalar(0.55) },
          uHill: { value: emberColor(0, 0, -0.1).multiplyScalar(0.12) },
          uGain: { value: SKY_GAIN },
        },
      }),
    );
    sky.position.set(0, CAMERA_POS[1], 0);
    sky.renderOrder = -1;
    sky.frustumCulled = false;
    root.add(sky);

    // ---- シャボン玉 ----
    filmMat = new THREE.ShaderMaterial({
      vertexShader: BUBBLE_VERT,
      fragmentShader: BUBBLE_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: {
        uTime: { value: 0 },
        uFilm: {
          value: [
            emberColor(0.2, 0.03, 0.12),
            emberColor(0.55, -0.02, 0.14),
            emberColor(0.95, 0.01, 0.1),
            emberColor(0.4, 0.04, 0.12),
          ],
        },
        uSpec: { value: emberColor(1, 0, 0.35) },
        uFilmGain: { value: FILM_GAIN },
        uSpecGain: { value: SPEC_GAIN },
      },
    });

    const geo = new THREE.SphereGeometry(1, 40, 28);
    const st = new Float32Array(COUNT * 3);
    for (let i = 0; i < COUNT; i++) st[i * 3] = bubbles[i * STRIDE + 6];
    state = new THREE.InstancedBufferAttribute(st, 3);
    state.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aState', state);

    mesh = new THREE.InstancedMesh(geo, filmMat, COUNT);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    root.add(mesh);
  },

  update(t) {
    filmMat.uniforms.uTime.value = t;
    const st = state.array as Float32Array;

    for (let i = 0; i < COUNT; i++) {
      const o = i * STRIDE;
      const x0 = bubbles[o];
      const z = bubbles[o + 1];
      const r = bubbles[o + 2];
      const speed = bubbles[o + 3];
      const popY = bubbles[o + 4];
      const phase = bubbles[o + 6];
      const sw = bubbles[o + 7];

      const cycle = cycleOf(i);
      const rise = (popY - BOTTOM) / speed;
      const age = (((t + phase * cycle) % cycle) + cycle) % cycle;

      let pop = 0;
      let scale = r;
      if (age > rise + POP_DUR) {
        scale = 0; // 休み。次に現れるまで見えない
        pop = 1;
      } else if (age > rise) {
        pop = (age - rise) / POP_DUR;
        scale = r * (1 + POP_GROW * pop);
      }

      const a = Math.min(age, rise);
      const y = BOTTOM + a * speed;
      // 小さい玉ほど風に振られやすい
      const swayAmp = SWAY * (1.25 - 0.5 * (r - R_MIN) / (R_MAX - R_MIN));
      const x = x0 + WIND * a + swayAmp * Math.sin(a * sw + phase * 20) - WIND * rise * 0.5;
      const zz = z + 0.5 * Math.sin(a * sw * 0.7 + phase * 11);

      // 空気を受けて、ほんの少しだけ縦横にたわむ
      const wob = 0.045 * Math.sin(a * 5.3 + phase * 30);
      dummy.position.set(x, y, zz);
      dummy.rotation.set(0.3 * Math.sin(a * 0.4 + phase * 7), a * 0.25 + phase * 6, 0);
      dummy.scale.set(scale * (1 + wob), scale * (1 - wob), scale * (1 + wob * 0.5));
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);

      st[i * 3 + 1] = pop;
      const k = Math.min(1, Math.max(0, (y - FADE_FROM) / (FADE_TO - FADE_FROM)));
      st[i * 3 + 2] = 0.15 + 0.85 * k * k * (3 - 2 * k);
    }
    mesh.instanceMatrix.needsUpdate = true;
    state.needsUpdate = true;
  },

  sound(t, _dt, sfx) {
    for (let i = 0; i < COUNT; i += 3) {
      const o = i * STRIDE;
      const cycle = cycleOf(i);
      const rise = (bubbles[o + 4] - BOTTOM) / bubbles[o + 3];
      // 位相が整数をまたぐ瞬間 = 弾ける瞬間
      const ph = (t + bubbles[o + 6] * cycle - rise) / cycle;
      if (ticks[i](ph) > 0) {
        const r = bubbles[o + 2];
        const pan = Math.max(-1, Math.min(1, bubbles[o] / SPREAD_X));
        // 小さい玉ほど高い音
        const note = 14 + Math.round((1 - (r - R_MIN) / (R_MAX - R_MIN)) * 4) + (i % 2);
        sfx.pluck(tone(note), { gain: 0.1 + 0.08 * (r / R_MAX), decay: 0.5, pan: pan * 0.7 });
      }
    }
  },
};
