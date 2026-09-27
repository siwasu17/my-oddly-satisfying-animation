import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, tickers } from '../audio.ts';
import { SURFACE, ember, emberColor, drift } from '../palette.ts';

/*
 * Iai Cut — 時代劇の試し斬り。月夜の道場に巻藁が 5 本立ち、左から順に一閃ずつ
 * 袈裟斬りの光が走る。斬られた巻藁は一拍おいてから、斜めの切り口に沿って上半分が
 * じわりと滑り出し、落ちて床に転がる。気持ちよさの芯は「斬った直後は何も起きず、
 * 遅れて切り口がずれ始める」間と、5 本が同じ所作で揃っていく連なり。
 * 10 秒で一巡し、転がった藁と切り株は床へ沈み、新しい巻藁が床から立ち上がる。
 * カメラは水平に近い低めの位置から、切り口の滑りが横から見えるように置く。
 * 音は一閃ごとの風切りと高い弦、藁が床に落ちたときの鈍い一音。
 * スコープ外: 刀や人物のモデル、藁の破片・粒子、斬る角度の変化。
 */

// ---- 調整する数値 -----------------------------------------------------------
const COUNT = 5;                 // 巻藁の本数
const SPACING = 3.3;             // 巻藁の間隔
const R = 0.6;                   // 巻藁の半径（ずんぐりした束）
const H = 4.2;                   // 巻藁の高さ
const CUT_C = 2.9;               // 切り口（軸上）の高さ
const CUT_ANGLE = 0.56;          // 切り口の傾き（ラジアン）。右上から左下への袈裟斬り
const BINDINGS = [0.7, 1.9, 3.75]; // 藁を縛る紐の高さ
const STRAW_N = 0.86;            // 藁の色（ember の n）
const STRAW_GRAIN = 0.16;        // 繊維の明暗の幅
const FACE_RINGS = 6;            // 切り口に見える巻きの輪の数

const PERIOD = 10;               // 一巡の秒数
const T_FIRST = 1.2;             // 最初の一閃
const T_STEP = 0.42;             // 一閃の間隔
const HOLD = 0.4;                // 斬ってから滑り始めるまでの間
const SLIDE_T = 1.1;             // 切り口を滑る時間
const SLIDE_DIST = 0.5;          // 滑る距離
const FALL_T = 0.6;              // 滑り落ちてから床に着くまで
const FALL_SHIFT = 0.7;          // 落ちるときに左へずれる量
const SINK_START = 7.2;          // 床へ沈み始める
const SINK_T = 0.9;
const RISE_START = 8.3;          // 新しい巻藁が立ち上がり始める
const RISE_STEP = 0.1;
const RISE_T = 0.9;
const SINK_DEPTH = H + 0.4;

const SLASH_LEN = 2.7;           // 剣閃の長さ
const SLASH_W = 0.07;            // 剣閃の太さ
const SLASH_GROW = 0.09;         // 剣閃が伸び切るまで
const SLASH_FADE = 0.4;          // 剣閃が消えるまで

const MOON_R = 2.0;
const MOON_N = 0.66;
const FLOOR_METAL = 0.35;        // 床の照り返し。上げるとリムライトが大きく滲む

const CAMERA_POS: [number, number, number] = [0, 3.3, 11.2];
const CAMERA_TARGET: [number, number, number] = [-0.7, 2.0, 0];
// ---------------------------------------------------------------------------

const K = Math.tan(CUT_ANGLE);
const DIR_X = -Math.cos(CUT_ANGLE);   // 切り口を下る向き（左下）
const DIR_Y = -Math.sin(CUT_ANGLE);

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (x: number): number => x * x * (3 - 2 * x);
const cutTime = (i: number): number => T_FIRST + T_STEP * i;
const landTime = (i: number): number => cutTime(i) + HOLD + SLIDE_T + FALL_T;

/** 座標から決まる 0..1 の固定の揺らぎ。藁の繊維のざらつきに使う */
function grain(a: number, b: number): number {
  const n = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

/**
 * 巻藁の片側を作る。側面は細かい繊維に見えるよう頂点ごとに明暗を散らす。
 * 下半分は上端を、上半分は下端を切り口の面（y = CUT_C + K x）へ寄せる。
 */
function strawPiece(upper: boolean): THREE.BufferGeometry {
  const geo = new THREE.CylinderGeometry(R, R, H, 96, 16);
  geo.translate(0, H / 2, 0);
  const pos = geo.getAttribute('position');
  const uv = geo.getAttribute('uv');
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();

  for (let v = 0; v < pos.count; v++) {
    const x = pos.getX(v);
    const frac = pos.getY(v) / H;
    const cut = CUT_C + K * x;
    pos.setY(v, upper ? cut + frac * (H - cut) : frac * cut);

    const g = grain(uv.getX(v) * 96, frac * 16 + (upper ? 7 : 0));
    ember(c, STRAW_N + (g - 0.5) * STRAW_GRAIN, -0.01);
    colors[v * 3] = c.r;
    colors[v * 3 + 1] = c.g;
    colors[v * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  if (upper) geo.translate(0, -CUT_C, 0);   // 上半分の原点を切り口の中心へ
  geo.computeVertexNormals();
  return geo;
}

/**
 * 切り口の面。巻いた畳表の断面に見えるよう、同心の輪で明暗をつける。
 * 切り口の中心が原点。上半分の面は下を向く。
 */
function cutFace(upper: boolean): THREE.BufferGeometry {
  const geo = new THREE.RingGeometry(0, R * 0.995, 72, 14);
  geo.rotateX(upper ? Math.PI / 2 : -Math.PI / 2);
  const pos = geo.getAttribute('position');
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let v = 0; v < pos.count; v++) {
    const x = pos.getX(v);
    const z = pos.getZ(v);
    pos.setY(v, K * x + (upper ? -0.006 : 0.006));
    const r = Math.hypot(x, z) / R;
    const ring = 0.5 + 0.5 * Math.sin(r * Math.PI * 2 * FACE_RINGS);
    ember(c, 0.72 + ring * 0.14 + (grain(x * 40, z * 40) - 0.5) * 0.06, 0, 0.02);
    colors[v * 3] = c.r;
    colors[v * 3 + 1] = c.g;
    colors[v * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  return geo;
}

interface Stalk {
  group: THREE.Group;     // 沈む・立ち上がる
  top: THREE.Group;       // 切り口の中心が原点
  slash: THREE.Mesh;
  slashMat: THREE.MeshBasicMaterial;
  yaw: number;            // 転がったときの向きのばらつき
}

let stalks: Stalk[] = [];
let cutTicks = tickers(COUNT);
let landTicks = tickers(COUNT);
const moonColor = new THREE.Color();
let moonMat: THREE.MeshBasicMaterial;

function stalkX(i: number): number {
  return (i - (COUNT - 1) / 2) * SPACING;
}

export const iaiCut: SceneModule = {
  name: 'Iai Cut',
  desc: '月夜の巻藁に一閃ずつ光が走り、一拍おいて切り口がずれ、上半分が滑り落ちる。',
  camera: { pos: CAMERA_POS, target: CAMERA_TARGET },

  build(root) {
    cutTicks = tickers(COUNT);
    landTicks = tickers(COUNT);
    stalks = [];

    let s = 0.731;
    const rnd = (): number => (s = (s * 9301 + 0.49297) % 1);

    // 床（道場の板の間）
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(18, 96),
      new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.6, metalness: FLOOR_METAL }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.01;
    root.add(floor);

    // 月
    moonMat = new THREE.MeshBasicMaterial({ color: emberColor(0.8), fog: false });
    const moon = new THREE.Mesh(new THREE.CircleGeometry(MOON_R, 64), moonMat);
    moon.position.set(-7, 7.6, -30);
    root.add(moon);

    const strawMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 });
    const bindMat = new THREE.MeshStandardMaterial({ color: emberColor(0.12), roughness: 0.7 });
    const bindGeo = new THREE.TorusGeometry(R + 0.01, 0.035, 8, 48);
    bindGeo.rotateX(Math.PI / 2);
    const lower = strawPiece(false);
    const upper = strawPiece(true);
    const lowerFace = cutFace(false);
    const upperFace = cutFace(true);
    const slashGeo = new THREE.PlaneGeometry(1, 1);
    slashGeo.translate(-0.5, 0, 0);   // 右端が原点。scale.x で左下へ伸びる

    for (let i = 0; i < COUNT; i++) {
      const group = new THREE.Group();
      group.position.x = stalkX(i);
      root.add(group);

      const bottom = new THREE.Mesh(lower, strawMat);
      group.add(bottom);
      bottom.add(new THREE.Mesh(lowerFace, strawMat).translateY(CUT_C));

      const top = new THREE.Group();
      top.rotation.order = 'YXZ';
      group.add(top);
      const topMesh = new THREE.Mesh(upper, strawMat);
      top.add(topMesh);
      top.add(new THREE.Mesh(upperFace, strawMat));

      for (const h of BINDINGS) {
        const ring = new THREE.Mesh(bindGeo, bindMat);
        if (h > CUT_C + R * K) {
          ring.position.y = h - CUT_C;
          top.add(ring);
        } else {
          ring.position.y = h;
          group.add(ring);
        }
      }

      const slashMat = new THREE.MeshBasicMaterial({
        color: emberColor(1, 0, 0.35),
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const slash = new THREE.Mesh(slashGeo, slashMat);
      slash.rotation.z = CUT_ANGLE;
      slash.visible = false;
      group.add(slash);

      stalks.push({ group, top, slash, slashMat, yaw: (rnd() - 0.5) * 0.5 });
    }
  },

  update(t) {
    const u = t % PERIOD;
    ember(moonColor, MOON_N, drift(t) * 0.5);
    moonMat.color.copy(moonColor);

    for (let i = 0; i < COUNT; i++) {
      const st = stalks[i];
      const tau = u - cutTime(i);

      // ---- 沈む・立ち上がる ----
      let off = 0;
      let fresh = false;   // 立ち上がる新しい巻藁（まだ斬られていない）
      if (u >= RISE_START) {
        const r = clamp01((u - RISE_START - RISE_STEP * i) / RISE_T);
        off = -SINK_DEPTH * (1 - smooth(r));
        fresh = true;
      } else if (u >= SINK_START) {
        const k = clamp01((u - SINK_START) / SINK_T);
        off = -SINK_DEPTH * k * k;
      }
      st.group.position.y = off;

      // ---- 上半分の姿勢 ----
      const top = st.top;
      if (fresh || tau < HOLD) {
        top.position.set(0, CUT_C, 0);
        top.rotation.set(0, 0, 0);
      } else if (tau < HOLD + SLIDE_T) {
        const sg = (tau - HOLD) / SLIDE_T;
        const d = SLIDE_DIST * sg * sg;   // じわりと動き出して加速する
        top.position.set(DIR_X * d, CUT_C + DIR_Y * d, 0);
        top.rotation.set(0, 0, 0);
      } else {
        const x0 = DIR_X * SLIDE_DIST;
        const y0 = CUT_C + DIR_Y * SLIDE_DIST;
        const x1 = x0 - FALL_SHIFT;
        const y1 = R;
        const fT = tau - HOLD - SLIDE_T;
        const f = clamp01(fT / FALL_T);
        const g = f * f;
        let y = y0 + (y1 - y0) * g;
        // 着地後の小さな跳ね
        const after = fT - FALL_T;
        if (after > 0 && after < 0.45) {
          const b = after / 0.45;
          y += 0.1 * Math.abs(Math.sin(b * Math.PI * 2)) * (1 - b);
        }
        top.position.set(x0 + (x1 - x0) * f, y, 0);
        top.rotation.set(0, st.yaw * f, (Math.PI / 2) * g);
      }

      // ---- 剣閃 ----
      if (!fresh && tau >= 0 && tau < SLASH_GROW + SLASH_FADE) {
        const grow = clamp01(tau / SLASH_GROW);
        const fade = 1 - clamp01((tau - SLASH_GROW) / SLASH_FADE);
        st.slash.visible = true;
        st.slash.position.set(
          (-DIR_X * SLASH_LEN) / 2,
          CUT_C + (-DIR_Y * SLASH_LEN) / 2,
          R + 0.12,
        );
        st.slash.scale.set(SLASH_LEN * smooth(grow), SLASH_W * (0.4 + 0.6 * fade), 1);
        st.slashMat.opacity = fade * fade;
      } else {
        st.slash.visible = false;
      }
    }
  },

  sound(t, _dt, sfx) {
    for (let i = 0; i < COUNT; i++) {
      const pan = stalkX(i) / (SPACING * COUNT * 0.6);
      for (let k = cutTicks[i]((t - cutTime(i)) / PERIOD); k > 0; k--) {
        sfx.air({ gain: 0.22, decay: 0.28, freq: 2400, q: 2.2, pan });
        sfx.pluck(tone(12 + [0, 2, 4, 2, 5][i]), { gain: 0.16, decay: 1.4, pan });
      }
      for (let k = landTicks[i]((t - landTime(i)) / PERIOD); k > 0; k--) {
        sfx.drop(tone(2 + (i % 3)), { gain: 0.34, decay: 0.35, pan: pan - 0.1 });
      }
    }
  },
};
