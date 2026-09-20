import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, tickers } from '../audio.ts';
import { ember, emberColor, drift } from '../palette.ts';

/**
 * Solar System — 浅い斜め俯瞰で眺める太陽系。
 *
 * 何が動くか: 中心で脈打つ太陽と、それを囲む 5 つの惑星。惑星はそれぞれ傾いた軸で
 * 自転しながら楕円軌道を回り、衛星を従える。いちばん大きな惑星にはリングがある。
 * 気持ちよさの芯: 公転周期を整数比にしていないので、手前を横切る順番と間隔が毎周ずれる。
 * 揃いそうで揃わないまま、重たい球がゆっくり回り続ける。
 * ループの周期: 最外周が一巡して 20 秒。内側の惑星はその間に何周もする。
 * カメラ: 浅い斜め俯瞰。軌道は楕円に潰れ、手前と奥の惑星がすれ違って見える。
 * 音: 惑星が手前を通過した瞬間に pluck（外側ほど低い）。太陽は低い drone を敷く。
 * スコープ外: 実際の惑星色・個数・距離（暖色パレット縛りなので写実にはしない）、
 * テクスチャ、影、星空の背景。
 */

// ---- 調整する数値はここにまとめる -------------------------------------------

const CAM_POS: [number, number, number] = [3.9, 8.7, 24.4];
const CAM_TARGET: [number, number, number] = [0, -1.2, 0]; // 俯瞰だと軌道面が下寄りに写るので、少し下を見る

const SUN_R = 1.9; // 太陽の半径
const SUN_PULSE = 0.018; // 太陽がふくらむ幅（半径比）
const SUN_GLOW = 0.72; // 太陽の発光。上げすぎるとコアが白飛びして暖色が抜ける
const CORONA = 1.55; // コロナの殻の大きさ（太陽半径比）

const ORBIT_N = 5; // 惑星の数
const ORBIT_SEG = 128; // 軌道線の分割数
const ORBIT_LEVEL = 0.16; // 軌道線の明るさ（0..1）

/** 惑星ごとの仕様。a = 軌道長半径 / flat = 楕円の潰し / r = 球の半径 */
interface Planet {
  a: number;
  flat: number;
  r: number;
  period: number; // 公転（秒）。整数比を避ける
  spin: number; // 自転（秒）
  tilt: number; // 軌道面の傾き
  node: number; // 軌道の向き
  axis: number; // 自転軸の傾き
  phase: number; // 初期位相
  level: number; // 色（0 = 暗い薔薇 〜 1 = 明るい琥珀）
  note: number; // 手前を通ったときの音程
  moons: number;
  ring: boolean;
}

const PLANETS: Planet[] = [
  { a: 4.2, flat: 0.94, r: 0.42, period: 3.4, spin: 5.5, tilt: 0.07, node: 0.4, axis: 0.24, phase: 0.12, level: 0.58, note: 14, moons: 0, ring: false },
  { a: 6.1, flat: 0.9, r: 0.66, period: 5.9, spin: 8.3, tilt: -0.05, node: 2.1, axis: 0.42, phase: 0.64, level: 0.44, note: 11, moons: 1, ring: false },
  { a: 7.7, flat: 0.96, r: 0.5, period: 8.3, spin: 6.7, tilt: 0.1, node: 3.7, axis: 0.16, phase: 0.31, level: 0.66, note: 9, moons: 1, ring: false },
  { a: 11.2, flat: 0.88, r: 1.12, period: 13.7, spin: 11.2, tilt: -0.08, node: 5.2, axis: 0.3, phase: 0.83, level: 0.36, note: 5, moons: 2, ring: true },
  { a: 13.6, flat: 0.93, r: 0.78, period: 20, spin: 14.5, tilt: 0.06, node: 1.2, axis: 0.5, phase: 0.47, level: 0.52, note: 2, moons: 1, ring: false },
];

// ---- 状態（build で作り直す） -----------------------------------------------

const color = new THREE.Color();

let sun: THREE.Mesh;
let sunMat: THREE.MeshStandardMaterial;
let corona: THREE.Mesh;

const pivots: THREE.Object3D[] = []; // 惑星の位置（軌道ローカル）
const globes: THREE.Object3D[] = []; // 惑星の球（自転する）
const moonArms: THREE.Object3D[] = []; // 衛星を振り回す腕
const moonSpec: number[] = []; // 腕ごとの [周期, 位相]
const mats: THREE.MeshStandardMaterial[] = [];
const pans: number[] = []; // 惑星の左右位置（音の定位に使う）

let ticks: ((phase: number) => number)[] = [];

/** 固定シード。開き直しても同じ散らばりになる */
let seed = 0.731;
const rnd = (): number => (seed = (seed * 9301 + 0.49297) % 1);

/** 楕円軌道上の位置。位相が整数をまたぐ瞬間が手前（カメラ側）になるようずらしてある */
function orbitAt(p: Planet, phase: number, out: THREE.Vector3): void {
  const ang = (phase - 0.25) * Math.PI * 2;
  out.set(p.a * Math.cos(ang), 0, p.a * p.flat * Math.sin(ang));
}

export const solarSystem: SceneModule = {
  name: 'Solar System',
  desc: '惑星と衛星がすれ違いながら太陽をめぐる',
  camera: { pos: CAM_POS, target: CAM_TARGET },

  build(root) {
    seed = 0.731;
    pivots.length = 0;
    globes.length = 0;
    moonArms.length = 0;
    moonSpec.length = 0;
    mats.length = 0;
    pans.length = 0;
    ticks = tickers(ORBIT_N);

    // 太陽。この球だけは自分で光っているので、光源とコロナを持たせる
    sunMat = new THREE.MeshStandardMaterial({
      color: emberColor(0.86),
      emissive: emberColor(0.94),
      emissiveIntensity: SUN_GLOW,
      roughness: 0.6,
    });
    sun = new THREE.Mesh(new THREE.IcosahedronGeometry(SUN_R, 4), sunMat);
    root.add(sun);

    corona = new THREE.Mesh(
      new THREE.IcosahedronGeometry(SUN_R * CORONA, 3),
      new THREE.MeshBasicMaterial({
        color: emberColor(0.95, 0.02),
        transparent: true,
        opacity: 0.07,
        side: THREE.BackSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    root.add(corona);

    // 距離で減衰させない（decay 0）。明るさを揃えたまま、照らされる向きだけを作る
    const lamp = new THREE.PointLight(emberColor(1, 0, 0.1), 1.35, 0, 0);
    root.add(lamp);

    const pos = new THREE.Vector3();

    for (const p of PLANETS) {
      const orbit = new THREE.Object3D();
      orbit.rotation.order = 'YXZ';
      orbit.rotation.set(p.tilt, p.node, 0);
      root.add(orbit);

      // 軌道線。暗く置いて、惑星がどこを回っているかだけを示す
      const pts: number[] = [];
      for (let i = 0; i < ORBIT_SEG; i++) {
        orbitAt(p, i / ORBIT_SEG, pos);
        pts.push(pos.x, pos.y, pos.z);
      }
      const lineGeo = new THREE.BufferGeometry();
      lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      orbit.add(
        new THREE.LineLoop(
          lineGeo,
          new THREE.LineBasicMaterial({
            color: emberColor(ORBIT_LEVEL),
            transparent: true,
            opacity: 0.55,
          }),
        ),
      );

      const pivot = new THREE.Object3D();
      orbit.add(pivot);
      pivots.push(pivot);
      pans.push(0);

      const mat = new THREE.MeshStandardMaterial({
        color: emberColor(p.level),
        roughness: 0.62,
        metalness: 0.18,
        flatShading: true,
      });
      mats.push(mat);

      const globe = new THREE.Mesh(new THREE.IcosahedronGeometry(p.r, 2), mat);
      globe.rotation.order = 'ZYX';
      globe.rotation.z = p.axis;
      pivot.add(globe);
      globes.push(globe);

      if (p.ring) {
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(p.r * 1.5, p.r * 2.5, 96),
          new THREE.MeshStandardMaterial({
            color: emberColor(p.level + 0.2),
            roughness: 0.5,
            metalness: 0.3,
            transparent: true,
            opacity: 0.5,
            side: THREE.DoubleSide,
          }),
        );
        ring.rotation.x = Math.PI / 2;
        globe.add(ring);
      }

      // 衛星は惑星と一緒に運ばれるが、惑星の自転には巻き込まれない
      for (let m = 0; m < p.moons; m++) {
        const arm = new THREE.Object3D();
        arm.rotation.x = 0.5 + rnd() * 0.5;
        pivot.add(arm);
        moonArms.push(arm);
        moonSpec.push(1.7 + rnd() * 2.2, rnd());

        const moon = new THREE.Mesh(
          new THREE.IcosahedronGeometry(p.r * (0.2 + rnd() * 0.12), 1),
          new THREE.MeshStandardMaterial({
            color: emberColor(0.3),
            roughness: 0.8,
            flatShading: true,
          }),
        );
        moon.position.x = p.r * (2.1 + rnd() * 0.8);
        arm.add(moon);
      }
    }
  },

  update(t) {
    const shift = drift(t);

    const breathe = 1 + Math.sin(t * 0.7) * SUN_PULSE;
    sun.scale.setScalar(breathe);
    corona.scale.setScalar(1 + Math.sin(t * 0.7 + 1.1) * SUN_PULSE * 2);
    sunMat.emissiveIntensity = SUN_GLOW + Math.sin(t * 1.27) * 0.06;

    let arm = 0;
    for (let i = 0; i < ORBIT_N; i++) {
      const p = PLANETS[i];
      const phase = t / p.period + p.phase;
      orbitAt(p, phase, pivots[i].position);
      globes[i].rotation.y = (t / p.spin) * Math.PI * 2;

      // 軌道の傾きは x 成分を変えないので、向き（node）だけで左右の位置が出る
      const x = pivots[i].position.x;
      const z = pivots[i].position.z * Math.cos(p.tilt);
      pans[i] = (x * Math.cos(p.node) + z * Math.sin(p.node)) / PLANETS[ORBIT_N - 1].a;

      ember(color, p.level, shift);
      mats[i].color.copy(color);

      for (let m = 0; m < p.moons; m++, arm++) {
        moonArms[arm].rotation.y =
          (t / moonSpec[arm * 2] + moonSpec[arm * 2 + 1]) * Math.PI * 2;
      }
    }
  },

  sound(t, _dt, sfx) {
    sfx.drone(tone(-3), 0.05);

    for (let i = 0; i < ORBIT_N; i++) {
      const p = PLANETS[i];
      for (let k = ticks[i](t / p.period + p.phase); k > 0; k--) {
        sfx.pluck(tone(p.note), {
          gain: 0.16 + p.r * 0.12,
          decay: 2.4 + p.r,
          pan: Math.max(-1, Math.min(1, pans[i])) * 0.6,
        });
      }
    }
  },
};
