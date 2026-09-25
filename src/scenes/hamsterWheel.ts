import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, ticker } from '../audio.ts';
import { SURFACE, ember, emberColor, drift } from '../palette.ts';

/**
 * Hamster Wheel。
 *
 * 縦に立てた回し車の底で、まん丸のフワフワのハムスターが走り続ける。
 * 体は千数百本の短く先の丸い毛の房で包んであり、ひと蹴りごとに体が弾むと、毛が
 * 鼻先からお尻へ少し遅れて波打つ。足は前後の 2 組が交互に地面を掻く。
 *
 * 気持ちよさの芯は「足の運びと車輪の回転が完全に噛み合っている」こと。
 * 接地中の足は車輪の周速とちょうど同じ速さで後ろへ流れるので、滑らない。
 * 走る速さは 19 秒周期でわずかに緩急し、そのぶんハムスターは車輪の坂を
 * 少し登ったり戻ったりする。足・車輪・位置はすべて同じ積分 u(t) から作る。
 *
 * カメラは斜め前の少し上から。音は横桟が足元を 4 本通るごとに柔らかく鳴る。
 * スコープ外: 巣材や餌皿などの小道具、瞬きや毛づくろいなどの別の仕草。
 */

// ---- 回し車 ----
/** 車輪の半径（横桟の中心まで） */
const R = 3.3;
/** 車輪の奥行き */
const W = 2.5;
/** 横桟の本数 */
const RUNGS = 44;
/** 横桟の太さ（半径） */
const RUNG_R = 0.055;
/** 車輪の中心の高さ */
const HUB_Y = R + 1.0;
/** 裏側のスポークの本数 */
const SPOKES = 6;

// ---- 走り ----
/** 車輪の周速の基準（単位/秒） */
const V0 = 2.6;
/** 1 歩（前足→後ろ足で 1 周）にかかる秒数 */
const STRIDE = 0.34;
/** 速さの緩急の周期と振れ幅 */
const EASE_T = 19;
const EASE_A = 0.12;
/** 車輪の坂を登る角度（底からの傾き、ラジアン）。負で進行方向 -x 側へ登る */
const CLIMB = -0.16;
/** 緩急に合わせて坂を登り降りする幅 */
const CLIMB_SWAY = 0.08;

// ---- ハムスター ----
/** 胴の半径（x: 前後, y: 上下, z: 左右） */
const BODY = [1.05, 0.78, 0.8] as const;
/** 頭の中心（胴の中心から）と半径 */
const HEAD_C = [-0.82, 0.14, 0] as const;
const HEAD_R = 0.62;
/** 地面から胴の中心までの高さ */
const BODY_H = 1.0;
/** 毛の房の数（胴 / 頭） */
const FUR_BODY = 1100;
const FUR_HEAD = 340;
/** 房の長さの倍率の範囲と太さ。先の丸い短いカプセルにする */
const FUR_MIN = 0.8;
const FUR_MAX = 1.25;
const FUR_W = 0.055;
const FUR_LEN = 0.09;
/** 房をお尻側へ寝かせる度合い */
const FUR_COMB = 1.8;
/** 弾みの大きさと、毛が波打つ大きさ（長さの伸び縮みの割合） */
const BOUNCE = 0.07;
const FUR_JIGGLE = 0.18;
/** 足の上げ幅 */
const FOOT_LIFT = 0.2;

// ---- カメラまわり ----
const FLOOR_R = 9;

const dummy = new THREE.Object3D();
const color = new THREE.Color();
const up = new THREE.Vector3(0, 1, 0);
const dir = new THREE.Vector3();

let wheel: THREE.Group;
let hamPivot: THREE.Group;
let ham: THREE.Group;
let fur: THREE.InstancedMesh;
let feet: THREE.Mesh[] = [];
let rungMat: THREE.MeshStandardMaterial;

/** 毛の房ごとの [x, y, z, 向き x, y, z, 長さ, 位相遅れ] */
let furData = new Float32Array(0);

let tick = ticker();
let step = 0;

/** 緩急を積分した「走った量」。足・車輪・位置はすべてここから作る */
function travel(t: number): number {
  const w = (Math.PI * 2) / EASE_T;
  return t + (EASE_A / w) * (1 - Math.cos(w * t));
}

/** 2 点のあいだに円柱を渡す */
function beam(a: THREE.Vector3, b: THREE.Vector3, r: number, mat: THREE.Material): THREE.Mesh {
  const d = new THREE.Vector3().subVectors(b, a);
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, d.length(), 12), mat);
  m.position.copy(a).addScaledVector(d, 0.5);
  m.quaternion.setFromUnitVectors(up, d.normalize());
  return m;
}

export const hamsterWheel: SceneModule = {
  name: 'Hamster Wheel',
  desc: 'フワフワのハムスターが回し車の底で走り続ける。足の運びと車輪の回転がぴたりと噛み合う。',
  camera: { pos: [-3.2, 3.4, 8.2], target: [-0.2, 2.2, 0] },
  shadows: true,

  build(root) {
    tick = ticker();
    step = 0;
    let s = 0.731;
    const rnd = (): number => (s = (s * 9301 + 0.49297) % 1);

    // ---- 床 ----
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(FLOOR_R, 96),
      new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.3, metalness: 0.85 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.02;
    floor.receiveShadow = true;
    root.add(floor);

    // ---- 回し車 ----
    const metal = new THREE.MeshStandardMaterial({
      color: emberColor(0.42, -0.01),
      roughness: 0.32,
      metalness: 0.7,
    });
    rungMat = new THREE.MeshStandardMaterial({ roughness: 0.3, metalness: 0.7 });
    rungMat.color.copy(emberColor(0.5));

    wheel = new THREE.Group();
    wheel.position.set(0, HUB_Y, 0);
    root.add(wheel);

    for (const z of [-W / 2, W / 2]) {
      const rim = new THREE.Mesh(new THREE.TorusGeometry(R, 0.09, 12, 120), metal);
      rim.position.z = z;
      rim.castShadow = true;
      wheel.add(rim);
    }

    const rungs = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(RUNG_R, RUNG_R, W, 8).rotateX(Math.PI / 2),
      rungMat,
      RUNGS,
    );
    for (let i = 0; i < RUNGS; i++) {
      const a = (i / RUNGS) * Math.PI * 2;
      dummy.position.set(Math.cos(a) * R, Math.sin(a) * R, 0);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      rungs.setMatrixAt(i, dummy.matrix);
    }
    rungs.castShadow = true;
    wheel.add(rungs);

    // 裏側だけにスポーク。表は開けてハムスターを見せる
    const zb = -W / 2;
    for (let i = 0; i < SPOKES; i++) {
      const a = (i / SPOKES) * Math.PI * 2 + 0.3;
      wheel.add(
        beam(
          new THREE.Vector3(0, 0, zb),
          new THREE.Vector3(Math.cos(a) * R, Math.sin(a) * R, zb),
          0.05,
          metal,
        ),
      );
    }
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.3, 24).rotateX(Math.PI / 2), metal);
    hub.position.z = zb;
    wheel.add(hub);

    // ---- 台（回らない） ----
    const standMat = new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.45, metalness: 0.6 });
    const axleBack = new THREE.Vector3(0, HUB_Y, -W / 2 - 0.55);
    root.add(beam(new THREE.Vector3(0, HUB_Y, -W / 2), axleBack, 0.09, standMat));
    for (const x of [-1, 1]) {
      const leg = beam(axleBack, new THREE.Vector3(x * 2.1, 0.05, -W / 2 - 0.55), 0.1, standMat);
      leg.castShadow = true;
      root.add(leg);
    }
    const base = new THREE.Mesh(new THREE.BoxGeometry(5, 0.1, 0.7), standMat);
    base.position.set(0, 0.05, -W / 2 - 0.55);
    root.add(base);

    // ---- ハムスター ----
    hamPivot = new THREE.Group();
    hamPivot.position.set(0, HUB_Y, 0);
    root.add(hamPivot);
    ham = new THREE.Group();
    hamPivot.add(ham);

    // 背中は濃い琥珀、お腹・頬・鼻先はクリーム。芯と毛で同じ塗り分けを使う
    const shade = (out: THREE.Color, x: number, y: number, z: number, jit: number): THREE.Color => {
      const cheek = x < -0.45 ? THREE.MathUtils.smoothstep(-x, 0.45, 1.3) * 0.5 : 0;
      const belly = THREE.MathUtils.smoothstep(-y + cheek - Math.abs(z) * 0.15, -0.15, 0.45);
      return ember(out, 0.66 + 0.34 * belly + jit, 0, 0.16 * belly);
    };

    // 芯: 滑らかな胴と頭。頂点色で塗り分ける
    const coreMat = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0, vertexColors: true });
    const paint = (geo: THREE.BufferGeometry, ox: number, oy: number, oz: number): THREE.BufferGeometry => {
      const pos = geo.attributes.position;
      const col = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) {
        shade(color, pos.getX(i) + ox, pos.getY(i) + oy, pos.getZ(i) + oz, 0).toArray(col, i * 3);
      }
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      return geo;
    };
    const bodyGeo = new THREE.SphereGeometry(1, 40, 28);
    bodyGeo.scale(BODY[0], BODY[1], BODY[2]);
    const core = new THREE.Mesh(paint(bodyGeo, 0, 0, 0), coreMat);
    core.castShadow = true;
    ham.add(core);
    const headGeo = new THREE.SphereGeometry(HEAD_R, 32, 24);
    const head = new THREE.Mesh(paint(headGeo, HEAD_C[0], HEAD_C[1], HEAD_C[2]), coreMat);
    head.position.set(HEAD_C[0], HEAD_C[1], HEAD_C[2]);
    ham.add(head);
    // 鼻先のふくらみ（マズル）
    const muzzleGeo = new THREE.SphereGeometry(0.3, 24, 16);
    muzzleGeo.scale(1, 0.8, 1.1);
    const mz = [HEAD_C[0] - HEAD_R * 0.78, HEAD_C[1] - 0.14, 0] as const;
    const muzzle = new THREE.Mesh(paint(muzzleGeo, mz[0], mz[1] - 0.3, mz[2]), coreMat);
    muzzle.position.set(mz[0], mz[1], mz[2]);
    ham.add(muzzle);

    // 毛: 芯から生えた細く短い房。お尻の方向へ少し寝かせる
    const total = FUR_BODY + FUR_HEAD;
    furData = new Float32Array(total * 8);
    const strand = new THREE.CapsuleGeometry(FUR_W, FUR_LEN, 3, 6);
    strand.translate(0, FUR_LEN / 2, 0);
    fur = new THREE.InstancedMesh(strand, new THREE.MeshStandardMaterial({ roughness: 0.85 }), total);
    fur.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const n = new THREE.Vector3();
    for (let i = 0; i < total; i++) {
      // 球面上に一様に散らしてから楕円体へ伸ばす
      const zz = rnd() * 2 - 1;
      const ph = rnd() * Math.PI * 2;
      const rr = Math.sqrt(1 - zz * zz);
      n.set(rr * Math.cos(ph), zz, rr * Math.sin(ph));
      let x: number, y: number, z: number;
      if (i < FUR_BODY) {
        x = n.x * BODY[0];
        y = n.y * BODY[1];
        z = n.z * BODY[2];
        n.set(x / (BODY[0] * BODY[0]), y / (BODY[1] * BODY[1]), z / (BODY[2] * BODY[2])).normalize();
      } else {
        x = HEAD_C[0] + n.x * HEAD_R;
        y = HEAD_C[1] + n.y * HEAD_R;
        z = HEAD_C[2] + n.z * HEAD_R;
      }
      // 顔の正面（目と鼻のあたり）には生やさない
      if (i >= FUR_BODY && n.x < -0.55) {
        x = HEAD_C[0] + 0.1;
        y = HEAD_C[1];
        z = 0;
        n.set(0, 1, 0);
      }
      n.x += FUR_COMB;
      n.normalize();
      const k = i * 8;
      furData[k] = x;
      furData[k + 1] = y;
      furData[k + 2] = z;
      furData[k + 3] = n.x;
      furData[k + 4] = n.y;
      furData[k + 5] = n.z;
      furData[k + 6] = FUR_MIN + (FUR_MAX - FUR_MIN) * rnd();
      // 鼻先から尻へ少しずつ遅れて波打つ
      furData[k + 7] = (x + 1.5) * 0.9 + rnd() * 0.25;
      fur.setColorAt(i, shade(color, x, y, z, (rnd() - 0.5) * 0.08));
    }
    ham.add(fur);

    // 顔: 目・鼻・耳
    const eyeMat = new THREE.MeshStandardMaterial({ color: 0x0a0506, roughness: 0.1, metalness: 0.3 });
    const pinkMat = new THREE.MeshStandardMaterial({ color: emberColor(0.3, 0.02, 0.16), roughness: 0.7 });
    const hc = new THREE.Vector3(HEAD_C[0], HEAD_C[1], HEAD_C[2]);
    for (const sd of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.1, 16, 12), eyeMat);
      eye.position.set(-0.62, 0.34, sd * 0.62).normalize().multiplyScalar(HEAD_R * 0.97).add(hc);
      ham.add(eye);

      // 耳: 毛色の外側と、ピンクの内側
      const ear = new THREE.Group();
      ear.position.set(HEAD_C[0] + 0.12, HEAD_C[1] + HEAD_R * 0.82, sd * 0.34);
      ear.rotation.set(sd * 0.45, 0, -0.25);
      const outer = new THREE.Mesh(new THREE.SphereGeometry(0.24, 16, 12), coreMat);
      paint(outer.geometry, 0, 1, 0);
      outer.scale.set(0.35, 1, 1);
      const inner = new THREE.Mesh(new THREE.SphereGeometry(0.18, 16, 12), pinkMat);
      inner.scale.set(0.3, 1, 1);
      inner.position.set(-0.05, 0.02, 0);
      ear.add(outer, inner);
      ham.add(ear);
    }
    const nose = new THREE.Mesh(new THREE.SphereGeometry(0.075, 12, 10), pinkMat);
    nose.position.set(mz[0] - 0.3, mz[1] + 0.04, 0);
    ham.add(nose);

    // 足 4 本（前左, 前右, 後左, 後右）
    feet = [];
    const footGeo = new THREE.SphereGeometry(0.15, 14, 10);
    footGeo.scale(1.5, 0.6, 1);
    for (let i = 0; i < 4; i++) {
      const f = new THREE.Mesh(footGeo, pinkMat);
      feet.push(f);
      ham.add(f);
    }
  },

  update(t) {
    const u = travel(t);
    const speed = 1 + EASE_A * Math.sin(((Math.PI * 2) / EASE_T) * t);

    // 車輪: 底が +x へ流れる向き（ハムスターは -x へ走る）
    wheel.rotation.z = (V0 * u) / R;
    rungMat.color.copy(ember(color, 0.5, drift(t)));

    // 速いときは少し坂を登り、緩むと戻る
    hamPivot.rotation.z = CLIMB - CLIMB_SWAY * (speed - 1) / EASE_A;

    const g = u / STRIDE; // 歩の位相（整数で 1 歩）
    const gf = g - Math.floor(g);
    const bounce = BOUNCE * Math.abs(Math.sin(Math.PI * 2 * g));
    ham.position.set(0, -(R - RUNG_R) + BODY_H + bounce, 0);
    ham.rotation.z = 0.05 * Math.sin(Math.PI * 2 * g + 0.6);
    ham.scale.set(1 + bounce * 0.5, 1 - bounce * 0.8, 1 + bounce * 0.5);

    // 足: 接地の半周は周速 V0 で後ろ (+x) へ流れ、残り半周で浮いて前へ戻る
    const d = (V0 * STRIDE) / 4;
    const groundY = -BODY_H + 0.09;
    for (let i = 0; i < 4; i++) {
      const front = i < 2;
      const side = i % 2 === 0 ? -1 : 1;
      let p = gf + (front ? 0 : 0.5) + (side > 0 ? 0.08 : 0);
      p -= Math.floor(p);
      let x: number, lift: number;
      if (p < 0.5) {
        x = -d + 4 * d * p;
        lift = 0;
      } else {
        const q = (p - 0.5) * 2;
        x = d - 2 * d * (0.5 - 0.5 * Math.cos(Math.PI * q));
        lift = FOOT_LIFT * Math.sin(Math.PI * q);
      }
      const f = feet[i];
      f.position.set((front ? -0.55 : 0.5) + x, groundY + lift - bounce, side * (front ? 0.36 : 0.46));
    }

    // 毛: 弾みに少し遅れて、鼻先からお尻へ伸び縮みが伝わる
    for (let i = 0, k = 0; i < FUR_BODY + FUR_HEAD; i++, k += 8) {
      const j = 1 + FUR_JIGGLE * Math.sin(Math.PI * 4 * g - furData[k + 7]);
      dummy.position.set(furData[k], furData[k + 1], furData[k + 2]);
      dir.set(furData[k + 3], furData[k + 4], furData[k + 5]);
      dummy.quaternion.setFromUnitVectors(up, dir);
      dummy.scale.set(1, furData[k + 6] * j, 1);
      dummy.updateMatrix();
      fur.setMatrixAt(i, dummy.matrix);
    }
    fur.instanceMatrix.needsUpdate = true;
  },

  sound(t, _dt, sfx) {
    // 横桟が足元を 4 本通るごとに 1 回
    const rungsPassed = ((V0 * travel(t)) / R / (Math.PI * 2)) * RUNGS;
    for (let k = tick(rungsPassed / 4); k > 0; k--) {
      step++;
      sfx.pluck(tone(3 + [0, 2, 4, 2][step % 4]), {
        gain: 0.16,
        decay: 0.7,
        pan: -0.15,
      });
    }
  },
};
