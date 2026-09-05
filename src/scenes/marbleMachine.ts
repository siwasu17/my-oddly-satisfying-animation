import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, ticker, tickers } from '../audio.ts';
import { SURFACE, ember, emberColor, drift } from '../palette.ts';

/**
 * ピタゴラ装置。玉が「滑り台 → シーソー → 螺旋 → 鳴り物 → 観覧車型の昇降機」
 * と回って、出発点へ戻ってくる。
 *
 * 物理演算は使わない。1 周を 0..1 の位相 u に割り当て、区間ごとの式で玉の
 * 位置を決めている。仕掛けの側（板の傾き・輪の回転・棒の揺れ）も同じ位相から
 * 角度を作るので、玉と装置は永久にずれない。
 *
 * 玉は BALLS 個を 1/BALLS ずつずらして走らせる。どの仕掛けから見ても
 * 「CYCLE/BALLS 秒ごとに玉が 1 個来る」ので、仕掛けの動きは
 * since() が返す 0..1 の位相だけで書ける。
 */

const CYCLE = 16; // 玉が 1 周する秒数
const BALLS = 3; // 同時に走らせる玉の数
const BR = 0.42; // 玉の半径

/** 区間の切れ目（玉の位相）。受け渡し / 滑り台 / シーソー / 落下 / 螺旋 / 下段 / 昇降機。 */
const P_RAIL = 0.03;
const P_SEESAW = 0.18;
const P_DROP = 0.3;
const P_HELIX = 0.34;
const P_ROLL = 0.6;
const P_LIFT = 0.75;

/** 装置は前後 2 枚の面に分けてある。奥がシーソー、手前が下段と昇降機。 */
const Z_BACK = -3.4;
const Z_FRONT = 3.4;

// シーソー。板は z 軸まわりに傾くだけなので、支点と腕の長さで決まる。
const SEE_X = -1;
const SEE_Y = 9.8;
const ARM = 3.4; // 板の半分の長さ
const SURF = BR + 0.17; // 板の上面から玉の中心まで
const TILT_UP = -0.1; // 玉が乗る前の傾き（わずかに右下がり）
const TILT_DOWN = -0.34; // 玉が右端まで来たときの傾き

// 螺旋シュート。x = HX, z = 0 を軸にした 1 周半のらせん。
const HX = 2.4;
const HR = 3.4;
const HY_TOP = 7;
const HY_BOT = 2.3;
const H_FROM = -Math.PI / 2; // 出だしはシーソーの真下（z = Z_BACK）で +x を向く
const H_TURN = Math.PI * 3; // 1 周半回すと、ちょうど手前（z = Z_FRONT）で -x を向く

// 昇降機。腕の先にゴンドラを吊るした観覧車。
const LIFT_X = -8.2;
const LIFT_Y = 8.3;
const LR = 5.6; // 腕の長さ
const HANG = 0.7; // ゴンドラの吊り下げ長さ
const GONDOLAS = 6; // 玉の間隔と噛み合う数（BALLS の 2 倍）

// 下段。螺旋の出口から昇降機の底までを、手前へふくらませて渡す。
const ROLL_Y0 = HY_BOT;
const ROLL_Y1 = LIFT_Y - LR - HANG;
const ROLL_BOW = 1.4;

/** 鳴り物の棒。下段のどこに吊るすかを 0..1 で置く。 */
const BAR_AT = [0.14, 0.33, 0.52, 0.71];
const BAR_TOP = 2.3; // 玉の中心から吊り元までの高さ
const BAR_LEN = 2.5;
const BAR_SWING = 0.42; // 弾かれた直後の振れ幅（rad）

const UP = new THREE.Vector3(0, 1, 0);
const v = new THREE.Vector3();
const va = new THREE.Vector3();
const vb = new THREE.Vector3();
const color = new THREE.Color();

const smooth = (x: number): number => x * x * (3 - 2 * x);
const mix = (a: number, b: number, k: number): number => a + (b - a) * k;

/** 板の上の点。x は支点からの距離、a は傾き。返すのは玉の中心が通る高さ。 */
function plankPoint(x: number, a: number, out: THREE.Vector3): THREE.Vector3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return out.set(SEE_X + x * c - SURF * s, SEE_Y + x * s + SURF * c, Z_BACK);
}

function helixPoint(s: number, out: THREE.Vector3): THREE.Vector3 {
  const th = H_FROM + H_TURN * s;
  return out.set(HX + HR * Math.cos(th), mix(HY_TOP, HY_BOT, s), HR * Math.sin(th));
}

function rollPoint(s: number, out: THREE.Vector3): THREE.Vector3 {
  return out.set(
    mix(HX, LIFT_X, s),
    mix(ROLL_Y0, ROLL_Y1, s),
    Z_FRONT - Math.sin(Math.PI * s) * ROLL_BOW,
  );
}

/** 昇降機の角度。s = 0 が最下点、s = 1 が最上点（左まわりに半周）。 */
const liftAngle = (s: number): number => -Math.PI / 2 - Math.PI * s;

function liftPoint(s: number, out: THREE.Vector3): THREE.Vector3 {
  const th = liftAngle(s);
  return out.set(LIFT_X + LR * Math.cos(th), LIFT_Y + LR * Math.sin(th) - HANG, Z_FRONT);
}

/**
 * 滑り台の受け口。ゴンドラは輪と同じ面を回り続けるので、玉は頂点でカップの
 * 縁を乗り越え、手前へ 1 段ずれたここへ移る。輪が通る面から z をずらしておかないと、
 * 次のゴンドラがレールを薙いでしまう。
 */
const RAIL_HEAD = new THREE.Vector3(LIFT_X, LIFT_Y + LR - HANG - 0.35, Z_FRONT - 1.1);

/** 滑り台の終点（板の左端）と、板から螺旋へ落ちる区間の両端。 */
const RAIL_END = plankPoint(-ARM, TILT_UP, new THREE.Vector3());
const FALL_FROM = plankPoint(ARM, TILT_DOWN, new THREE.Vector3());
const FALL_TO = helixPoint(0, new THREE.Vector3());

/** 滑り台。昇降機の左を大きく回り込みながら、奥の面へ降りてくる。 */
const railCurve = new THREE.CatmullRomCurve3([
  RAIL_HEAD,
  new THREE.Vector3(-11.4, 12.6, 1.2),
  new THREE.Vector3(-11, 11.6, -2),
  new THREE.Vector3(-8, 11, -3.3),
  RAIL_END,
]);

/**
 * 位相 u の玉の位置。
 *
 * 区間をまたぐところで玉が飛ばないよう、位置だけでなく速さも繋げてある。
 * 滑り台と板は smooth() で入りと出をゼロに寄せ、螺旋・下段・昇降機は等速。
 */
function ballPos(u: number, out: THREE.Vector3): THREE.Vector3 {
  if (u < P_RAIL) {
    // 頂点でカップから転がり出て、滑り台の受け口へ移る
    return out.lerpVectors(liftPoint(1, va), RAIL_HEAD, smooth(u / P_RAIL));
  }
  if (u < P_SEESAW) {
    // 途中がいちばん速く、板に着くころには止まりかけている
    const s = (u - P_RAIL) / (P_SEESAW - P_RAIL);
    return railCurve.getPointAt(smooth(s), out);
  }
  if (u < P_DROP) {
    const s = (u - P_SEESAW) / (P_DROP - P_SEESAW);
    return plankPoint(mix(-ARM, ARM, smooth(s)), tilt(smooth(s)), out);
  }
  if (u < P_HELIX) {
    const s = (u - P_DROP) / (P_HELIX - P_DROP);
    return out.lerpVectors(FALL_FROM, FALL_TO, s * s); // 落下なので加速する
  }
  if (u < P_ROLL) {
    return helixPoint((u - P_HELIX) / (P_ROLL - P_HELIX), out);
  }
  if (u < P_LIFT) {
    return rollPoint((u - P_ROLL) / (P_LIFT - P_ROLL), out);
  }
  return liftPoint((u - P_LIFT) / (1 - P_LIFT), out);
}

/** 玉が板の上をどこまで進んだか（0..1）から板の傾きを返す。 */
const tilt = (k: number): number => mix(TILT_UP, TILT_DOWN, k);

/**
 * 位相 u0 を玉が通り過ぎてからの進み具合（0..1）。
 *
 * 玉は 1/BALLS ずつずれているので、どの玉が来ているかを気にせず、
 * この 1 本の位相だけで仕掛けの動きを書ける。1 が次の玉の到着。
 */
function since(t: number, u0: number): number {
  const p = BALLS * (t / CYCLE - u0);
  return p - Math.floor(p);
}

/** 玉が同時に 1 個しか乗らない区間で、その滞在時間が占める割合。 */
const span = (a: number, b: number): number => BALLS * (b - a);

const dir = new THREE.Vector3();
const axis = new THREE.Vector3();

/** 2 点をつなぐ支柱。装置を宙に浮かせないための骨組み。 */
function strut(a: THREE.Vector3, b: THREE.Vector3, mat: THREE.Material, r = 0.13): THREE.Mesh {
  const d = dir.subVectors(b, a);
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, d.length(), 8), mat);
  mesh.position.copy(a).addScaledVector(d, 0.5);
  mesh.quaternion.setFromUnitVectors(UP, axis.copy(d).normalize());
  return mesh;
}

/**
 * 玉の通り道に沿って 2 本のレールを敷く。
 * 中心線をそのまま管にすると玉が管に埋まるので、少し下と左右へ振り分ける。
 */
function rails(
  path: (s: number, out: THREE.Vector3) => THREE.Vector3,
  segs: number,
  mat: THREE.Material,
): THREE.Group {
  const left: THREE.Vector3[] = [];
  const right: THREE.Vector3[] = [];
  const p = new THREE.Vector3();
  const q = new THREE.Vector3();

  for (let i = 0; i <= segs; i++) {
    path(i / segs, p);
    path(Math.min(i + 1, segs) / segs, q);
    if (i === segs) path((segs - 1) / segs, p); // 末端は 1 つ手前との差で向きを取る
    const side = va.subVectors(q, p).normalize().cross(UP).normalize().multiplyScalar(0.4);
    path(i / segs, p).addScaledVector(UP, -BR * 0.9);
    left.push(p.clone().add(side));
    right.push(p.clone().sub(side));
  }

  const group = new THREE.Group();
  for (const pts of [left, right]) {
    const curve = new THREE.CatmullRomCurve3(pts);
    group.add(new THREE.Mesh(new THREE.TubeGeometry(curve, segs, 0.085, 6, false), mat));
  }
  return group;
}

let plank: THREE.Group;
let wheel: THREE.Group;
let gondolas: THREE.Group[] = [];
let bars: THREE.Group[] = [];
let barMats: THREE.MeshStandardMaterial[] = [];
let balls: THREE.Mesh[] = [];
let ballMat: THREE.MeshStandardMaterial;
/** 玉の自転。進んだ距離を積み上げるので、区間ごとの速さの違いがそのまま出る。 */
const spin = new THREE.Quaternion();

let tk = {
  land: ticker(),
  tip: ticker(),
  helix: ticker(),
  slide: ticker(),
  top: ticker(),
  bar: tickers(BAR_AT.length),
};

/** 玉が仕掛けを渡り歩き、昇降機で持ち上げられてまた最初へ戻る。 */
export const marbleMachine: SceneModule = {
  name: 'Marble Machine',
  desc: '滑り台からシーソー、螺旋、鳴り物へ。運ばれた玉がまた同じ道を落ちていく。',
  camera: { pos: [2.6, 11.6, 21], target: [-3.5, 6.8, 0] },

  build(root) {
    tk = {
      land: ticker(),
      tip: ticker(),
      helix: ticker(),
      slide: ticker(),
      top: ticker(),
      bar: tickers(BAR_AT.length),
    };

    const railMat = new THREE.MeshStandardMaterial({
      color: emberColor(0.34),
      emissive: emberColor(0.1),
      roughness: 0.35,
      metalness: 0.75,
    });
    const partMat = new THREE.MeshStandardMaterial({
      color: SURFACE,
      roughness: 0.5,
      metalness: 0.7,
    });
    ballMat = new THREE.MeshStandardMaterial({
      color: emberColor(0.95),
      emissive: emberColor(0.8),
      roughness: 0.18,
      metalness: 0.3,
    });

    // 通り道。板と昇降機の区間だけは仕掛けが玉を運ぶので、レールを敷かない。
    root.add(rails((s, out) => railCurve.getPointAt(s, out), 90, railMat));
    root.add(rails(helixPoint, 150, railMat));
    // 下段のレールは輪の手前で切る。最後のひと転がりはゴンドラが受け止める。
    root.add(rails((s, out) => rollPoint(s * 0.85, out), 60, railMat));

    // シーソー。支点を中心に板を置き、傾きは update で入れる。
    plank = new THREE.Group();
    plank.position.set(SEE_X, SEE_Y, Z_BACK);
    const board = new THREE.Mesh(new THREE.BoxGeometry(ARM * 2, 0.34, 1.1), railMat);
    plank.add(board);
    root.add(plank);
    const pivot = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 1.6, 12), partMat);
    pivot.rotation.x = Math.PI / 2;
    pivot.position.set(SEE_X, SEE_Y, Z_BACK);
    root.add(pivot);
    for (const dz of [-1.6, 1.6]) {
      root.add(strut(va.set(SEE_X, 0, Z_BACK + dz), vb.set(SEE_X, SEE_Y, Z_BACK), partMat));
    }

    // 螺旋の芯柱と、そこからレールへ渡す腕。
    const column = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, HY_TOP + 0.6, 16), partMat);
    column.position.set(HX, (HY_TOP + 0.6) / 2, 0);
    root.add(column);
    for (let i = 0; i <= 6; i++) {
      const s = i / 6;
      helixPoint(s, v);
      // 腕はレールの下へ差し込む。玉の高さまで伸ばすと球にめり込む。
      root.add(strut(va.set(HX, v.y, 0), vb.copy(v).addScaledVector(UP, -BR - 0.14), partMat, 0.07));
    }

    // 昇降機。腕は回し、ゴンドラは吊り下げたまま水平に保つ。
    wheel = new THREE.Group();
    wheel.position.set(LIFT_X, LIFT_Y, Z_FRONT);
    wheel.add(new THREE.Mesh(new THREE.TorusGeometry(LR, 0.07, 6, 96), railMat));
    for (let i = 0; i < GONDOLAS; i++) {
      const a = (i / GONDOLAS) * Math.PI * 2;
      const spoke = new THREE.Mesh(new THREE.BoxGeometry(LR, 0.11, 0.11), railMat);
      spoke.position.set((Math.cos(a) * LR) / 2, (Math.sin(a) * LR) / 2, 0);
      spoke.rotation.z = a;
      wheel.add(spoke);
    }
    root.add(wheel);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.8, 16), partMat);
    hub.rotation.x = Math.PI / 2;
    hub.position.set(LIFT_X, LIFT_Y, Z_FRONT);
    root.add(hub);
    for (const dz of [-2.2, 1.1]) {
      for (const dx of [-3.4, 3.4]) {
        root.add(
          strut(
            va.set(LIFT_X + dx, 0, Z_FRONT + dz),
            vb.set(LIFT_X, LIFT_Y, Z_FRONT + dz),
            partMat,
          ),
        );
      }
    }

    gondolas = [];
    for (let i = 0; i < GONDOLAS; i++) {
      const g = new THREE.Group();
      // 玉を上から受けるだけの浅い受け皿。深くすると下段のレールを薙いでしまう。
      const cup = new THREE.Mesh(
        new THREE.CylinderGeometry(BR + 0.24, BR + 0.02, 0.42, 14, 1, true),
        railMat,
      );
      cup.position.y = -0.1;
      g.add(cup);
      const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, HANG, 6), railMat);
      rod.position.y = HANG / 2 + 0.1;
      g.add(rod);
      root.add(g);
      gondolas.push(g);
    }

    // 鳴り物。下段の上に梁を渡し、玉が当たる高さまで棒を垂らす。
    root.add(
      rails(
        (s, out) => rollPoint(0.06 + s * 0.79, out).addScaledVector(UP, BAR_TOP + BR * 0.9),
        40,
        partMat,
      ),
    );
    for (const s of [0.25, 0.7]) {
      rollPoint(s, v);
      root.add(strut(va.set(v.x, 0, v.z), vb.set(v.x, v.y + BAR_TOP, v.z), partMat));
    }
    bars = [];
    barMats = [];
    for (const s of BAR_AT) {
      rollPoint(s, v);
      const mat = new THREE.MeshStandardMaterial({
        color: emberColor(0.4),
        emissive: emberColor(0.2),
        roughness: 0.3,
        metalness: 0.85,
      });
      const g = new THREE.Group();
      g.position.set(v.x, v.y + BAR_TOP, v.z);
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.2, BAR_LEN, 0.5), mat);
      bar.position.y = -BAR_LEN / 2;
      g.add(bar);
      root.add(g);
      bars.push(g);
      barMats.push(mat);
    }

    balls = [];
    for (let i = 0; i < BALLS; i++) {
      const ball = new THREE.Mesh(new THREE.SphereGeometry(BR, 24, 16), ballMat);
      root.add(ball);
      balls.push(ball);
    }

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(22, 96),
      new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.25, metalness: 0.9 }),
    );
    floor.rotation.x = -Math.PI / 2;
    root.add(floor);
  },

  update(t) {
    const d = drift(t);

    for (let i = 0; i < BALLS; i++) {
      const u = (t / CYCLE + i / BALLS) % 1;
      const ball = balls[i]!;
      ballPos(u, v);
      // 直前の位置との差を進行方向とし、進んだ距離ぶんだけ転がす
      va.subVectors(v, ball.position);
      const step = va.length();
      if (step > 1e-5 && step < 1) {
        vb.copy(UP).cross(va.divideScalar(step)).normalize();
        spin.setFromAxisAngle(vb, step / BR);
        ball.quaternion.premultiply(spin);
      }
      ball.position.copy(v);
    }
    ember(color, 0.95, d, 0.05);
    ballMat.color.copy(color);
    ballMat.emissive.copy(color);

    // シーソー。玉が乗っている間に傾き、離れてからゆっくり戻る。
    const m = since(t, P_SEESAW);
    const ride = span(P_SEESAW, P_DROP);
    plank.rotation.z =
      m < ride ? tilt(smooth(m / ride)) : tilt(1 - smooth(Math.min((m - ride) / 0.34, 1)));

    // 昇降機。玉が半周する速さで回すので、腕は必ず玉の真下に来る。
    wheel.rotation.z = liftAngle(0) - (Math.PI * t) / (CYCLE * (1 - P_LIFT));
    for (let i = 0; i < GONDOLAS; i++) {
      const a = wheel.rotation.z + (i / GONDOLAS) * Math.PI * 2;
      gondolas[i]!.position.set(
        LIFT_X + Math.cos(a) * LR,
        LIFT_Y + Math.sin(a) * LR - HANG,
        Z_FRONT,
      );
    }
    // 鳴り物。弾かれた瞬間から減衰しながら揺れる。
    for (let i = 0; i < BAR_AT.length; i++) {
      const tau = since(t, barPhase(i)) * (CYCLE / BALLS);
      const damp = Math.exp(-1.5 * tau);
      bars[i]!.rotation.z = -BAR_SWING * damp * Math.sin(5.5 * tau);
      ember(color, 0.4 + damp * 0.45, d, damp * 0.12);
      barMats[i]!.color.copy(color);
      barMats[i]!.emissive.copy(color);
    }
  },

  sound(t, _dt, sfx) {
    const at = (u: number): number => BALLS * (t / CYCLE - u);

    if (tk.land(at(P_SEESAW))) sfx.pluck(tone(2), { gain: 0.32, decay: 1.6, pan: -0.3 });
    if (tk.tip(at(P_DROP))) sfx.drop(tone(6), { gain: 0.3, decay: 0.7, pan: 0.35 });
    if (tk.helix(at(P_HELIX))) {
      sfx.air({ gain: 0.3, decay: 3.6, freq: 560, sweep: 0.4, q: 1.8, pan: 0.4 });
    }
    for (let i = 0; i < BAR_AT.length; i++) {
      if (tk.bar[i]!(at(barPhase(i)))) {
        sfx.pluck(tone(9 + i * 2), { gain: 0.26, decay: 2.2, pan: 0.3 - i * 0.25 });
      }
    }
    if (tk.top(at(0))) sfx.drop(tone(11), { gain: 0.2, decay: 0.5, pan: -0.65 });
    if (tk.slide(at(P_RAIL))) {
      sfx.air({ gain: 0.24, decay: 2.6, freq: 420, sweep: 1.5, q: 1.2, pan: -0.6 });
    }
  },
};

/** i 番目の棒が弾かれる位相。 */
function barPhase(i: number): number {
  return P_ROLL + (P_LIFT - P_ROLL) * BAR_AT[i]!;
}
