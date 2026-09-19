import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, ticker, tickers } from '../audio.ts';
import { SURFACE, ember, emberColor, drift } from '../palette.ts';

/**
 * 百鬼夜行。
 *
 * 何が動くか: 闇に浮かぶ環状の夜道を、妖怪の行列がひたすら練り歩く。
 * 道は円ではなく、半径と高さに整数倍の波を重ねた閉曲線なので、行列は膨らんだり
 * 窄まったり、丘を越えて上下しながら、必ず元の場所へ帰ってくる。
 * 行列に人魂が寄り添っていて、道の上をふわふわと行き来しながら尾を引いている。
 * 気持ちよさの芯: 行列そのものは律儀に同じ速さで進んでいるのに、人魂だけが
 * その上を勝手気ままに漂っているところ。堅い反復とやわらかい揺らぎが同居する。
 * ループの周期: 行列は およそ 54 秒で一周。人魂の揺れはそれと整数比になっていないので、
 * 同じ絵は戻ってこない（灯りの居場所だけは毎フレーム t から作り直している）。
 * カメラ: 環の全周を必ず画面へ収める。
 *
 * 一体の姿は「平笠をかぶり、黒いマントをまとった人影」。顔も手足も無い。
 * 笠・肩・裾の 3 つだけで人の形を作っている。
 * マントの形はすべて頂点シェーダが毎フレーム組み立てる（CPU 側には戻ってこない）。
 * 笠だけは素の浅い円錐で、マントの首の位置へ毎フレーム載せ直している。
 *
 * 輪郭を人影として読ませているのは次の 3 つ。順に外すと影の塊へ戻る。
 *   - 笠。輪郭の中でいちばん横へ張り出す部分で、型ごとに直径を大きく振ってある。
 *     マントより明るい色を持つ唯一の面でもあり、ここで明暗の差を付けないと、
 *     人影ではなく縦に伸びた霞の塊にしか見えない
 *   - 肩。周方向を尖らせて左右にだけ張り出させる。前後へ出すと胴が一様に太って、
 *     「肩がある」ではなく「太った」に見える
 *   - 裾。肩から下は 1 枚の布として落ちる。縦襞だけを入れて高さ方向には折らない。
 *     高さ方向に折るとくしゃくしゃになって、布ではなくゴミ袋に見える
 *
 * ただし「そこに在る物」としては描かない。物として立たせると、行列が
 * 夜道を歩いてくる絵が生々しくなりすぎて、寝る前に眺めるものではなくなる。
 * 実在感を作っているのは (1) 不透明な面 (2) プラスチックの照り (3) 硬い輪郭線
 * の 3 つなので、その 3 つを順に抜いてある。
 *   (1) 面は透明にし、深度も書かない。視線に対して正面を向いた面をほとんど
 *       透かし、縁だけを残す（フレネル）ので、膜の縁取りしか見えない。
 *       前後の袋が互いに透け、1 体の表と裏も重なって内側がほのかに濁る。
 *   (2) 粗さを 0.97 まで上げて照りを消した。
 *   (3) 裾の切り口は硬いまま残さず、消える手前をなだらかに溶かす。
 *       そのうえで 1 体につき 22 粒の塵をまとわせ、輪郭の線を粒で食わせる。
 *       塵はマントの面の少し外側を巡りながら裾から湧いて、首の高さで消える。
 *       粒は丈の 4 割もある大きさで、1 粒では形が分からないほど薄い。
 *       小さく硬い粒にすると、霞ではなく蛍の群れになってしまう。
 *       笠だけはフレネルを掛けない。この画角では笠をほぼ真上から見下ろすので、
 *       掛けると笠がまるごと消えて人影に読めなくなる。
 *
 * 「環の全周を見せる」と「一体のかたちを読ませる」は画角の上で両立しない。
 * この fov（48°）と環の半径（12±4.4）では、全周を入れると一体は 20〜40px にしかならず、
 * 襞も笠の反りも輪郭としては潰れる。ここでは全周のほうを取った。
 * だから造形の作り分けは「一目で分かる違い」を狙っていない。近づいて見た人にだけ
 * 見える差として置いてあり、遠目には帯の質感のゆらぎとしてだけ効けばよい。
 * 一体を読ませたくなったら、それは画角を変える判断になる（このシーンの芯が変わる）。
 * 音: 手前の鳥居をくぐるたびに遠くで鈴が鳴り、底に地鳴りを敷く。
 * スコープ外: 顔、手足、名前の付く個別の妖怪。そして「一体が何者か分かること」自体。
 * 3 つの型（並み・笠が大きくずんぐり・笠が小さく背が高い）と、体型・襞・
 * 明度の振れで、帯が均質に見えないところまでを担う。
 * 人魂も物理で飛ばさない（軌道は時刻の関数で、粒どうしも干渉しない）。
 * 群れの相互作用も扱わない
 * （並びは道のパラメータの関数なので、追い越しも詰まりも生まれない）。
 *
 * 一体が持っているのは「道のどこにいるか」だけで、位置も向きも毎フレーム
 * その 1 つの式から作り直す。前後の間隔をわずかにばらしてあるので、
 * 列は詰まったり途切れたりしながらも、ひと連なりとしては崩れない。
 * 人魂の尾も同じ考え方で、「その人魂が少し前にいた場所」を時刻を遡って
 * 引き直しているだけ。前フレームの位置を溜め込んでいないので、
 * タブを離れて戻っても尾が絡まらない。
 */

/**
 * 頭数。百鬼と言いつつ 60 体しかいない。
 * 環の全周を画面へ収めたまま一体のかたちを読ませるには、数を減らして
 * 間隔を空けるしかなかった。100 体だと粒が 10〜20px にしかならず、
 * 型を作り分けても階調のばらつきにしか見えない。
 */
const COUNT = 60;
/** 行列が道を一周するのにかかる秒数。 */
const LAP = 54;
/**
 * 道の基準半径。
 * 15 だと環の左右が画面の端に触れて輪が閉じて見えなかった。カメラを引くと
 * 一体がさらに小さくなるので、環のほうを縮めて余白を作っている。
 */
const R = 12;
/** 道幅の半分。 */
const ROAD_W = 1.7;
/** 道を刻む分割数。 */
const SEG = 240;
/**
 * 人魂の数。
 * 増やすほど「どれが主役か」が割れて、ただの光点の散布になる。
 * 明るさを個体ごとに落としてあるので、強く光るのは実際にはこの半分ほど。
 */
const SOULS = 10;
/**
 * 1 つの人魂が引く尾の粒の数。
 * 粒 j は「その人魂が j·TAIL_DT 秒前にいた場所」に置く。位置は時刻の関数なので、
 * 遡るだけで尾が引ける。前フレームの位置を溜め込まずに済む。
 */
const TAIL = 16;
/**
 * 尾の粒 1 つぶんの遡り幅（秒）。
 * 粒の間隔は SOUL_SPEED × これ。粒の「見えている芯」より広げると尾が破線になるので、
 * 数を増やしてでも間隔のほうを詰める。
 */
const TAIL_DT = 0.04;
/**
 * 頭の玉の大きさと、尾の粒の大きさ。
 * PointsMaterial は粒ごとに大きさを変えられないので、頭と尾を別の Points に分けている。
 * 1 つにまとめると全部が同じ太さの線になり、光の玉ではなく画面の傷に見えてしまう。
 */
const CORE_SIZE = 1.5;
const TAIL_SIZE = 1.15;
/** 人魂 1 つが持つ値の数。[道の位置, 周回の半径, 周回の角速度, 位相, 浮く高さ, 明るさ] */
const SOUL_STRIDE = 6;
/**
 * 人魂が漂う速さ（単位/秒）。半径ではなくこちらを固定し、角速度は半径から割り出す。
 * こうすると、大きく回る人魂も小さく回る人魂も同じ速さで動くので、尾の長さが揃う。
 * 角速度のほうを固定すると、半径の違いがそのまま尾の長短になってしまう。
 */
const SOUL_SPEED = 2.4;
/** 人魂に付ける実光源の数。全部に付けると重いので、数個だけ。 */
const LAMPS = 3;
/**
 * 鳥居を置く位置（道のパラメータ 0..1）。
 * ここは道が丘の上でカメラの方へ向き直る地点なので、鳥居が正面から見える。
 */
const GATE = 0.0375;
/** 何体おきに音を鳴らすか。全部鳴らすと団子になる。 */
const SOUND_EVERY = 4;

/**
 * 妖怪 1 体にまとわりつく塵の数。
 * 袋の面を透かしただけでは、輪郭の線がくっきり残って切り抜きに見える。
 * その線の上へ粒を散らして、縁が霧に食われているように見せる。
 */
const DUST_PER = 22;
/**
 * 塵 1 粒の大きさ。
 * 袋の丈（2.3）の 4 割もある。小さくすると 1 粒 1 粒が点として見え、
 * 霞ではなく蛍の群れになってしまう。輪郭が分からないほど大きく引き伸ばし、
 * そのぶん 1 粒を十分に暗くして、重なったところだけが濁るようにする。
 */
const DUST_SIZE = 0.95;
/** 塵 1 粒が持つ値の数。[周りを巡る角度, 湧き始める高さ, のぼる速さ] */
const DUST_STRIDE = 3;

/**
 * 妖怪ごとに持つ値の数。
 * [道の位置, 道幅方向のずれ, 背丈, 歩調, 位相, 横幅の倍率, 揺れる向き, 型, 袋の明度]
 */
const STRIDE = 9;

const TAU = Math.PI * 2;
/** 進行方向を数値微分で拾うときの刻み。 */
const DU = 0.0015;

const dummy = new THREE.Object3D();
const color = new THREE.Color();
const here = new THREE.Vector3();
const ahead = new THREE.Vector3();
/** 人魂の粒 1 つぶんの居場所を受け取る作業用。 */
const wisp = new THREE.Vector3();
/** 笠を載せる場所（マントの首の位置）を受け取る作業用。 */
const perch = new THREE.Vector3();

const oni = new Float32Array(COUNT * STRIDE);
/**
 * 型ごとの笠の大きさ。
 * マントの形を決める値はインスタンス属性としてシェーダへ渡すが、
 * 笠は素のメッシュなので、これだけは CPU 側に残して毎フレームの行列に使う。
 */
const brim = new Float32Array(COUNT);
const soul = new Float32Array(SOULS * SOUL_STRIDE);
const dust = new Float32Array(COUNT * DUST_PER * DUST_STRIDE);

let bodies: THREE.InstancedMesh;
let hats: THREE.InstancedMesh;
let motes: THREE.Points;
let cores: THREE.Points;
let souls: THREE.Points;
let lamps: THREE.PointLight[] = [];

/**
 * 粒に貼る、中心から縁へ向かって消えていく丸。
 * PointsMaterial は map を与えないと四角い点になるので、丸さはここで作る。
 * disposeGroup() はテクスチャまでは破棄しないため、build のたびに作らず
 * モジュールに持たせて使い回す。
 */
const sprites = new Map<string, THREE.CanvasTexture>();

function radialSprite(key: string, stops: [number, number][]): THREE.CanvasTexture {
  const found = sprites.get(key);
  if (found) return found;
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [at, alpha] of stops) g.addColorStop(at, `rgba(255,255,255,${alpha})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  sprites.set(key, tex);
  return tex;
}

/**
 * 人魂の粒。
 * 中心の減衰を急にすると、粒の「見えている芯」が点の大きさより遥かに小さくなり、
 * 粒を並べても連続した筋にならず破線に見える。手前をなだらかに保つ。
 */
const wispSprite = (): THREE.CanvasTexture =>
  radialSprite('wisp', [
    [0, 1],
    [0.5, 0.55],
    [1, 0],
  ]);

/**
 * 塵の粒。
 * 人魂と同じ描き方をすると、芯がはっきりして蛍の群れに見えてしまう。
 * 中心をあらかじめ薄くし、そこから長く尾を引かせて、
 * 1 粒だけでは「どこからどこまでが粒か」が分からない霞にしておく。
 */
const hazeSprite = (): THREE.CanvasTexture =>
  radialSprite('haze', [
    [0, 0.5],
    [0.3, 0.3],
    [0.65, 0.09],
    [1, 0],
  ]);

/** 一体ごとに、鳥居をくぐった回数を数える */
let ticks = tickers(COUNT);
/** 風がひと吹きする間隔を数える */
let tickWind = ticker();

/** 道の上の点を out に書き込む。u は 0..1 で、1 増えるとちょうど一周する。 */
function roadAt(u: number, out: THREE.Vector3): THREE.Vector3 {
  const a = u * TAU;
  // 半径と高さに整数倍の波だけを重ねてあるので、一周すれば必ず元へ戻る
  const r = R + 3.0 * Math.sin(a * 3) + 1.4 * Math.sin(a * 5 + 0.7);
  const y = 2.1 + 1.15 * Math.sin(a * 2 + 0.4) + 0.62 * Math.sin(a * 5 + 1.9);
  return out.set(Math.cos(a) * r, y, Math.sin(a) * r);
}

/**
 * 人魂 s が時刻 tt にいる場所を out に書き込む。
 *
 * 行列と同じ速さで道を進みながら、道の上を水平に周回し、ゆっくり浮き沈みする。
 * tt を遡って呼べば「少し前にいた場所」が返る。尾はこれで引く。
 *
 * 尾の長さを揃えるのに、2 つのことが要る。
 * 1. 揺れを正弦波で作らない。正弦波は折り返しで速度がゼロになるので、そこに
 *    居合わせた人魂だけ尾が縮んで、玉が 1 つ浮いているようにしか見えなくなる。
 * 2. 周回の面を水平に取る。「道の法線 × 鉛直」の面で回すと、環の手前と奥では
 *    その面が視線の方を向き、軌道が真横から見た線に潰れて画面上から尾が消える。
 *    水平な輪なら、俯瞰しているかぎりどこでも楕円として見える。
 *
 * 周回の速さを行列の一周（LAP 秒）と整数比にしていないので、同じ並びには戻らない。
 */
function soulAt(s: number, tt: number, out: THREE.Vector3): THREE.Vector3 {
  const o = s * SOUL_STRIDE;
  const u = tt / LAP + soul[o]!;
  roadAt(u, here);
  roadAt(u + DU, ahead);
  const dx = ahead.x - here.x;
  const dz = ahead.z - here.z;
  const len = Math.hypot(dx, dz) || 1;
  const tx = dx / len;
  const tz = dz / len;

  const rad = soul[o + 1]!;
  const ang = tt * soul[o + 2]! + soul[o + 3]!;
  // 道幅の外まではみ出す水平な輪。行列の上を横切って戻ってくるように見える
  const across = Math.cos(ang) * rad;
  const along = Math.sin(ang) * rad;
  // 浮き沈みは周回よりずっと遅く。尾の長さには効かせない
  const lift = soul[o + 4]! + Math.sin(tt * 0.37 + soul[o + 3]!) * 0.7;

  return out.set(
    here.x + tz * across + tx * along,
    here.y + lift,
    here.z - tx * across + tz * along,
  );
}

/**
 * マントの丈。裾から肩（首の付け根）まで。笠はこの上に載る。
 *
 * 裾の直径は太いところで 1.3 前後あるので、丈をここまで取ってようやく
 * 縦横比が 1.8 に届く。これより縮めると、歩く団子にしか見えない。
 */
const CLOAK_H = 2.15;
/**
 * マントを刻む数。縦（裾から首まで）と横（周回り）。
 * 襞は周回り 11 波まで入れてあるので、横はその 2 倍以上ないと襞が消える。
 */
const CLOAK_RINGS = 22;
const CLOAK_SEGS = 32;
/** 裾が閉じる位置。ここから下は底として塞がる。 */
const CLOAK_FLOOR = -0.08;

/**
 * 体が左右前後へ振れる幅（首の高さで）。
 * シェーダが布を振り、CPU が同じ式で笠を振る。片方だけ直すと笠が首から外れる。
 */
const SWAY_X = 0.16;
const SWAY_Z = 0.13;

/** 笠の半径と厚み（笠の丈）。平笠なので、半径に対してごく浅い。 */
const HAT_R = 0.38;
const HAT_H = 0.17;
/**
 * 笠を載せる高さ（マントの丈に対する割合）。
 * 頭巾のふくらみ（0.84〜0.94）に縁が食い込むところまで下げる。
 * 上げると縁と頭巾のあいだに首が覗いて、笠が宙に浮いて見える。
 */
const HAT_AT = 0.87;

/**
 * 型ごとの姿。[首のすぼまり, 頭巾のふくらみ, 笠の大きさ]
 *
 * 0 = 並み、1 = 笠が大きくずんぐりした者、2 = 笠が小さく痩せて背の高い者。
 * 遠景で効くのは面の明暗ではなく輪郭なので、笠の直径を型ごとに大きく振ってある。
 * 笠は輪郭の中でいちばん横に張り出す部分なので、ここが違えば影の形が違って見える。
 */
const CLOAK_KIND: [number, number, number][] = [
  [0.72, 0.11, 1.0],
  [0.62, 0.14, 1.18],
  [0.8, 0.07, 0.8],
];

/**
 * マントの太さ。h は 0 が裾、1 が首。
 *
 * **下の GLSL 版と骨格だけ揃えてある。** こちらは外接球と塵の居場所に使い、
 * 実際に描かれる形（襞・肩・頭巾・ひるがえり）はシェーダ側が作る。
 */
function cloakRadius(h: number): number {
  const k = h < 0 ? 0 : h > 1 ? 1 : h;
  // 裾へ向かって広がる A ライン
  let r = 0.24 + 0.3 * Math.pow(1 - k, 1.6);
  // 肩から上を首としてすぼめる。型のうちいちばん細いものに合わせておけば足りる
  r *= 1 - smoothstep(0.6, 0.86, k) * 0.62;
  // 裾の下で閉じる
  return r * smoothstep(CLOAK_FLOOR, 0.02, h);
}

function smoothstep(a: number, b: number, x: number): number {
  const t = (x - a) / (b - a);
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  return k * k * (3 - 2 * k);
}

/**
 * マントの骨格。回転体の格子だけを置き、実際の形は頂点シェーダが作る。
 *
 * 頂点は位置ではなく「周方向の角度 aAng」と「裾からの高さ aH」を持つ。
 * シェーダはその 2 つから毎フレーム形を組み立て直すので、襞も肩の張りも
 * 歩くたびのひるがえりも、CPU 側には一切戻ってこない。
 */
function buildCloak(): THREE.BufferGeometry {
  const vCount = (CLOAK_RINGS + 1) * (CLOAK_SEGS + 1);
  const pos = new Float32Array(vCount * 3);
  const nor = new Float32Array(vCount * 3);
  const ang = new Float32Array(vCount);
  const hgt = new Float32Array(vCount);
  const idx = new Uint16Array(CLOAK_RINGS * CLOAK_SEGS * 6);

  for (let i = 0; i <= CLOAK_RINGS; i++) {
    const h = CLOAK_FLOOR + (1 - CLOAK_FLOOR) * (i / CLOAK_RINGS);
    const r = cloakRadius(h);
    for (let j = 0; j <= CLOAK_SEGS; j++) {
      const a = (j / CLOAK_SEGS) * TAU;
      const v = i * (CLOAK_SEGS + 1) + j;
      // シェーダが上書きするので、ここは素の回転体のままでよい
      pos[v * 3] = Math.cos(a) * r;
      pos[v * 3 + 1] = h * CLOAK_H;
      pos[v * 3 + 2] = Math.sin(a) * r;
      nor[v * 3] = Math.cos(a);
      nor[v * 3 + 2] = Math.sin(a);
      ang[v] = a;
      hgt[v] = h;
    }
  }

  let k = 0;
  for (let i = 0; i < CLOAK_RINGS; i++) {
    for (let j = 0; j < CLOAK_SEGS; j++) {
      const a0 = i * (CLOAK_SEGS + 1) + j;
      const a1 = a0 + 1;
      const b0 = a0 + CLOAK_SEGS + 1;
      const b1 = b0 + 1;
      idx[k++] = a0;
      idx[k++] = b0;
      idx[k++] = a1;
      idx[k++] = a1;
      idx[k++] = b0;
      idx[k++] = b1;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('aAng', new THREE.BufferAttribute(ang, 1));
  geo.setAttribute('aH', new THREE.BufferAttribute(hgt, 1));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  return geo;
}

/** マントのシェーダが読む時刻。update() から毎フレーム入れ直す。 */
const cloakTime = { value: 0 };

/**
 * 霞へほどけた薄い膜として布を描くための共通の設定。
 * マントと笠で同じ透け方にしておかないと、笠だけが物として立って浮く。
 */
function veilMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    // 照りを消す。つるつるに寄せると人魂の灯りが布の上を滑って
    // 「そこに在る物」になってしまう。ここでは物として立たせたくない
    roughness: 0.97,
    metalness: 0,
    // 裾の内側が覗くので、裏面も描く
    side: THREE.DoubleSide,
    // 薄い膜として重ねる。深度を書かないので、前後の影が互いに透けて、
    // 1 体の表と裏がひとりでに重なって内側がほのかに濁る
    transparent: true,
    depthWrite: false,
  });
}

/**
 * マントの材。`MeshStandardMaterial` に頂点シェーダとフラグメントシェーダを差し込む。
 *
 * 素の three の照明とブルームをそのまま使いたいので、`ShaderMaterial` で
 * 書き下ろさずに `onBeforeCompile` で組み込みのチャンクを置き換えている。
 *
 * 位置を動かすと法線が合わなくなるので、形を返す関数 cloakPoint() を 3 回呼び、
 * 角度方向と高さ方向へずらした点との外積から法線を作り直している。
 * こうしないと、襞や肩の張りのところで陰影が裏返る。
 */
function cloakMaterial(): THREE.MeshStandardMaterial {
  const mat = veilMaterial();

  /**
   * これが無いと差し込んだコードが効かないことがある。
   * three はコンパイル済みプログラムをマテリアルの「パラメータ」で引いたキャッシュから
   * 引き当てるが、そのキーに onBeforeCompile の中身は入らない。パラメータが同じ
   * マテリアル（ここでは笠）が他にあると、そちらのプログラムが使い回されて、
   * マントが素の回転体のまま描かれる。
   */
  mat.customProgramCacheKey = () => 'nightParade-cloak';

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = cloakTime;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `
        #include <common>
        uniform float uTime;
        attribute float aAng;
        attribute float aH;
        attribute float aPhase;
        attribute float aGait;
        attribute float aNeck;
        attribute float aHood;
        attribute float aSwirl;
        attribute float aSeed;
        // 裾の溶かし方に使う。x = 周方向の角度, y = 裾からの高さ, z = 個体の種
        varying vec3 vCloak;
        vec3 cloakPos;

        vec3 cloakPoint(float a, float h) {
          float k = clamp(h, 0.0, 1.0);

          // 裾へ向かって広がる A ライン。肩から下は 1 枚の布として落ちる
          float r = 0.24 + 0.30 * pow(1.0 - k, 1.6);
          // 肩から上を首としてすぼめる
          r *= 1.0 - smoothstep(0.60, 0.86, k) * aNeck;
          // 肩。左右にだけ張り出させる。周方向を尖らせて（3 乗）前後へは出さないので、
          // 胴が一様に太るのではなく「肩がある」と読める
          float sh = smoothstep(0.48, 0.60, k) * (1.0 - smoothstep(0.62, 0.74, k));
          r *= 1.0 + sh * 0.30 * pow(abs(cos(a)), 3.0);
          // 頭巾のふくらみ。笠の下に頭がある、と見せるためだけの小さな瘤
          r += smoothstep(0.84, 0.94, k) * (1.0 - smoothstep(0.94, 1.02, k)) * aHood;
          // 裾の下で閉じる
          r *= smoothstep(${CLOAK_FLOOR.toFixed(2)}, 0.02, h);

          // 布の縦襞。裾へ向かって深くなる。
          // 袋のくしゃくしゃと違って、高さ方向にはほとんど折れない。
          // 縦に通る筋だけにしておくのが「垂れた布」に見せるこつ
          float low = 1.0 - k;
          low *= low;
          r *= 1.0
            + low * 0.13 * sin(a * 6.0 + aSeed)
            + low * 0.06 * sin(a * 11.0 - aSeed * 2.1)
            + 0.03 * sin(a * 3.0 - k * 2.0 + aSeed * 1.7);

          // 歩くたびに裾がひるがえる
          r *= 1.0 + low * 0.16 * sin(uTime * aGait * 0.5 + a * 2.0 + aSeed);

          // 裾がゆっくり渦を巻く。上ではなく下をねじるので、翻った布に見える
          float a2 = a + aSwirl * low;

          vec3 p = vec3(cos(a2) * r, h * ${CLOAK_H.toFixed(2)}, sin(a2) * r);

          // ゆらゆら。裾を軸にして上ほど大きく振れる。
          // 2 つの周期を直交する向きに当てているので、まっすぐ前後には揺れない
          float s = k * k;
          p.x += s * ${SWAY_X.toFixed(2)} * sin(uTime * aGait * 0.33 + aPhase);
          p.z += s * ${SWAY_Z.toFixed(2)} * sin(uTime * aGait * 0.27 + aPhase * 1.7 + 1.1);
          return p;
        }
      `,
      )
      .replace(
        '#include <beginnormal_vertex>',
        /* glsl */ `
        cloakPos = cloakPoint(aAng, aH);
        vec3 clA = cloakPoint(aAng + 0.03, aH);
        vec3 clH = cloakPoint(aAng, aH + 0.03);
        vec3 objectNormal = normalize(cross(clH - cloakPos, clA - cloakPos));
        vCloak = vec3(aAng, aH, aSeed);
      `,
      )
      .replace('#include <begin_vertex>', 'vec3 transformed = cloakPos;');

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `
        #include <common>
        varying vec3 vCloak;
      `,
      )
      .replace(
        '#include <clipping_planes_fragment>',
        /* glsl */ `
        #include <clipping_planes_fragment>
        // 裾の縁の溶け具合。下で計算して、いちばん最後の合成で透明度に掛ける
        float hemA = 1.0;
        {
          float a = vCloak.x;
          float h = vCloak.y;
          float sd = vCloak.z;

          // 裾の縁。周方向にうねる高さで切り落とすので、下端が個体ごとに違う。
          // 袋のときのような深い裂けは入れない。布の裾はまっすぐ落ちているほうが
          // 「まとっている」に見えて、ぎざぎざが勝つとまたゴミ袋に戻る
          float n = 0.50 * sin(a * 4.0 + sd * 3.1)
                  + 0.32 * sin(a * 7.0 - sd * 1.7)
                  + 0.18 * sin(a * 13.0 + sd * 5.3);
          float hem = 0.02 + 0.05 * (0.5 + 0.5 * n);
          if (h < hem) discard;
          // 切り口をそのまま残すと縁が硬くて「切り抜いた物」に見える。
          // 消える手前をなだらかにして、裾が霧へ溶けていくようにする
          hemA *= smoothstep(hem, hem + 0.09, h);
        }
      `,
      )
      .replace(
        '#include <opaque_fragment>',
        /* glsl */ `
        {
          // 面をまっすぐ向いているところを透かし、視線と平行になる縁を濃く残す。
          // ただし透かしすぎてはいけない。縁だけになると中が空いた殻に見えて、
          // 裾がどこまで広がっているのかが読めず、人影の三角形が立たなくなる
          float fres = 1.0 - abs(dot(normalize(normal), normalize(vViewPosition)));
          diffuseColor.a *= hemA * mix(0.30, 0.52, pow(fres, 1.2));
        }
        #include <opaque_fragment>
      `,
      );
  };

  return mat;
}

/**
 * 平笠。浅い円錐ひとつ。
 *
 * マントと同じ透け方の材を使うが、フレネルは掛けない。
 * この画角では笠をほぼ真上から見下ろすことになり、面が視線を向くので、
 * フレネルを掛けると笠だけがまるごと消えてしまう。
 * 輪郭の中でいちばん横に張り出す部分なので、消えると人影に読めなくなる。
 */
function hatMaterial(): THREE.MeshStandardMaterial {
  const mat = veilMaterial();
  mat.opacity = 0.3;
  return mat;
}

/** 道を帯として起こす。ほぼ水平なので、法線は上向きで足りる。 */
function buildRoad(): THREE.Mesh {
  const pos = new Float32Array(SEG * 2 * 3);
  const nor = new Float32Array(SEG * 2 * 3);
  const idx = new Uint16Array(SEG * 6);

  for (let i = 0; i < SEG; i++) {
    roadAt(i / SEG, here);
    roadAt((i + 1) / SEG, ahead);
    const dx = ahead.x - here.x;
    const dz = ahead.z - here.z;
    const len = Math.hypot(dx, dz) || 1;
    const nx = dz / len;
    const nz = -dx / len;

    const o = i * 6;
    pos[o] = here.x + nx * ROAD_W;
    pos[o + 1] = here.y - 0.06;
    pos[o + 2] = here.z + nz * ROAD_W;
    pos[o + 3] = here.x - nx * ROAD_W;
    pos[o + 4] = here.y - 0.06;
    pos[o + 5] = here.z - nz * ROAD_W;
    nor[o + 1] = 1;
    nor[o + 4] = 1;

    const a0 = i * 2;
    const a1 = i * 2 + 1;
    const b0 = ((i + 1) % SEG) * 2;
    const b1 = ((i + 1) % SEG) * 2 + 1;
    const j = i * 6;
    idx[j] = a0;
    idx[j + 1] = b0;
    idx[j + 2] = a1;
    idx[j + 3] = a1;
    idx[j + 4] = b0;
    idx[j + 5] = b1;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));

  return new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({
      color: SURFACE,
      roughness: 0.42,
      metalness: 0.75,
      side: THREE.DoubleSide,
    }),
  );
}

/** 行列がくぐる鳥居。道の GATE の地点に、進行方向へ向けて立てる。 */
function buildGate(): THREE.Group {
  roadAt(GATE, here);
  roadAt(GATE + DU, ahead);
  /**
   * 道の面からの高さ。
   *
   * 柱を地面（y=0）から立ててはいけない。鳥居を置いているのは丘の上で、
   * 道はそこで 3 ほど持ち上がっている。地面から立てると柱の下半分が道より下に伸び、
   * 行列が鳥居の中ほどをくぐっているように見えてしまう。
   *
   * 高さは、いちばん背の高い妖怪が貫に当たらないところから決める。
   * マントの丈は 2.15、背丈の倍率の上限は 1.10 なので首まで約 2.4。笠を載せて約 2.5。
   * 歩調の弾みと上端のゆらぎを足しても 2.8 には届かない。貫をその上（2.95）へ置くと、
   * 桁まで 3.8 要る。これ以上高くすると、並みの背丈の妖怪に対して門が過大に見える。
   */
  const top = 3.8;
  /**
   * 柱の間隔（半分）。道幅（1.7）に近づけないと、柱の足元に道が無くなって
   * 宙に立って見える。とはいえ狭くしすぎると、道幅いっぱいに広がった妖怪が
   * 柱をすり抜ける。妖怪の横方向の広がりは最大でも 1.5 なので、その外側へ置く。
   */
  const half = ROAD_W + 0.3;
  /** 柱を道の面より少しだけ下へ伸ばして、足元が浮いて見えないようにする。 */
  const foot = 0.4;

  const gate = new THREE.Group();
  gate.position.set(here.x, here.y - 0.06, here.z);
  // Y 回転をこう取ると、局所 +Z が進行方向、局所 +X が道幅方向になる
  gate.rotation.y = Math.atan2(ahead.x - here.x, ahead.z - here.z);

  const mat = new THREE.MeshStandardMaterial({
    color: emberColor(0.3),
    roughness: 0.62,
    metalness: 0.25,
  });

  for (const side of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.3, top + foot, 0.3), mat);
    post.position.set(half * side, top / 2 - foot / 2, 0);
    gate.add(post);
  }
  const kasagi = new THREE.Mesh(new THREE.BoxGeometry(half * 2 + 1.1, 0.24, 0.36), mat);
  kasagi.position.y = top;
  gate.add(kasagi);
  const nuki = new THREE.Mesh(new THREE.BoxGeometry(half * 2 + 0.3, 0.16, 0.24), mat);
  nuki.position.y = top - 0.85;
  gate.add(nuki);

  return gate;
}

/** 霞にほどけかけた笠とマントの人影が、うねる夜道をどこまでも巡っていく。 */
export const nightParade: SceneModule = {
  name: 'Night Parade',
  desc: '闇の環を練り歩く笠とマントの人影に、人魂が尾を引いて寄り添い漂う。',
  // 俯瞰しすぎると鳥居が潰れるので、環が見える高さぎりぎりまで下げている
  camera: { pos: [0, 15, 30], target: [0, 1.2, 0] },

  build(root) {
    ticks = tickers(COUNT);
    tickWind = ticker();
    dummy.rotation.order = 'YXZ';

    // 固定シード。開き直しても同じ顔ぶれの行列になる
    let s = 0.4137;
    const rnd = (): number => (s = (s * 9301 + 0.49297) % 1);

    // マントの形を決める値は、個体ごとに 1 度だけ決めてシェーダへ渡す。
    // 毎フレーム CPU から送り直す必要がないので、インスタンス属性として持たせる
    const phase = new Float32Array(COUNT);
    const gait = new Float32Array(COUNT);
    const neck = new Float32Array(COUNT);
    const hood = new Float32Array(COUNT);
    const swirl = new Float32Array(COUNT);
    const seed = new Float32Array(COUNT);

    for (let i = 0; i < COUNT; i++) {
      const o = i * STRIDE;
      // 等間隔を基本にしつつ前後へ散らすと、詰まりと隙間ができて行列らしくなる
      oni[o] = (i + rnd() * 0.6 - 0.3) / COUNT;
      // 道幅いっぱいまで散らすと、鳥居の柱に触れる個体が出る
      oni[o + 1] = (rnd() * 2 - 1) * (ROAD_W - 0.8);
      const size = 0.55 + rnd() * 0.55;
      oni[o + 3] = 5.0 + rnd() * 2.8;
      oni[o + 4] = rnd() * TAU;
      // 背丈と横幅を逆に振る。背の高いものは痩せ、低いものは横に広がる。
      // 広げすぎると、背の低い個体の幅が丈に並んで歩く団子に見える
      const wide = 1.1 - 0.26 * ((size - 0.55) / 0.55) + (rnd() * 0.14 - 0.07);
      // 体を揺らす向き。左右に割れると、列全体が一方向へ揃って揺れない
      oni[o + 6] = rnd() < 0.5 ? -1 : 1;
      const k = rnd();
      const kind = k < 0.3 ? 1 : k < 0.52 ? 2 : 0;
      oni[o + 7] = kind;
      // 型 1（ずんぐり）だけは丈と幅も振り直す。輪郭の差は形の式より先に効く
      oni[o + 2] = kind === 1 ? size * 0.88 : size;
      oni[o + 5] = kind === 1 ? wide * 1.14 : wide;
      // マントの明度のオフセット。狭いと帯が一色に貼り付くので、広めに振る
      oni[o + 8] = rnd() * 0.22 - 0.05;

      const preset = CLOAK_KIND[kind]!;
      phase[i] = oni[o + 4]!;
      gait[i] = oni[o + 3]!;
      neck[i] = preset[0] + (rnd() * 0.12 - 0.06);
      hood[i] = preset[1] + rnd() * 0.03;
      // 笠の大きさ。型で大きく振ったうえに、個体ごとの揺らぎを足す
      brim[i] = preset[2] * (0.92 + rnd() * 0.16);
      // 裾の渦。袋のねじれと違って、ごく浅く。強く掛けると布が絞られて袋に戻る
      swirl[i] = (0.1 + rnd() * 0.2) * (rnd() < 0.5 ? -1 : 1);
      // 襞と裾の種。ここが個体ごとに違うから、同じ影が二つと無い
      seed[i] = rnd() * TAU;
    }

    for (let s = 0; s < SOULS; s++) {
      const o = s * SOUL_STRIDE;
      // 行列の全長へばらまく。等間隔から少し外すと、寄り集まる場所ができる
      soul[o] = (s + rnd() * 0.7 - 0.35) / SOULS;
      const rad = 1.3 + rnd() * 1.4;
      soul[o + 1] = rad;
      // 角速度は半径から割り出す。どの人魂も SOUL_SPEED で動くので尾が揃う
      soul[o + 2] = SOUL_SPEED / rad;
      soul[o + 3] = rnd() * TAU;
      soul[o + 4] = 1.5 + rnd() * 2.1;
      // 明るさに段を付ける。全部が同じ強さだと、どれが主役か割れてしまう
      soul[o + 5] = 0.5 + rnd() * 0.5;
    }

    for (let m = 0; m < COUNT * DUST_PER; m++) {
      const o = m * DUST_STRIDE;
      dust[o] = rnd() * TAU;
      dust[o + 1] = rnd();
      // のぼる速さを粒ごとに変える。揃えると層になって上がり、煙ではなく帯に見える
      dust[o + 2] = 0.035 + rnd() * 0.075;
    }

    // マント。形は頂点シェーダが作るので、ここでは骨格と個体ごとの値だけ渡す
    const cloak = buildCloak();
    cloak.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase, 1));
    cloak.setAttribute('aGait', new THREE.InstancedBufferAttribute(gait, 1));
    cloak.setAttribute('aNeck', new THREE.InstancedBufferAttribute(neck, 1));
    cloak.setAttribute('aHood', new THREE.InstancedBufferAttribute(hood, 1));
    cloak.setAttribute('aSwirl', new THREE.InstancedBufferAttribute(swirl, 1));
    cloak.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 1));

    bodies = new THREE.InstancedMesh(cloak, cloakMaterial(), COUNT);
    bodies.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // 襞とゆらぎでシェーダが外へ膨らむので、CPU 側の外接球では足りない
    bodies.frustumCulled = false;
    root.add(bodies);

    // 平笠。頂点は動かさないので、素の円錐をそのまま並べる。
    // 頂点を原点に持ってきてあるので、笠の縁が首の高さに来る
    const cone = new THREE.ConeGeometry(HAT_R, HAT_H, 14);
    cone.translate(0, HAT_H / 2, 0);
    hats = new THREE.InstancedMesh(cone, hatMaterial(), COUNT);
    hats.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    hats.frustumCulled = false;
    root.add(hats);

    // 人魂。粒は光そのものなので加算合成で重ね、深度も書かない。
    // 尾が重なったところが自然に明るくなり、ブルームがそこを芯として拾う
    const wispPoints = (count: number, size: number, tex: THREE.CanvasTexture): THREE.Points => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
      geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
      const points = new THREE.Points(
        geo,
        new THREE.PointsMaterial({
          size,
          map: tex,
          vertexColors: true,
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          sizeAttenuation: true,
        }),
      );
      // 粒は道の外まで漂うので、視錐台の判定を切って端で消えないようにする
      points.frustumCulled = false;
      return points;
    };

    // 人影にまとわりつく塵。マントの面の少し外側を巡りながら立ちのぼって消える
    motes = wispPoints(COUNT * DUST_PER, DUST_SIZE, hazeSprite());
    root.add(motes);

    // 尾を先に足して、頭の玉をその上へ重ねる
    souls = wispPoints(SOULS * TAIL, TAIL_SIZE, wispSprite());
    root.add(souls);
    cores = wispPoints(SOULS, CORE_SIZE, wispSprite());
    root.add(cores);

    // 人魂のいくつかに実光源を持たせる。通り過ぎたところだけ道と人影が明るむ
    lamps = [];
    for (let k = 0; k < LAMPS; k++) {
      const lamp = new THREE.PointLight(0xffa055, 26, 20, 2);
      lamps.push(lamp);
      root.add(lamp);
    }

    root.add(buildRoad());
    root.add(buildGate());

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(R * 2.4, 96),
      new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.3, metalness: 0.92 }),
    );
    floor.rotation.x = -Math.PI / 2;
    root.add(floor);
  },

  update(t) {
    const hue = drift(t);
    // マントの形はシェーダが t から作り直す。CPU 側は時刻を渡すだけ
    cloakTime.value = t;
    // 行列の先頭が道のどこにいるか。各自の位置に足すだけで、全員が同じ速さで進む
    const head = t / LAP;

    const mpos = motes.geometry.attributes.position as THREE.BufferAttribute;
    const mcol = motes.geometry.attributes.color as THREE.BufferAttribute;

    for (let i = 0; i < COUNT; i++) {
      const o = i * STRIDE;
      const size = oni[o + 2]!;
      const wide = oni[o + 5]!;
      const hand = oni[o + 6]!;
      const gait = t * oni[o + 3]! + oni[o + 4]!;

      const u = head + oni[o]!;
      roadAt(u, here);
      roadAt(u + DU, ahead);
      const dx = ahead.x - here.x;
      const dz = ahead.z - here.z;
      const len = Math.hypot(dx, dz) || 1;
      const tx = dx / len;
      const tz = dz / len;
      const nx = tz;
      const nz = -tx;

      const side = oni[o + 1]!;
      const bob = Math.abs(Math.sin(gait)) * 0.17 * size;
      const x = here.x + nx * side;
      // 裾の縁は少し切り落としてあるので、そのぶんマントを道へ埋める。
      // 埋めないと、下端と道のあいだに隙間が空いて宙に浮く
      const y = here.y + bob - 0.06 * size;
      const z = here.z + nz * side;
      const yaw = Math.atan2(tx, tz);
      const lean = -0.05 - Math.sin(gait * 2) * 0.045;
      const roll = Math.sin(gait) * 0.12 * hand;

      // マント。丈と太さを別々に掛けるので、痩せた背高と低い横広が混ざる
      dummy.position.set(x, y, z);
      dummy.rotation.set(
        lean, // 前のめりに、一歩ごとに頷く
        yaw,
        roll, // 左右の揺れ。踏み出す足が個体ごとに逆になる
      );
      dummy.scale.set(size * wide, size, size * wide);
      dummy.updateMatrix();
      bodies.setMatrixAt(i, dummy.matrix);

      // マントは闇に近い色。個体ごとのオフセットに、歩調ぶんの明暗を足す。
      // ここを上げると黒衣ではなく「赤い服」に見え始める。
      // 面の色は沈めておいて、明るみは人魂の灯りだけに作らせるほうがよい
      ember(color, 0.11 + oni[o + 8]! * 0.6 + 0.05 * (0.5 + 0.5 * Math.sin(gait)), hue);
      bodies.setColorAt(i, color);

      // 平笠。マントの行列をそのまま使って、首の位置を世界へ持ち上げる。
      // 首はシェーダの中で振れているので、同じ式でずらしてから変換する。
      // 位置だけ別に組み立てると、歩くたびに笠が首から外れて宙に残る
      perch.set(
        SWAY_X * Math.sin(t * oni[o + 3]! * 0.33 + oni[o + 4]!),
        CLOAK_H * HAT_AT,
        SWAY_Z * Math.sin(t * oni[o + 3]! * 0.27 + oni[o + 4]! * 1.7 + 1.1),
      );
      perch.applyMatrix4(dummy.matrix);
      dummy.position.copy(perch);
      dummy.rotation.set(lean, yaw, roll);
      // 笠は横幅の倍率を掛けない。掛けると、ずんぐりした個体の笠だけが楕円に潰れる
      dummy.scale.setScalar(size * brim[i]!);
      dummy.updateMatrix();
      hats.setMatrixAt(i, dummy.matrix);

      // 笠はマントより明るく。黒衣の上に載る唯一の明るい面なので、
      // ここで差を付けないと、人影ではなく縦に伸びた霞の塊にしか見えない
      ember(color, 0.24 + oni[o + 8]! * 0.5, hue);
      hats.setColorAt(i, color);

      // 塵。マントの面の少し外側を巡りながら、裾から湧いて首の高さで消える。
      // 位置はマントの輪郭（cloakRadius）から取っているので、痩せた個体には塵も細く付く
      const cy = Math.cos(yaw);
      const sy = Math.sin(yaw);
      for (let m = 0; m < DUST_PER; m++) {
        const d = (i * DUST_PER + m) * DUST_STRIDE;
        // のぼりきったらまた裾へ戻る。粒ごとに速さが違うので層にならない
        const h = (dust[d + 1]! + t * dust[d + 2]!) % 1;
        const a = dust[d]! + t * 0.22;
        // 面のすぐ外側。息をするように離れたり寄ったりする
        const rr = cloakRadius(h) * wide * size * (1.2 + 0.34 * Math.sin(t * 0.8 + dust[d]!));
        const lx = Math.cos(a) * rr;
        const lz = Math.sin(a) * rr;
        const g = i * DUST_PER + m;
        mpos.setXYZ(g, x + lx * cy + lz * sy, y + h * CLOAK_H * size, z - lx * sy + lz * cy);

        // 湧き際と消え際を絞る。いきなり現れて消えると、粒が点滅しているように見える
        const f = smoothstep(0, 0.12, h) * (1 - smoothstep(0.5, 1, h));
        ember(color, 0.26, hue);
        color.multiplyScalar(f * 0.5);
        mcol.setXYZ(g, color.r, color.g, color.b);
      }
    }
    mpos.needsUpdate = true;
    mcol.needsUpdate = true;

    // 人魂。尾の粒 j は「その人魂が j·TAIL_DT 秒前にいた場所」
    const pos = souls.geometry.attributes.position as THREE.BufferAttribute;
    const col = souls.geometry.attributes.color as THREE.BufferAttribute;
    const cpos = cores.geometry.attributes.position as THREE.BufferAttribute;
    const ccol = cores.geometry.attributes.color as THREE.BufferAttribute;

    for (let s = 0; s < SOULS; s++) {
      const o = s * SOUL_STRIDE;
      // 息をするように強弱がつく。人魂ごとに位相をずらす
      const breath = (0.86 + 0.14 * Math.sin(t * 1.9 + soul[o + 3]! * 1.7)) * soul[o + 5]!;

      // 頭の玉。玉のまわりには尾の先頭数粒が必ず重なり、加算されて明るくなる。
      // 玉ひとつぶんで閾値を越えるところまで上げると、合計で赤が振り切れて
      // 芯が白へ張り付き、暖色帯から外れる。重なるぶんの余白を残しておく
      soulAt(s, t, wisp);
      cpos.setXYZ(s, wisp.x, wisp.y, wisp.z);
      ember(color, 0.54, hue);
      color.multiplyScalar(breath * 0.8);
      ccol.setXYZ(s, color.r, color.g, color.b);

      // 尾は j=1 から。j=0 を置くと頭の玉と同じ場所で加算されて白く飛ぶ
      for (let j = 1; j <= TAIL; j++) {
        soulAt(s, t - j * TAIL_DT, wisp);
        const g = s * TAIL + j - 1;
        pos.setXYZ(g, wisp.x, wisp.y, wisp.z);

        // 頭のすぐ後ろを明るく、尾の先へ向かって琥珀へ沈めながら消す。
        // 粒は隣どうし重なる大きさにしてあるので、1 粒あたりは十分暗くする。
        // 明るいまま重ねると尾が一様な白い帯になり、光の筋に見えなくなる
        const fade = 1 - j / (TAIL + 1);
        ember(color, 0.3 + 0.16 * fade, hue);
        color.multiplyScalar(fade * fade * breath * 0.26);
        col.setXYZ(g, color.r, color.g, color.b);
      }
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    cpos.needsUpdate = true;
    ccol.needsUpdate = true;

    bodies.instanceMatrix.needsUpdate = true;
    hats.instanceMatrix.needsUpdate = true;
    if (bodies.instanceColor) bodies.instanceColor.needsUpdate = true;
    if (hats.instanceColor) hats.instanceColor.needsUpdate = true;

    // 実光源は人魂そのものに持たせる。灯りと明るむ場所がずれない
    for (let k = 0; k < lamps.length; k++) {
      const lamp = lamps[k];
      if (!lamp) continue;
      soulAt(Math.floor((k * SOULS) / LAMPS), t, wisp);
      lamp.position.copy(wisp);
      lamp.intensity = 24 + Math.sin(t * 1.7 + k * 2.1) * 3;
    }
  },

  sound(t, _dt, sfx) {
    // 遠くの地鳴り。行列が続くあいだ途切れない
    sfx.drone(tone(-7), 0.05);

    const head = t / LAP;
    for (let i = 0; i < COUNT; i += SOUND_EVERY) {
      const tick = ticks[i];
      if (!tick) continue;
      // 位相が整数をまたぐ瞬間が、そのまま鳥居をくぐる瞬間になる
      for (let k = tick(head + oni[i * STRIDE]! - GATE); k > 0; k--) {
        sfx.pluck(tone(9 + ((i / SOUND_EVERY) % 5)), {
          gain: 0.22,
          decay: 2.8,
          pan: (oni[i * STRIDE + 1]! / ROAD_W) * 0.6,
        });
      }
    }

    for (let k = tickWind(t * 0.16); k > 0; k--) {
      sfx.air({ gain: 0.15, decay: 3.6, freq: 520, q: 0.9, sweep: -0.4 });
    }
  },
};
