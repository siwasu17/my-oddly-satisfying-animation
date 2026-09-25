import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, ticker } from '../audio.ts';
import { SURFACE, ember, emberColor, drift } from '../palette.ts';

/**
 * 何が動くか: 鏡の台の上で、分厚い金属の円盤が縁で立ったまま首を振って転がる。
 *   傾きがだんだん寝ていくのに、首振りはかえって速くなっていき、最後は細かく震えて
 *   唐突にぴたりと平らに止まる。少し休むと見えない指がすくい上げ、また首を振り始める。
 * 気持ちよさの芯: 勢いが失われていくのに首振りだけは加速していく逆説と、最後の一瞬の静けさ。
 *   上面の小さな刻みはほとんど回らない（転がる円盤そのものはゆっくりしか自転しない）ので、
 *   速く回っているのは「傾きの向き」だけだと分かる。
 * ループの周期: 16 秒（首振り 12 秒 → 平らに止まって 1.6 秒 → すくい上げ 2.4 秒）。
 * カメラ: 少し見下ろす斜めから。傾いた姿勢と、ガラスの台に映る逆さの像が両方見える角度。
 * 音: 首振り 1 周ごとに pluck。間隔が詰まるにつれ音程も上がり、止まった瞬間に途切れる。
 *   回っている間は低い drone、止まったら air を一息。
 * スコープ外: 実際の摩擦・空気抵抗の物理、止まる瞬間の跳ね返り。
 *
 * 傾き θ は残り時間 u の平方根で寝かせ、首振りの速さは 1/√sinθ で上げる（実物と同じ向きの関係）。
 * 首振りの角度はその積分なので、build で 1 度だけ表にしておき、update は t から引くだけにする。
 */

// ---- 調整する数値 ----
const A = 3.0; // 円盤の半径
const THICK = 0.55; // 円盤の厚み
const TILT0 = 0.62; // 首振りを始めるときの傾き（ラジアン）
const TILT_MIN = TILT0 / 49; // 首振りの最後の傾き。ここで首振りの速さが 7 倍に達する
const OMEGA0 = 2.2; // 首振りを始めるときの速さ（ラジアン毎秒）
const SPIN = 12.0; // 首振りの長さ
const REST = 1.6; // 平らに止まって見せる長さ
const LIFT = 2.4; // すくい上げて首振りの速さに戻すまで
const PERIOD = SPIN + REST + LIFT;
const SETTLE = 0.09; // 最後の傾きから平らになるまで（ほぼ一瞬）
const TABLE = 4096; // 首振り角の表の刻み数
const PLATE_R = 9; // 台の半径
const PLATE_OPACITY = 0.8; // 台のガラスの濃さ。下げるほど鏡像がくっきり映る
const CONTACT_GLOW = 0.5; // 首振りが最も速いときの接点の灯り
const BODY_TINT = 0.78; // 円盤の地の色（0 = 暗い薔薇 / 1 = 明るい琥珀）
const HEAT_TINT = 0.28; // 首振りが速くなるほど地の色を持ち上げる幅
const HEAT_GLOW = 0.12; // 同、明度への上乗せ（最後だけブルームに掛かる）
const FLASH = 0.16; // 止まった瞬間に刻みが灯る量
const FLASH_FADE = 0.9; // その灯りが引くまで

// 首振り角 φ と円盤の自転角 ψ の表（SPIN 秒を TABLE 等分）。build で作る。
const phiTable = new Float32Array(TABLE + 1);
const psiTable = new Float32Array(TABLE + 1);
let PHI_SPIN = 0; // 首振り 12 秒ぶんの φ
const PHI_LIFT = (OMEGA0 * LIFT) / 3; // すくい上げの間に進む φ（速さを 0 から 2 乗で戻す）
let PHI_CYCLE = 0;
const OMEGA_MAX = OMEGA0 * Math.sqrt(Math.sin(TILT0) / Math.sin(TILT_MIN));

let pivot: THREE.Group; // 首振り（鉛直軸まわり）
let tilt: THREE.Group; // 傾き
let disk: THREE.Group; // 自転
let mirrorPivot: THREE.Group; // 台に映る鏡像（pivot の複製）
let bodyMat: THREE.MeshStandardMaterial;
let markMat: THREE.MeshStandardMaterial;
let contact: THREE.Mesh; // 接点のほのかな灯り

let tick = ticker();
let stopTick = ticker();
let liftTick = ticker();
let step = 0;

const color = new THREE.Color();

/** 首振り区間の中の τ（0..SPIN）における傾き */
function tiltAt(tau: number): number {
  const u = Math.max(0, 1 - tau / SPIN);
  return Math.max(TILT_MIN, TILT0 * Math.sqrt(u));
}

function omegaAt(th: number): number {
  return OMEGA0 * Math.sqrt(Math.sin(TILT0) / Math.sin(th));
}

function buildTables(): void {
  // 台形則で積分する。φ̇ = Ω(θ)、ψ̇ = Ω(θ)(1 − cosθ)（滑らずに転がる円盤の自転）
  const dt = SPIN / TABLE;
  let phi = 0;
  let psi = 0;
  let prevW = omegaAt(tiltAt(0));
  let prevS = prevW * (1 - Math.cos(tiltAt(0)));
  phiTable[0] = 0;
  psiTable[0] = 0;
  for (let i = 1; i <= TABLE; i++) {
    const th = tiltAt(i * dt);
    const w = omegaAt(th);
    const s = w * (1 - Math.cos(th));
    phi += 0.5 * (prevW + w) * dt;
    psi += 0.5 * (prevS + s) * dt;
    phiTable[i] = phi;
    psiTable[i] = psi;
    prevW = w;
    prevS = s;
  }
  PHI_SPIN = phi;
  PHI_CYCLE = PHI_SPIN + PHI_LIFT;
}

function lookup(table: Float32Array, tau: number): number {
  const x = Math.min(TABLE, Math.max(0, (tau / SPIN) * TABLE));
  const i = Math.min(TABLE - 1, Math.floor(x));
  const f = x - i;
  return table[i] + (table[i + 1] - table[i]) * f;
}

const smooth = (x: number): number => {
  const c = Math.min(1, Math.max(0, x));
  return c * c * (3 - 2 * c);
};

interface DiskState {
  theta: number; // 傾き
  phi: number; // 首振り角（周をまたいで連続）
  psi: number; // 自転角（同）
  omega: number; // 首振りの速さ
  sinceStop: number; // 止まってからの秒数（首振り中は -1）
}
const st: DiskState = { theta: 0, phi: 0, psi: 0, omega: 0, sinceStop: -1 };

function stateAt(t: number): DiskState {
  const cycle = Math.floor(t / PERIOD);
  const c = t - cycle * PERIOD;
  const psiSpin = psiTable[TABLE];
  let phi: number;
  let psi: number;
  if (c < SPIN) {
    st.theta = tiltAt(c);
    st.omega = omegaAt(st.theta);
    phi = lookup(phiTable, c);
    psi = lookup(psiTable, c);
    st.sinceStop = -1;
  } else if (c < SPIN + REST) {
    const s = c - SPIN;
    st.theta = TILT_MIN * (1 - smooth(s / SETTLE));
    st.omega = 0;
    phi = PHI_SPIN;
    psi = psiSpin;
    st.sinceStop = s;
  } else {
    // すくい上げ: 傾きを戻しながら、首振りの速さを 0 → OMEGA0 へ 2 乗で上げる
    const s = (c - SPIN - REST) / LIFT;
    st.theta = TILT0 * smooth(s);
    st.omega = OMEGA0 * s * s;
    phi = PHI_SPIN + PHI_LIFT * s * s * s;
    psi = psiSpin;
    st.sinceStop = c - SPIN;
  }
  st.phi = cycle * PHI_CYCLE + phi;
  st.psi = cycle * psiSpin + psi;
  return st;
}

export const eulerDisk: SceneModule = {
  name: 'Euler Disk',
  desc: '傾きが寝ていくほど首振りが速くなり、震えて唐突に止まる金属の円盤。',
  camera: { pos: [0, 5.2, 10.5], target: [0, 1.3, 0] },
  environment: 1.6,
  shadows: true,

  build(root) {
    tick = ticker();
    stopTick = ticker();
    liftTick = ticker();
    step = 0;
    buildTables();

    // 台は暗いガラス。下に円盤の鏡像を置き、半透明の面越しに透かして鏡に見せる
    // （Reflector を使わずに済ませる。映る像は円盤 1 枚だけで足りる）
    const plate = new THREE.Mesh(
      new THREE.CylinderGeometry(PLATE_R, PLATE_R, 0.3, 128),
      new THREE.MeshStandardMaterial({
        color: SURFACE,
        roughness: 0.08,
        metalness: 0.3,
        transparent: true,
        opacity: PLATE_OPACITY,
      }),
    );
    plate.position.y = -0.15;
    root.add(plate);

    // 接点の灯り。台の面すれすれに置く
    contact = new THREE.Mesh(
      new THREE.CircleGeometry(0.16, 32),
      new THREE.MeshBasicMaterial({ color: emberColor(0.85), transparent: true, opacity: 0, depthWrite: false }),
    );
    contact.rotation.x = -Math.PI / 2;
    contact.position.y = 0.005;
    root.add(contact);

    pivot = new THREE.Group();
    tilt = new THREE.Group();
    disk = new THREE.Group();
    pivot.add(tilt);
    tilt.add(disk);
    root.add(pivot);

    bodyMat = new THREE.MeshStandardMaterial({ roughness: 0.3, metalness: 0.7 });
    markMat = new THREE.MeshStandardMaterial({ roughness: 0.2, metalness: 0.8 });

    const body = new THREE.Mesh(new THREE.CylinderGeometry(A, A, THICK, 96), bodyMat);
    disk.add(body);

    // 縁の面取り。輪郭を光で縁取って、円盤の厚みを読ませる
    const bevel = new THREE.Mesh(new THREE.TorusGeometry(A - 0.02, 0.05, 8, 128), markMat);
    bevel.rotation.x = Math.PI / 2;
    bevel.position.y = THICK / 2;
    disk.add(bevel);

    // 上面の目印: 縁寄りに小さな刻みが 1 つだけ。首振りが速くても、これはほとんど回らない
    const notch = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.03, 24), markMat);
    notch.position.set(A * 0.72, THICK / 2 + 0.01, 0);
    disk.add(notch);

    // 鏡像。形と材質はそのまま共有し、y を反転した親の下に置く
    const mirror = new THREE.Group();
    mirror.scale.y = -1;
    mirrorPivot = pivot.clone();
    mirror.add(mirrorPivot);
    root.add(mirror);
  },

  update(t) {
    const s = stateAt(t);
    const th = s.theta;

    // 円盤の最下点（縁の角）がちょうど台に触れる高さ
    pivot.position.y = A * Math.sin(th) + (THICK / 2) * Math.cos(th);
    pivot.rotation.y = s.phi;
    tilt.rotation.z = -th; // 局所 +x 側の縁が下がる
    disk.rotation.y = -s.psi;
    mirrorPivot.position.copy(pivot.position);
    mirrorPivot.rotation.copy(pivot.rotation);
    mirrorPivot.children[0].rotation.copy(tilt.rotation);
    mirrorPivot.children[0].children[0].rotation.copy(disk.rotation);

    // 首振りが速いほど熱を帯びたように色を上げる（最後の 1 秒だけ効く）
    const heat = s.omega > 0 ? Math.min(1, (s.omega - OMEGA0) / (OMEGA_MAX - OMEGA0)) : 0;
    const hue = drift(t);
    ember(color, BODY_TINT + HEAT_TINT * heat, hue, HEAT_GLOW * heat * heat);
    bodyMat.color.copy(color);

    const flash = s.sinceStop >= 0 ? FLASH * Math.exp(-s.sinceStop / (FLASH_FADE / 3)) : 0;
    ember(color, 0.72 + 0.2 * heat, hue, 0.02 + flash + 0.08 * heat * heat);
    markMat.color.copy(color);

    // 接点は台の上で半径 A cosθ の円を描く
    const r = A * Math.cos(th);
    contact.position.x = Math.cos(s.phi) * r;
    contact.position.z = -Math.sin(s.phi) * r;
    (contact.material as THREE.MeshBasicMaterial).opacity = s.omega > 0 ? CONTACT_GLOW * heat * heat : 0;
  },

  sound(t, _dt, sfx) {
    const s = stateAt(t);
    const spinning = s.sinceStop < 0;

    // 首振り 1 周ごと。間隔が詰まるほど音程を上げる
    for (let k = tick(s.phi / (Math.PI * 2)); k > 0; k--) {
      if (!spinning) continue;
      step++;
      const up = Math.log2(Math.max(1, s.omega / OMEGA0));
      sfx.pluck(tone(4 + Math.round(up * 3)), {
        gain: 0.22 - 0.06 * Math.min(1, up / 3),
        decay: 1.4,
        pan: Math.sin(s.phi) * 0.4,
      });
    }

    // 止まった瞬間と、すくい上げの始まり
    if (stopTick((t - SPIN) / PERIOD) > 0) sfx.air({ gain: 0.22, decay: 1.6, freq: 520, q: 1.2 });
    if (liftTick((t - SPIN - REST) / PERIOD) > 0) sfx.pluck(tone(2), { gain: 0.18, decay: 2.4 });

    sfx.drone(spinning ? tone(0) : null, spinning ? 0.05 + 0.05 * Math.min(1, (s.omega - OMEGA0) / OMEGA0) : 0);
  },
};
