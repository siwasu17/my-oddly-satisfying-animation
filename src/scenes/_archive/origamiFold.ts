import * as THREE from 'three';
import type { SceneModule } from '../../types.ts';
import { tone, tickers } from '../../audio.ts';
import { SURFACE, ember, emberColor, drift } from '../../palette.ts';

/**
 * Origami Fold。
 *
 * 十字形の展開図が床に広がっていて、真ん中の面に灯りの珠が一つ置いてある。
 * 前・右・左・奥の順に一枚ずつ 90 度起き上がり、最後に奥の面につながった蓋が倒れて、
 * 灯りを抱えたまま立方体に閉じる。閉じた箱は少し浮いて四分の一だけ向きを変え、
 * 逆の順番でほどけて平面へ戻る。一周 26 秒。向きが毎周 90 度ずつ進むので、
 * 展開図が広がる方向が周ごとに変わる。
 *
 * 蝶番は親子の Group で組んであり、各面の角度は t から毎フレーム決め直す。
 * 音は折れきった瞬間に pluck（折る順に音程が上がる）、閉じきったら air、開ききったら低い drop。
 */

/** 一周の秒数 */
const PERIOD = 26;
/** 立方体の一辺 */
const S = 4.2;
/** 紙の厚み */
const TH = 0.1;
/** 面どうしの隙間（折り目）。閉じたとき継ぎ目から灯りが漏れる */
const GAP = 0.12;
/** 内側の灯りの板の大きさ（面に対する比） */
const INSET = 0.72;
/** 一枚が折れるのにかかる秒数 */
const FOLD_DUR = 1.7;
/** 次の一枚が折れ始めるまでの間隔 */
const FOLD_STEP = 1.3;
/** 折り始め / ほどき始めの時刻 */
const FOLD_START = 2.5;
const UNFOLD_START = 15.6;
/** 閉じた箱が浮いて向きを変える区間と、浮く高さ */
const TURN_START = 10.2;
const TURN_END = 14.6;
const LIFT = 0.9;
/** 床の半径 */
const FLOOR_R = 17;
/** 底面の真ん中に置く灯りの珠の半径 */
const CORE_R = 0.55;

/** 側面の名前。折る順に並べてある（ほどくときは逆順） */
type Side = 'front' | 'right' | 'left' | 'back' | 'top';
const ORDER: Side[] = ['front', 'right', 'left', 'back', 'top'];
/** 各面の紙の色（ember の n）。隣り合う面の見分けがつく程度に振る */
const SHADE: Record<Side | 'bottom', number> = {
  bottom: 0.3, front: 0.42, right: 0.36, left: 0.46, back: 0.33, top: 0.5,
};

const color = new THREE.Color();
const smooth = (x: number): number => {
  const k = Math.min(1, Math.max(0, x));
  return k * k * k * (k * (k * 6 - 15) + 10);
};

let turn: THREE.Group;
const pivots = {} as Record<Side, THREE.Group>;
/** 灯りの板のマテリアル。明るさを t で揺らす */
let glowMats: THREE.MeshStandardMaterial[] = [];
let core: THREE.Mesh;
let coreMat: THREE.MeshStandardMaterial;
let coreLight: THREE.PointLight;

/** その面の折れ具合 0..1（1 = 90 度起きている） */
function foldAmount(u: number, k: number): number {
  const up = smooth((u - (FOLD_START + k * FOLD_STEP)) / FOLD_DUR);
  const down = smooth((u - (UNFOLD_START + (ORDER.length - 1 - k) * FOLD_STEP)) / FOLD_DUR);
  return up - down;
}

/** 紙 1 枚。原点を蝶番に置き、offset の向きへ広がる。内側（+y）に灯りの板を貼る */
function makeFace(parent: THREE.Object3D, side: Side | 'bottom', offset: THREE.Vector3): void {
  const face = new THREE.Group();
  face.position.copy(offset);

  const paper = new THREE.Mesh(
    new THREE.BoxGeometry(S - GAP, TH, S - GAP),
    new THREE.MeshStandardMaterial({ color: emberColor(SHADE[side], 0, -0.02), roughness: 0.78, metalness: 0.05 }),
  );
  face.add(paper);

  const glowMat = new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0 });
  glowMats.push(glowMat);
  const glow = new THREE.Mesh(new THREE.PlaneGeometry(S * INSET, S * INSET), glowMat);
  glow.rotation.x = -Math.PI / 2;
  glow.position.y = TH / 2 + 0.005;
  face.add(glow);

  parent.add(face);
}

let ticks = tickers(ORDER.length * 2);

export const origamiFold: SceneModule = {
  name: 'Origami Fold',
  desc: '十字の展開図が一枚ずつ起き上がり、灯りを抱えた箱に閉じて、またほどける。',
  camera: { pos: [5, 14.5, 12], target: [0, 1.4, -0.9] },

  build(root) {
    ticks = tickers(ORDER.length * 2);
    glowMats = [];

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(FLOOR_R, 96),
      new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.85, metalness: 0.15 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.02;
    root.add(floor);

    // 底面の中心で向きを変える。底面そのものは動かない
    turn = new THREE.Group();
    turn.position.y = TH / 2;
    root.add(turn);
    makeFace(turn, 'bottom', new THREE.Vector3());

    // 箱が抱える灯り。光っているのはこれだけで、面の内側はその照り返しで染まる
    coreMat = new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0 });
    core = new THREE.Mesh(new THREE.SphereGeometry(CORE_R, 32, 16), coreMat);
    core.position.y = TH / 2 + CORE_R;
    turn.add(core);
    coreLight = new THREE.PointLight(0xffb070, 0, S * 2.2, 1.4);
    coreLight.position.y = TH / 2 + CORE_R * 1.4;
    turn.add(coreLight);

    const h = S / 2;
    const hinge = (parent: THREE.Object3D, side: Side, at: THREE.Vector3, out: THREE.Vector3): void => {
      const p = new THREE.Group();
      p.position.copy(at);
      parent.add(p);
      pivots[side] = p;
      makeFace(p, side, out);
    };
    hinge(turn, 'front', new THREE.Vector3(0, 0, h), new THREE.Vector3(0, 0, h));
    hinge(turn, 'back', new THREE.Vector3(0, 0, -h), new THREE.Vector3(0, 0, -h));
    hinge(turn, 'right', new THREE.Vector3(h, 0, 0), new THREE.Vector3(h, 0, 0));
    hinge(turn, 'left', new THREE.Vector3(-h, 0, 0), new THREE.Vector3(-h, 0, 0));
    // 蓋は奥の面の向こう端につながる
    hinge(pivots.back, 'top', new THREE.Vector3(0, 0, -S), new THREE.Vector3(0, 0, -h));
  },

  update(t) {
    const cycle = Math.floor(t / PERIOD);
    const u = t - cycle * PERIOD;
    const q = Math.PI / 2;

    const f = ORDER.map((_, k) => foldAmount(u, k));
    pivots.front.rotation.x = -f[0] * q;
    pivots.right.rotation.z = f[1] * q;
    pivots.left.rotation.z = -f[2] * q;
    pivots.back.rotation.x = f[3] * q;
    pivots.top.rotation.x = f[4] * q;

    // 閉じた箱は浮いて四分の一だけ回り、また降りる。向きは周ごとに積み上がる
    const s = smooth((u - TURN_START) / (TURN_END - TURN_START));
    turn.rotation.y = (cycle + s) * q;
    turn.position.y = TH / 2 + Math.sin(s * Math.PI) * LIFT;

    // 灯りの珠がゆっくり息をする。面の内側は照り返し程度にだけ染める
    const hue = drift(t);
    const breath = 0.5 + 0.5 * Math.sin(t * 0.9);
    ember(color, 0.8 + 0.1 * breath, hue, 0.06);
    coreMat.color.copy(color);
    coreMat.emissive.copy(color).multiplyScalar(0.9 + 0.3 * breath);
    coreLight.intensity = 9 + 3 * breath;
    core.scale.setScalar(0.94 + 0.06 * breath);
    glowMats.forEach((m) => {
      ember(color, 0.7, hue);
      m.color.copy(color);
      m.emissive.copy(color).multiplyScalar(0.22 + 0.08 * breath);
    });
  },

  sound(t, _dt, sfx) {
    ORDER.forEach((_, k) => {
      // 折れきった瞬間（k 枚目）
      const foldEnd = FOLD_START + k * FOLD_STEP + FOLD_DUR * 0.9;
      if (ticks[k]((t - foldEnd) / PERIOD) > 0) {
        if (k === ORDER.length - 1) sfx.air({ gain: 0.28, decay: 1.8, freq: 520, sweep: 0.6 });
        sfx.pluck(tone(5 + k), { gain: 0.26, decay: 2.0, pan: [0, 0.4, -0.4, 0, 0][k] });
      }
      // ほどけきった瞬間
      const openEnd = UNFOLD_START + (ORDER.length - 1 - k) * FOLD_STEP + FOLD_DUR * 0.9;
      if (ticks[ORDER.length + k]((t - openEnd) / PERIOD) > 0) {
        if (k === 0) sfx.drop(tone(0), { gain: 0.35, decay: 0.9 });
        else sfx.pluck(tone(4 + k), { gain: 0.16, decay: 1.4, pan: [0, 0.4, -0.4, 0, 0][k] });
      }
    });
  },
};
