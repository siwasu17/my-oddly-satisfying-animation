import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, tickers } from '../audio.ts';
import { SURFACE, ember, emberColor, drift } from '../palette.ts';

/**
 * Jelly Globe。
 *
 * 何が動くか: ガラスの球体水槽の中を、小さなクラゲが 7 匹漂う。傘がすぼまると
 * その拍のぶんだけ前へ押し出され、傘が開くあいだは惰性でゆっくり滑って減速する。
 * 触手は傘の動きに遅れて波打ち、体の向きは進む先を向く。
 * 気持ちよさの芯: 傘が「ふっ」とすぼまって押し出され、開きながら滑って止まる、一拍ぶんの推進。
 * 個体ごとに拍の周期と位相をずらしてあるので、画面のどこかでは常に誰かが脈打っている。
 * ループの周期: 傘の脈が 2.6〜4.2 秒。軌道はひと回り 40〜110 秒で、軸ごとに周期が
 * 違うので同じ配置には戻らない。
 * カメラ: 球のやや上から、水槽全体が入る距離で見る。
 * 音: 傘がいちばんすぼまった瞬間に水滴をひとつ。水の静けさとして低い持続音を薄く敷く。
 * スコープ外: 流体の計算。水の流れは無く、軌道は時刻の関数として直接与えている。
 */

/** ガラス球の半径 */
const TANK_R = 9;
/** クラゲの軌道が収まる範囲。ここに傘の大きさと触手の長さぶんの余裕を見てある。 */
const INNER = 6.2;

/** クラゲの数 */
const JELLIES = 7;
/** 1 匹あたりの触手の本数 */
const TENTACLES = 6;
/** 触手 1 本を何個の珠で描くか */
const BEADS = 6;
/** 珠と珠の間隔（傘の半径を 1 としたときの値） */
const BEAD_GAP = 0.28;
const BEAD_TOTAL = JELLIES * TENTACLES * BEADS;

/** 傘の断面。0 が真上、これが縁。半球より少しだけ深く伏せる。 */
const THETA_MAX = Math.PI * 0.52;

/** 水中に漂う微粒子の数 */
const MOTES = 190;

const dummy = new THREE.Object3D();
const color = new THREE.Color();
const up = new THREE.Vector3(0, 1, 0);
const dir = new THREE.Vector3();
const ahead = new THREE.Vector3();
const behind = new THREE.Vector3();
const local = new THREE.Vector3();
const quat = new THREE.Quaternion();

/** クラゲごとの [大きさ, 傘の周期, 拍の位相, 軌道の速さ, 明るさ] */
const jelly = new Float32Array(JELLIES * 5);
/** クラゲごとの軌道 [中心x, 振幅x, 角速度x, 位相x, ...y, ...z] */
const orbit = new Float32Array(JELLIES * 12);
/** 音の定位に使う、いまの x 座標 */
const panX = new Float32Array(JELLIES);

/** 傘の素の頂点。全個体で同じ形から作るので 1 組だけ持つ。 */
let bellTheta: Float32Array;
let bellAz: Float32Array;
let bellCount = 0;

let bells: THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial>[] = [];
/** 傘ごとの頂点座標。毎フレーム書き換えるので取り出して持っておく。 */
let bellPos: THREE.BufferAttribute[] = [];
let beads: THREE.InstancedMesh;
let motes: THREE.InstancedMesh;

/** 傘がいちばんすぼまった回数を、個体ごとに数える */
let ticks = tickers(JELLIES);

/** 固定シード。開き直すたびに絵が変わらないようにする。 */
let seed = 0.417;
const rnd = (): number => (seed = (seed * 9301 + 0.49297) % 1);

/** 軌道上の点。半径の違う 3 本の正弦を組んだだけなので、球の中で閉じずに回り続ける。 */
function orbitAt(i: number, tau: number, out: THREE.Vector3): THREE.Vector3 {
  const o = i * 12;
  out.set(
    orbit[o] + orbit[o + 1] * Math.sin(orbit[o + 2] * tau + orbit[o + 3]),
    orbit[o + 4] + orbit[o + 5] * Math.sin(orbit[o + 6] * tau + orbit[o + 7]),
    orbit[o + 8] + orbit[o + 9] * Math.sin(orbit[o + 10] * tau + orbit[o + 11]),
  );
  return out;
}

/**
 * 経過秒から軌道上の位置（の媒介変数）を出す。
 *
 * 速さを `base + push * (0.5 - 0.5cos)` に取り、その原始関数をそのまま書いてある。
 * 差分を積み上げないので、タブを離れて戻っても同じ絵に戻る。
 */
function swimAt(i: number, t: number, phase: number, period: number): number {
  const push = jelly[i * 5 + 3];
  return (1 + push * 0.5) * t - ((push * period) / (4 * Math.PI)) * Math.sin(phase * Math.PI * 2);
}

export const jellyGlobe: SceneModule = {
  name: 'Jelly Globe',
  desc: 'ガラス球の水槽を漂う 7 匹のクラゲ。傘をすぼめた拍のぶんだけ前へ滑る。',
  camera: { pos: [0, 6, 26], target: [0, -0.6, 0] },

  build(root) {
    seed = 0.417;
    ticks = tickers(JELLIES);
    bells = [];
    bellPos = [];

    // --- クラゲごとの素性を決める ---
    for (let i = 0; i < JELLIES; i++) {
      const j = i * 5;
      jelly[j] = 0.9 + rnd() * 0.6; // 大きさ
      jelly[j + 1] = 2.6 + rnd() * 1.6; // 傘の周期（秒）
      jelly[j + 2] = rnd(); // 拍の位相
      jelly[j + 3] = 1.1 + rnd() * 0.9; // 一拍で前へ出る量
      jelly[j + 4] = 0.45 + rnd() * 0.45; // 明るさ

      // 縄張りの中心。黄金角で振ると、球の中で偏らずに散る。
      const az = i * 2.399;
      const cy = ((i + 0.5) / JELLIES) * 1.5 - 0.75;
      const cr = Math.sqrt(1 - cy * cy) * INNER * 0.58;

      // 軸ごとに角速度をずらすと、軌道が同じ場所へ戻ってこない
      const o = i * 12;
      orbit[o] = Math.cos(az) * cr;
      orbit[o + 1] = INNER * 0.32;
      orbit[o + 2] = 0.052 + rnd() * 0.022;
      orbit[o + 3] = rnd() * Math.PI * 2;
      orbit[o + 4] = cy * INNER * 0.58;
      orbit[o + 5] = INNER * 0.28;
      orbit[o + 6] = 0.037 + rnd() * 0.019;
      orbit[o + 7] = rnd() * Math.PI * 2;
      orbit[o + 8] = Math.sin(az) * cr;
      orbit[o + 9] = INNER * 0.32;
      orbit[o + 10] = 0.048 + rnd() * 0.024;
      orbit[o + 11] = rnd() * Math.PI * 2;
    }

    // --- 傘 ---
    // 素の球から極座標を拾っておき、毎フレームここから形を作り直す
    const proto = new THREE.SphereGeometry(1, 30, 16, 0, Math.PI * 2, 0, THETA_MAX);
    const base = proto.getAttribute('position');
    bellCount = base.count;
    bellTheta = new Float32Array(bellCount);
    bellAz = new Float32Array(bellCount);
    for (let v = 0; v < bellCount; v++) {
      bellTheta[v] = Math.acos(Math.min(1, Math.max(-1, base.getY(v))));
      bellAz[v] = Math.atan2(base.getZ(v), base.getX(v));
    }
    proto.dispose();

    for (let i = 0; i < JELLIES; i++) {
      const n = jelly[i * 5 + 4];
      const geo = new THREE.SphereGeometry(1, 30, 16, 0, Math.PI * 2, 0, THETA_MAX);
      const attr = geo.attributes.position as THREE.BufferAttribute;
      attr.setUsage(THREE.DynamicDrawUsage);
      const mat = new THREE.MeshStandardMaterial({
        color: emberColor(n),
        emissive: emberColor(n * 0.75),
        emissiveIntensity: 0.12,
        roughness: 0.32,
        metalness: 0.05,
        transparent: true,
        opacity: 0.5,
        depthWrite: false, // 傘同士・触手と重なっても輪郭が欠けないように
        side: THREE.DoubleSide,
      });
      const bell = new THREE.Mesh(geo, mat);
      root.add(bell);
      bells.push(bell);
      bellPos.push(attr);
    }

    // --- 触手（珠つなぎ） ---
    beads = new THREE.InstancedMesh(
      new THREE.SphereGeometry(1, 8, 6),
      new THREE.MeshStandardMaterial({
        roughness: 0.4,
        metalness: 0.1,
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
      }),
      BEAD_TOTAL,
    );
    beads.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    root.add(beads);

    // --- 水中の微粒子。水が「詰まっている」ことがこれでわかる ---
    motes = new THREE.InstancedMesh(
      new THREE.SphereGeometry(1, 6, 4),
      new THREE.MeshStandardMaterial({
        color: emberColor(0.3),
        emissive: emberColor(0.45),
        emissiveIntensity: 0.25,
        roughness: 0.6,
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
      }),
      MOTES,
    );
    motes.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < MOTES; i++) {
      // 球の内側へ一様に散らす。立方体で捨てるより偏らない。
      const u = rnd() * 2 - 1;
      const a = rnd() * Math.PI * 2;
      const r = Math.cbrt(rnd()) * (TANK_R - 0.6);
      const s = Math.sqrt(1 - u * u);
      dummy.position.set(Math.cos(a) * s * r, u * r, Math.sin(a) * s * r);
      dummy.scale.setScalar(0.035 + rnd() * 0.05);
      dummy.updateMatrix();
      motes.setMatrixAt(i, dummy.matrix);
    }
    motes.instanceMatrix.needsUpdate = true;
    root.add(motes);

    // --- ガラスの水槽 ---
    // transmission は使わない。three は透過パスに「不透明なものだけ」を描くので、
    // 中身が半透明なこのシーンでは、ガラス越しに何も映らなくなってしまう。
    // 代わりに、灯りを拾って弧を返すだけの薄い殻にしてある。
    const glass = new THREE.Mesh(
      new THREE.SphereGeometry(TANK_R, 72, 48),
      new THREE.MeshPhysicalMaterial({
        color: 0x1a1210,
        roughness: 0.06,
        metalness: 0,
        clearcoat: 1,
        clearcoatRoughness: 0.03,
        transparent: true,
        opacity: 0.28,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    root.add(glass);

    // --- 台と床 ---
    // SURFACE のままだと霧に沈んで台が見えないので、この scene の中でだけ持ち上げる
    const standMat = new THREE.MeshStandardMaterial({
      color: 0x2a1a16,
      roughness: 0.34,
      metalness: 0.7,
    });
    // 上下の口輪。ガラスそのものはほとんど見えないので、この 2 本が
    // 球の軸と大きさを示して、水槽の輪郭を読ませる役をしている。
    const collar = new THREE.Mesh(new THREE.TorusGeometry(3.5, 0.42, 12, 64), standMat);
    collar.rotation.x = Math.PI / 2;
    collar.position.y = -TANK_R * 0.86;
    root.add(collar);

    const neck = new THREE.Mesh(new THREE.TorusGeometry(2.3, 0.26, 12, 64), standMat);
    neck.rotation.x = Math.PI / 2;
    neck.position.y = TANK_R * 0.94;
    root.add(neck);

    const pedestal = new THREE.Mesh(new THREE.CylinderGeometry(3.9, 5.2, 2.2, 48), standMat);
    pedestal.position.y = -TANK_R - 0.5;
    root.add(pedestal);

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(TANK_R * 2.4, 96),
      new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.18, metalness: 0.95 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -TANK_R - 1.6;
    root.add(floor);
  },

  update(t) {
    const hue = drift(t);
    let b = 0;

    for (let i = 0; i < JELLIES; i++) {
      const j = i * 5;
      const size = jelly[j];
      const period = jelly[j + 1];
      const n = jelly[j + 4];

      // 拍。0 で開ききり、0.5 でいちばんすぼまる。
      const phase = t / period + jelly[j + 2];
      const wave = 0.5 - 0.5 * Math.cos(phase * Math.PI * 2);
      const squeeze = Math.pow(wave, 1.5); // 締まる瞬間を鋭く、開く側をゆるく

      // 位置と、進んでいく向き
      const tau = swimAt(i, t, phase, period);
      orbitAt(i, tau, dummy.position);
      orbitAt(i, tau + 0.7, ahead);
      orbitAt(i, tau - 0.7, behind);
      dir.subVectors(ahead, behind).normalize();
      // 真横を向くと傘が潰れて見えるので、わずかに上向きへ寄せる
      dir.addScaledVector(up, 0.3).normalize();
      quat.setFromUnitVectors(up, dir);

      const bell = bells[i];
      panX[i] = dummy.position.x / INNER;
      bell.position.copy(dummy.position);
      bell.quaternion.copy(quat);
      bell.scale.setScalar(size);
      // 触手をこのフレームの姿勢に乗せたいので、描画を待たずに行列を作っておく
      bell.updateMatrix();

      // 縁の位置。触手の付け根になるので、下のループとは別に式で出しておく
      const rimR = Math.sin(THETA_MAX) * (1 - 0.38 * squeeze) * (1 + 0.1 * (1 - squeeze));
      const rimY = Math.cos(THETA_MAX) - 0.55 * squeeze * Math.sin(THETA_MAX);

      // --- 傘の頂点を毎フレーム作り直す ---
      const pos = bellPos[i];
      for (let v = 0; v < bellCount; v++) {
        const th = bellTheta[v];
        const az = bellAz[v];
        const u = th / THETA_MAX; // 0 = 天辺、1 = 縁
        // すぼまると細く、そのぶん縁が下へ伸びる
        let r = Math.sin(th) * (1 - 0.38 * squeeze);
        r *= 1 + 0.1 * (1 - squeeze) * u * u * u; // 開いているときだけ縁が反る
        r *= 1 + 0.035 * Math.sin(az * 3 + t * 1.1 + i); // 生き物らしいむら
        const y = Math.cos(th) - 0.55 * squeeze * Math.sin(th);
        pos.setXYZ(v, Math.cos(az) * r, y, Math.sin(az) * r);
      }
      pos.needsUpdate = true;
      bell.geometry.computeVertexNormals();

      const mat = bell.material;
      ember(mat.color, n, hue);
      ember(mat.emissive, n * 0.75, hue);
      // 締まる瞬間だけ内側が灯る。ブルームで潰れないよう控えめに。
      mat.emissiveIntensity = 0.06 + 0.26 * squeeze;

      // --- 触手。傘の縁からぶら下げ、拍が下へ抜けていく ---
      const spin = tau * 0.02;
      for (let k = 0; k < TENTACLES; k++) {
        const az = (k / TENTACLES) * Math.PI * 2 + spin + i;
        const ca = Math.cos(az);
        const sa = Math.sin(az);
        for (let m = 0; m < BEADS; m++) {
          const d = BEAD_GAP * (m + 1);
          // 波は根元から先へ遅れて伝わる。締まった直後に触手がしなる。
          const sway = Math.sin(phase * Math.PI * 2 - d * 1.6) * 0.16 * d;
          // 縁から真下へ垂らす。先へ行くほどわずかに内へ寄せると束に見える。
          const rad = rimR * (1 - 0.14 * d) + d * 0.05 * (1 - squeeze) + sway;
          local.set(ca * rad, rimY - d * (0.88 + 0.12 * squeeze), sa * rad);
          local.applyMatrix4(bell.matrix);

          dummy.position.copy(local);
          dummy.quaternion.identity();
          dummy.scale.setScalar(size * 0.1 * (1 - (m / BEADS) * 0.5));
          dummy.updateMatrix();
          beads.setMatrixAt(b, dummy.matrix);

          // 先端ほど暗く落として、水に溶けるように見せる
          ember(color, n * (1 - (m / BEADS) * 0.45), hue);
          beads.setColorAt(b, color);
          b++;
        }
      }
    }

    beads.instanceMatrix.needsUpdate = true;
    if (beads.instanceColor) beads.instanceColor.needsUpdate = true;

    // 微粒子はごくゆっくり回して、水が止まっていないことだけ伝える
    motes.rotation.y = t * 0.012;
    motes.rotation.x = Math.sin(t * 0.03) * 0.06;
  },

  sound(t, _dt, sfx) {
    // 水の静けさ。ほとんど聞こえない高さで敷いておく。
    sfx.drone(tone(-6), 0.11);

    for (let i = 0; i < JELLIES; i++) {
      const period = jelly[i * 5 + 1];
      const phase = t / period + jelly[i * 5 + 2];
      // 位相が 0.5 を越えた瞬間 = 傘がいちばんすぼまったところ
      for (let k = ticks[i](phase + 0.5); k > 0; k--) {
        sfx.drop(tone(6 + (i % 4)), {
          gain: 0.17,
          decay: 1.5,
          bend: 0.72,
          pan: panX[i] * 0.7,
        });
      }
    }
  },
};
