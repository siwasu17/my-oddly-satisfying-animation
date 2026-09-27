import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, tickers } from '../audio.ts';
import { SURFACE, ember, emberColor, drift } from '../palette.ts';

/**
 * Silk Drape — 絹の布が珠にふわりと被さり、つまみ上げられて、また舞い落ちる。
 *
 * 何が動くか: 丸い絹布 1 枚。床に置いた小さな珠の真上から平らなまま舞い降り、
 *   珠の頂に触れたところから包み込むように垂れて、四隅が床に溜まる。しばらく休んだあと
 *   中心をつままれて持ち上がり、ハンカチのように垂れ下がって珠を見せ、
 *   ぱっと平らに開いて、また落ちてくる。
 * 気持ちよさの芯: 平らな布に、放射状のひだが「余った布の分だけ」寄っていくところ。
 *   ひだの深さは、布の中心からの長さと実際の半径の差（余り）から出している。
 * ループの周期: 20 秒（落ちる → 被さる → 休む → つまみ上げる → 開く → 浮かぶ）。
 * カメラ: 斜め上から見下ろす。珠と、つまみ上げた布の高さが両方入る画角。
 * 音: 落ち始めと持ち上げに風（air）、珠に触れる瞬間と四隅が床に着く瞬間に低い弦。
 * スコープ外: 本物の布シミュレーション（布は中心から放射状の 1 本の断面で近似し、
 *   毎フレーム t からその断面を積分し直している）。風で横に流れる動き。
 */

// ---- 調整する数値 ----
/** 珠の半径 */
const BALL_R = 1.5;
/** 布と珠の隙間（めり込み防止） */
const GAP = 0.04;
/** 丸い布の半径 */
const CLOTH_R = 5.2;
/** 布の分割数（同心円の数と、一周の分割数） */
const RINGS = 90;
const SPOKES = 220;
/** つまみ上げたときの中心の高さ */
const TOP = 8.8;
/** 珠から離れる角度（rad）。これより先は接線方向にまっすぐ垂れる */
const WRAP = 1.42;
/** 垂れ下がったときの傾き（rad）。π/2 で真下 */
const HANG = 1.36;
/** ひだの数（一周あたり） */
const FOLDS = 9;
/** ひだの深さの係数と上限 */
const FOLD_K = 0.36;
const FOLD_MAX = 0.6;
/** 落ちているあいだ、縁が空気に押されて反り上がる量（rad） */
const CURL = 0.5;
/** 平らなときのはためき */
const FLUTTER = 0.3;
/** 平らなときに縁を回る、ゆるいうねり */
const EDGE_WAVE = 0.55;
/** 持ち上げ・開きで、外周が中心より遅れて追いつく割合 */
const LAG = 0.4;

/** 1 周の長さと、各段の開始時刻（秒） */
const PERIOD = 20;
const T_DRAPE = 3.2; // 珠の頂に触れる
const T_REST = 6.8; // 垂れ終わる
const T_LIFT = 12; // つまみ上げ始める
const T_OPEN = 16.4; // 開き始める
const T_HOVER = 18.2; // 開ききって浮かぶ

/** 断面のサンプル数 */
const SAMPLES = 320;

// ---- 導出値 ----
const S_MAX = CLOTH_R;
const DS = S_MAX / (SAMPLES - 1);
const REST_H = 2 * BALL_R + GAP; // 珠に載っているときの中心の高さ
const WRAP_R = BALL_R + GAP;
const VERTS = (RINGS + 1) * (SPOKES + 1);

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (x: number): number => {
  const c = clamp01(x);
  return c * c * (3 - 2 * c);
};
const easeOut = (x: number): number => 1 - Math.pow(1 - clamp01(x), 3);

/** 断面: 中心からの長さ s ごとの [半径, 高さ, 傾き] */
const profR = new Float32Array(SAMPLES);
const profY = new Float32Array(SAMPLES);
const profA = new Float32Array(SAMPLES);
/** いまの断面の傾き ψ(s)。0 = 水平、正で下向き */
const psi = new Float32Array(SAMPLES);

/** 頂点ごとの [s, cosθ, sinθ, ひだの位相] */
const vinfo = new Float32Array(VERTS * 4);

const color = new THREE.Color();
let geo: THREE.BufferGeometry;
let pos: THREE.BufferAttribute;
let col: THREE.BufferAttribute;

/** 1 周の中で鳴らす瞬間ごとの ticker。[落ち始め, 珠に触れる, 四隅が着く, 持ち上げ, 開く] */
let ticks = tickers(5);

/** 断面の傾き ψ(s) をいまの段から決め、中心から積分して断面を作る */
function buildProfile(tau: number, t: number): number {
  let hc = TOP;

  // 段ごとの「傾きの形」と中心の高さ
  if (tau < T_DRAPE) {
    // 落ちる: 平らなまま、はじめはゆっくり、だんだん速く
    const p = tau / T_DRAPE;
    hc = TOP - (TOP - REST_H) * Math.pow(p, 1.7);
    psi.fill(0);
  } else if (tau < T_LIFT) {
    // 被さる: 珠に沿って巻きつく範囲が広がり、その先は接線方向にまっすぐ垂れる
    hc = REST_H;
    const phi = WRAP * easeOut((tau - T_DRAPE) / (T_REST - T_DRAPE));
    for (let i = 0; i < SAMPLES; i++) psi[i] = Math.min((i * DS) / WRAP_R, phi);
  } else if (tau < T_OPEN) {
    // つまみ上げる: 中心が先に上がり、外周は遅れて垂れ下がる形へ移る
    const p = (tau - T_LIFT) / (T_OPEN - T_LIFT);
    hc = REST_H + (TOP - REST_H) * smooth(p);
    for (let i = 0; i < SAMPLES; i++) {
      const s = i * DS;
      const w = smooth((p - (LAG * s) / S_MAX) / (1 - LAG));
      const drape = Math.min(s / WRAP_R, WRAP);
      psi[i] = drape + (HANG - drape) * w;
    }
  } else {
    // 開く: 内側から順に水平へ跳ね上がり、縁が一瞬だけ反り返る
    const p = (tau - T_OPEN) / (T_HOVER - T_OPEN);
    for (let i = 0; i < SAMPLES; i++) {
      const sn = (i * DS) / S_MAX;
      const w = smooth((p - LAG * sn) / (1 - LAG));
      psi[i] = HANG * (1 - w) - 0.35 * sn * Math.sin(Math.PI * w);
    }
  }

  // 縁の反り（浮かんでいる間から落ちきるまで）と、平らなときの波打ち
  let curl = 0;
  if (tau >= T_HOVER) curl = smooth((tau - T_HOVER) / (PERIOD - T_HOVER));
  else if (tau < T_DRAPE) curl = 1;
  else if (tau < T_REST) curl = 1 - smooth((tau - T_DRAPE) / 1.2);
  if (curl > 0) {
    for (let i = 0; i < SAMPLES; i++) {
      const sn = (i * DS) / S_MAX;
      psi[i] -= curl * (CURL * sn * sn + 0.08 * sn * Math.sin(sn * 7 - t * 2.3));
    }
  }

  // 中心から積分する。床に着いたら水平に、珠の中へ入ったら表面へ押し出す
  let r = 0;
  let y = hc;
  for (let i = 0; i < SAMPLES; i++) {
    profR[i] = r;
    profY[i] = y;
    let a = psi[i]!;
    if (y <= 0.02 && a > 0) a = 0;
    profA[i] = a;
    r += Math.cos(a) * DS;
    y -= Math.sin(a) * DS;
    if (y < 0.02) y = 0.02;
    const dy = y - BALL_R;
    const d = Math.hypot(r, dy);
    if (d < WRAP_R) {
      const k = WRAP_R / Math.max(d, 1e-4);
      r *= k;
      y = BALL_R + dy * k;
    }
    if (r < 0) r = 0;
  }
  return curl;
}

/** 珠に被せた絹。平らに落ち、珠に沿ってひだを寄せ、つまみ上げられてまた開く。 */
export const silkDrape: SceneModule = {
  name: 'Silk Drape',
  desc: '絹の布が珠にふわりと被さってひだを寄せ、つまみ上げられては、また開いて舞い落ちる。',
  camera: { pos: [0, 7.6, 14.2], target: [0, 3.1, 0] },
  shadows: true,

  build(root) {
    ticks = tickers(5);

    // 布は同心円 × 放射線の格子。形は毎フレーム断面から作り直すので、ここでは頂点の素性だけ控える
    const idx: number[] = [];
    for (let ri = 0; ri < RINGS; ri++) {
      for (let si = 0; si < SPOKES; si++) {
        const a0 = ri * (SPOKES + 1) + si;
        const b0 = a0 + SPOKES + 1;
        idx.push(a0, b0, a0 + 1, a0 + 1, b0, b0 + 1);
      }
    }
    geo = new THREE.BufferGeometry();
    pos = new THREE.BufferAttribute(new Float32Array(VERTS * 3), 3);
    pos.setUsage(THREE.DynamicDrawUsage);
    col = new THREE.BufferAttribute(new Float32Array(VERTS * 3), 3);
    col.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', pos);
    geo.setAttribute('color', col);
    geo.setIndex(idx);

    for (let ri = 0; ri <= RINGS; ri++) {
      for (let si = 0; si <= SPOKES; si++) {
        const i = ri * (SPOKES + 1) + si;
        const th = (si / SPOKES) * Math.PI * 2;
        vinfo[i * 4] = (ri / RINGS) * CLOTH_R;
        vinfo[i * 4 + 1] = Math.cos(th);
        vinfo[i * 4 + 2] = Math.sin(th);
        // ひだが放射状に揃いすぎないよう、角度に少しゆらぎを混ぜる
        vinfo[i * 4 + 3] = FOLDS * th + 0.7 * Math.sin(2 * th + 1.3) + 0.45 * Math.sin(5 * th + 0.4);
      }
    }

    const silk = new THREE.Mesh(
      geo,
      new THREE.MeshPhysicalMaterial({
        vertexColors: true,
        roughness: 0.26,
        metalness: 0.12,
        sheen: 1,
        sheenRoughness: 0.32,
        sheenColor: emberColor(0.92),
        side: THREE.DoubleSide,
      }),
    );
    silk.castShadow = true;
    silk.receiveShadow = true;
    root.add(silk);

    const ball = new THREE.Mesh(
      new THREE.SphereGeometry(BALL_R, 48, 32),
      new THREE.MeshStandardMaterial({ color: emberColor(0.4), roughness: 0.22, metalness: 0.55 }),
    );
    ball.position.y = BALL_R;
    root.add(ball);

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(9, 96),
      new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.45, metalness: 0.6 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.02;
    root.add(floor);
  },

  update(t) {
    const tau = ((t % PERIOD) + PERIOD) % PERIOD;
    const curl = buildProfile(tau, t);
    const hue = drift(t);
    // 平らなときだけ、布全体を面ではためかせる
    const flat = curl;
    const foldDrift = t * 0.12;

    const arr = pos.array as Float32Array;
    const carr = col.array as Float32Array;
    const cx = 0;
    const cy = BALL_R;

    for (let i = 0; i < VERTS; i++) {
      const s = vinfo[i * 4]!;
      const c = vinfo[i * 4 + 1]!;
      const sv = vinfo[i * 4 + 2]!;

      // 断面を線形補間で引く
      const f = s / DS;
      const k = Math.min(SAMPLES - 2, Math.floor(f));
      const w = f - k;
      const r = profR[k]! + (profR[k + 1]! - profR[k]!) * w;
      let y = profY[k]! + (profY[k + 1]! - profY[k]!) * w;
      const a = profA[k]! + (profA[k + 1]! - profA[k]!) * w;

      // ひだ: 中心からの長さが実際の半径を上回った「余り」の分だけ、断面の法線方向に波打つ
      const excess = Math.max(0, s - r);
      const amp = Math.min(FOLD_MAX, FOLD_K * Math.sqrt(excess)) * smooth(s / 0.8);
      const wave = Math.sin(vinfo[i * 4 + 3]! + s * 0.35 + foldDrift);
      const disp = amp * wave;
      const nr = Math.sin(a);
      const ny = Math.cos(a);

      let x = c * (r + nr * disp);
      let z = sv * (r + nr * disp);
      y += ny * disp;

      // はためき（平らなときだけ）
      if (flat > 0) {
        const u = c * s;
        const v = sv * s;
        y +=
          flat *
          FLUTTER *
          (s / S_MAX) *
          Math.sin(u * 0.9 + t * 1.7) *
          Math.sin(v * 0.8 - t * 1.3 + 0.6);
        const e = s / S_MAX;
        y += flat * EDGE_WAVE * e * e * Math.sin(3 * Math.atan2(sv, c) + t * 1.1);
      }

      // 床と珠へのめり込みを戻す
      if (y < 0.02) y = 0.02;
      const dx = x - cx;
      const dy = y - cy;
      const d = Math.hypot(dx, dy, z);
      if (d < WRAP_R) {
        const kk = WRAP_R / Math.max(d, 1e-4);
        x = dx * kk;
        y = cy + dy * kk;
        z *= kk;
      }

      arr[i * 3] = x;
      arr[i * 3 + 1] = y;
      arr[i * 3 + 2] = z;

      // ひだの山を明るく、谷を暗くして絹の艶を強める
      ember(color, 0.54 + (amp > 0 ? 0.2 * wave * (amp / FOLD_MAX) : 0) + 0.06 * (s / S_MAX), hue);
      carr[i * 3] = color.r;
      carr[i * 3 + 1] = color.g;
      carr[i * 3 + 2] = color.b;
    }

    pos.needsUpdate = true;
    col.needsUpdate = true;
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
  },

  sound(t, _dt, sfx) {
    // 1 周の中の決まった時刻を、位相 (t - 時刻) / 周期 が整数をまたいだ回数で拾う
    const at = (i: number, sec: number): number => ticks[i]!((t - sec) / PERIOD);
    for (let n = at(0, 0.1); n > 0; n--) {
      sfx.air({ gain: 0.18, decay: 2.6, freq: 520, sweep: 0.6 });
    }
    for (let n = at(1, T_DRAPE); n > 0; n--) {
      sfx.pluck(tone(3), { gain: 0.3, decay: 2.8 });
    }
    for (let n = at(2, T_DRAPE + 1.7); n > 0; n--) {
      sfx.pluck(tone(5), { gain: 0.16, decay: 2.2, pan: -0.3 });
      sfx.pluck(tone(7), { gain: 0.12, decay: 2.2, pan: 0.3 });
    }
    for (let n = at(3, T_LIFT); n > 0; n--) {
      sfx.air({ gain: 0.16, decay: 3.2, freq: 380, sweep: 1.8 });
    }
    for (let n = at(4, T_OPEN + 0.5); n > 0; n--) {
      sfx.air({ gain: 0.2, decay: 0.9, freq: 900, sweep: 0.7 });
    }
  },
};
