import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, ticker } from '../audio.ts';
import { SURFACE, ember, emberColor, drift } from '../palette.ts';

/**
 * Hermite Laser。縦シューティングのワンシーン。
 *
 * 編隊を組んで降りてきた 16 機の敵に、左から順にロックオンの菱形が付く。
 * 自機が扇状にホーミングレーザーを撃ち出し、各レーザーは
 * 「自機の位置と扇の向き」→「敵の位置と突き刺さる向き」を結ぶ 3 次エルミート曲線をなぞって、
 * 横へ大きく膨らんでから敵へ吸い込まれる。着弾は左から右へ連鎖し、編隊が一網打尽に弾ける。
 * 9 秒で一巡し、次の編隊がまた降りてくる。音はロックオンの短い爪弾き、発射の風切り、
 * 着弾ごとに上がっていく音階。
 */

// --- 調整する数値 ---------------------------------------------------------

/** 1 周の秒数 */
const CYCLE = 9;
/** 敵の数 = レーザーの本数 */
const N = 16;
/** 自機の z */
const SHIP_Z = 8.5;

/** 編隊が降りてくる開始時刻と、1 機あたりのずれ、かかる秒数 */
const ENTER0 = 0.1;
const ENTER_STEP = 0.05;
const ENTER_DUR = 1.5;
/** ロックオンの開始時刻と間隔 */
const LOCK0 = 2.5;
const LOCK_STEP = 0.06;
/** 発射の開始時刻と間隔、1 本の飛行秒数、尾の遅れ */
const LAUNCH0 = 3.7;
const LAUNCH_STEP = 0.05;
const FLY = 1.25;
const LAG = 0.38;
/** 爆発の秒数 */
const BOOM = 1.1;

/** 扇の半角（ラジアン）。外側のレーザーはほぼ真横へ出る */
const FAN = 1.85;
/** 出だしと着弾の接線の長さ。大きいほど大きく膨らむ */
const K0 = 24;
const K1 = 9;
/** レーザー 1 本の分割数と太さ */
const SEG = 44;
const WIDTH = 0.2;
/** 爆発の破片の数（1 機あたり） */
const SHARDS = 9;

const HIT0 = LAUNCH0 + FLY;

// --- 使い回し -------------------------------------------------------------

const dummy = new THREE.Object3D();
const color = new THREE.Color();
const up = new THREE.Vector3(0, 1, 0);
const p0 = new THREE.Vector3();
const t0 = new THREE.Vector3();
const p1 = new THREE.Vector3();
const t1 = new THREE.Vector3();
const pos = new THREE.Vector3();
const tan = new THREE.Vector3();
const side = new THREE.Vector3();

/** 編隊の定位置 [x, y, z]（左から右へ並べ替え済み） */
const slots: [number, number, number][] = [];
{
  const rows = [5, 6, 5];
  rows.forEach((n, r) => {
    for (let k = 0; k < n; k++) {
      const u = n === 1 ? 0 : k / (n - 1) - 0.5;
      // 真ん中ほど奥へ下がる V 字の編隊
      const x = u * (n === 6 ? 14 : 11);
      const z = -3.5 - r * 3 - (1 - Math.abs(u) * 2) * 1.8;
      slots.push([x, 1.1, z]);
    }
  });
  slots.sort((a, b) => a[0] - b[0]);
}

/** 破片の飛ぶ向き（固定シード） */
const shardDir: THREE.Vector3[] = [];
{
  let s = 0.731;
  const rnd = (): number => (s = (s * 9301 + 0.49297) % 1);
  for (let i = 0; i < N * SHARDS; i++) {
    const a = rnd() * Math.PI * 2;
    const y = rnd() * 1.2 - 0.3;
    shardDir.push(new THREE.Vector3(Math.cos(a), y, Math.sin(a)).normalize().multiplyScalar(0.6 + rnd() * 0.8));
  }
}

let enemies: THREE.InstancedMesh;
let reticles: THREE.InstancedMesh;
let flashes: THREE.InstancedMesh;
let shards: THREE.InstancedMesh;
let heads: THREE.InstancedMesh;
let ship: THREE.Group;
let engine: THREE.Mesh;
let grid: THREE.LineSegments;
let ribbon: THREE.Mesh;
let ribPos: Float32Array;
let ribCol: Float32Array;

let lockTick = ticker();
let hitTick = ticker();
let fireTick = ticker();

// --- 形の関数 -------------------------------------------------------------

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const easeOut = (x: number): number => 1 - Math.pow(1 - x, 3);
const easeInOut = (x: number): number => 0.5 - 0.5 * Math.cos(Math.PI * x);

/** 自機の位置（ゆっくり左右に揺れる） */
function shipAt(t: number, out: THREE.Vector3): THREE.Vector3 {
  return out.set(2.4 * Math.sin(t * 0.47), 0.4, SHIP_Z + 0.35 * Math.sin(t * 0.93));
}

/** 敵 i の位置。周内時刻 tc で降りてきて、定位置で漂う */
function enemyAt(i: number, tc: number, t: number, out: THREE.Vector3): THREE.Vector3 {
  const [x, y, z] = slots[i];
  const e = easeOut(clamp01((tc - ENTER0 - i * ENTER_STEP) / ENTER_DUR));
  const bob = Math.sin(t * 1.3 + i * 0.7) * 0.18;
  const sway = Math.sin(t * 0.6 + i * 0.4) * 0.25;
  return out.set(
    x * (1.5 - 0.5 * e) + sway,
    y + (1 - e) * 5 + bob,
    z - (1 - e) * 24,
  );
}

/** 3 次エルミート曲線の点と接線 */
function hermite(s: number, outP: THREE.Vector3, outT: THREE.Vector3): void {
  const s2 = s * s;
  const s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1;
  const h10 = s3 - 2 * s2 + s;
  const h01 = -2 * s3 + 3 * s2;
  const h11 = s3 - s2;
  outP.set(0, 0, 0).addScaledVector(p0, h00).addScaledVector(t0, h10).addScaledVector(p1, h01).addScaledVector(t1, h11);
  const d00 = 6 * s2 - 6 * s;
  const d10 = 3 * s2 - 4 * s + 1;
  const d01 = -6 * s2 + 6 * s;
  const d11 = 3 * s2 - 2 * s;
  outT.set(0, 0, 0).addScaledVector(p0, d00).addScaledVector(t0, d10).addScaledVector(p1, d01).addScaledVector(t1, d11);
}

export const hermiteLaser: SceneModule = {
  name: 'Hermite Laser',
  desc: '扇状に撃ち出したホーミングレーザーが、エルミート曲線を描いて編隊を左から順に撃ち抜く。',
  camera: { pos: [0, 19, 12.5], target: [0, 0, 0.5] },
  environment: 0.6,

  build(root) {
    lockTick = ticker();
    hitTick = ticker();
    fireTick = ticker();

    // 流れる床のグリッド。横線だけ t でずらして前進しているように見せる
    const gp: number[] = [];
    for (let x = -16; x <= 16; x += 2) gp.push(x, 0, -30, x, 0, 14);
    for (let z = -30; z <= 14; z += 2) gp.push(-16, 0, z, 16, 0, z);
    const gg = new THREE.BufferGeometry();
    gg.setAttribute('position', new THREE.Float32BufferAttribute(gp, 3));
    grid = new THREE.LineSegments(
      gg,
      new THREE.LineBasicMaterial({ color: emberColor(0.12), transparent: true, opacity: 0.35 }),
    );
    grid.position.y = -1.6;
    root.add(grid);

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(40, 50),
      new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.7, metalness: 0.4 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, -1.65, -8);
    root.add(floor);

    // 敵。自機のほうへ尖った平たい三角の機体
    const eg = new THREE.ConeGeometry(0.75, 1.5, 3);
    eg.rotateX(Math.PI / 2);
    eg.scale(1, 0.35, 1);
    enemies = new THREE.InstancedMesh(
      eg,
      new THREE.MeshStandardMaterial({ roughness: 0.3, metalness: 0.6 }),
      N,
    );
    enemies.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    root.add(enemies);

    const glow = (): THREE.MeshBasicMaterial =>
      new THREE.MeshBasicMaterial({
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      });

    // ロックオンの菱形（4 分割のリング = 菱形の枠）
    const rg = new THREE.RingGeometry(0.98, 1.03, 4, 1);
    reticles = new THREE.InstancedMesh(rg, glow(), N);
    reticles.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    root.add(reticles);

    flashes = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 2), glow(), N);
    flashes.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    root.add(flashes);

    shards = new THREE.InstancedMesh(new THREE.TetrahedronGeometry(1), glow(), N * SHARDS);
    shards.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    root.add(shards);

    heads = new THREE.InstancedMesh(new THREE.SphereGeometry(0.16, 12, 8), glow(), N);
    heads.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    root.add(heads);

    // レーザーの帯。N 本 × SEG 点 × 左右 2 頂点を 1 つのジオメトリにまとめる
    ribPos = new Float32Array(N * SEG * 2 * 3);
    ribCol = new Float32Array(N * SEG * 2 * 3);
    const idx: number[] = [];
    for (let l = 0; l < N; l++) {
      for (let k = 0; k < SEG - 1; k++) {
        const a = (l * SEG + k) * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    const rgeo = new THREE.BufferGeometry();
    rgeo.setAttribute('position', new THREE.BufferAttribute(ribPos, 3).setUsage(THREE.DynamicDrawUsage));
    rgeo.setAttribute('color', new THREE.BufferAttribute(ribCol, 3).setUsage(THREE.DynamicDrawUsage));
    rgeo.setIndex(idx);
    ribbon = new THREE.Mesh(
      rgeo,
      new THREE.MeshBasicMaterial({
        vertexColors: true,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    ribbon.frustumCulled = false;
    root.add(ribbon);

    // 自機。前へ尖った円錐と薄い翼
    ship = new THREE.Group();
    const hullMat = new THREE.MeshStandardMaterial({ color: emberColor(0.62), roughness: 0.3, metalness: 0.55 });
    const hull = new THREE.Mesh(new THREE.ConeGeometry(0.45, 1.8, 12), hullMat);
    hull.rotation.x = -Math.PI / 2;
    ship.add(hull);
    const wing = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.08, 0.6), hullMat);
    wing.position.z = 0.45;
    ship.add(wing);
    engine = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 8), glow());
    engine.position.z = 1.0;
    ship.add(engine);
    root.add(ship);
  },

  update(t) {
    const tc = ((t % CYCLE) + CYCLE) % CYCLE;
    const base = t - tc;
    const hue = drift(t);

    grid.position.z = (t * 3) % 2;

    shipAt(t, ship.position);
    ship.rotation.z = -Math.cos(t * 0.47) * 0.25;
    (engine.material as THREE.MeshBasicMaterial).color
      .copy(ember(color, 0.85, hue, 0.05))
      .multiplyScalar(0.7 + 0.3 * Math.sin(t * 31));

    const ribAttr = ribbon.geometry.getAttribute('position') as THREE.BufferAttribute;
    const colAttr = ribbon.geometry.getAttribute('color') as THREE.BufferAttribute;

    for (let i = 0; i < N; i++) {
      const launch = LAUNCH0 + i * LAUNCH_STEP;
      const hit = launch + FLY;
      const lock = LOCK0 + i * LOCK_STEP;
      enemyAt(i, tc, t, p1);

      // 敵本体。着弾で消える
      const alive = tc < hit;
      dummy.position.copy(p1);
      dummy.rotation.set(0.35, Math.sin(t * 1.1 + i) * 0.25, Math.sin(t * 2 + i) * 0.3);
      dummy.scale.setScalar(alive ? 1 : 0);
      dummy.updateMatrix();
      enemies.setMatrixAt(i, dummy.matrix);
      ember(color, 0.3 + 0.15 * Math.sin(i * 1.7), hue, tc > lock && alive ? 0.05 : 0);
      enemies.setColorAt(i, color);

      // ロックオンの菱形。付いた瞬間に縮みながら現れ、着弾で消える
      const lk = tc - lock;
      const lockOn = lk > 0 && alive;
      const pop = easeOut(clamp01(lk / 0.22));
      dummy.position.copy(p1);
      // カメラのほうへ起こしてから、面内で回す
      dummy.rotation.set(-0.8, 0, Math.PI / 4 + (1 - pop) * 1.6 + t * 0.8);
      dummy.scale.setScalar(lockOn ? 2.6 - 1.5 * pop : 0);
      dummy.updateMatrix();
      reticles.setMatrixAt(i, dummy.matrix);
      ember(color, 0.8, hue).multiplyScalar(0.12 + 0.13 * pop);
      reticles.setColorAt(i, color);

      // 爆発の閃光と破片
      const e = (tc - hit) / BOOM;
      const boom = e >= 0 && e < 1;
      const fade = boom ? Math.pow(1 - e, 3) : 0;
      dummy.position.copy(p1);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.setScalar(boom ? 0.25 + 0.75 * easeOut(e) : 0);
      dummy.updateMatrix();
      flashes.setMatrixAt(i, dummy.matrix);
      ember(color, 0.85, hue, 0.05).multiplyScalar(fade * 0.55);
      flashes.setColorAt(i, color);
      for (let k = 0; k < SHARDS; k++) {
        const j = i * SHARDS + k;
        const d = shardDir[j];
        dummy.position.copy(p1).addScaledVector(d, boom ? easeOut(e) * 3.4 : 0);
        dummy.rotation.set(e * 7 + k, e * 5 + i, 0);
        dummy.scale.setScalar(boom ? 0.2 * (1 - e) : 0);
        dummy.updateMatrix();
        shards.setMatrixAt(j, dummy.matrix);
        ember(color, 0.75, hue, 0.05).multiplyScalar(fade * 0.8);
        shards.setColorAt(j, color);
      }

      // レーザー。発射時の自機の位置から、扇の向きへ出て、敵へ突き刺さる
      shipAt(base + launch, p0);
      p0.z -= 0.9;
      const th = -FAN + (2 * FAN * i) / (N - 1);
      t0.set(Math.sin(th), 0.25, -Math.cos(th)).multiplyScalar(K0);
      t1.set(p1.x - p0.x, 0, p1.z - p0.z).normalize();
      t1.set(t1.x * 0.35, -0.2, -1).normalize().multiplyScalar(K1);

      const sh = easeInOut(clamp01((tc - launch) / FLY));
      const st = easeInOut(clamp01((tc - launch - LAG) / FLY));
      const flying = tc > launch && st < 1;
      for (let k = 0; k < SEG; k++) {
        const u = k / (SEG - 1);
        const a = ((i * SEG + k) * 2) * 3;
        if (!flying) {
          ribPos.fill(0, a, a + 6);
          ribCol.fill(0, a, a + 6);
          continue;
        }
        hermite(st + (sh - st) * u, pos, tan);
        side.crossVectors(tan, up);
        if (side.lengthSq() < 1e-8) side.set(1, 0, 0);
        side.normalize().multiplyScalar(WIDTH * Math.pow(u, 0.6));
        ribPos[a] = pos.x - side.x;
        ribPos[a + 1] = pos.y - side.y;
        ribPos[a + 2] = pos.z - side.z;
        ribPos[a + 3] = pos.x + side.x;
        ribPos[a + 4] = pos.y + side.y;
        ribPos[a + 5] = pos.z + side.z;
        ember(color, 0.55 + 0.4 * u, hue, 0.08 * u).multiplyScalar(0.12 + 0.5 * u * u);
        ribCol[a] = ribCol[a + 3] = color.r;
        ribCol[a + 1] = ribCol[a + 4] = color.g;
        ribCol[a + 2] = ribCol[a + 5] = color.b;
      }

      // レーザーの先端の光点
      const headOn = tc > launch && tc < hit;
      if (headOn) hermite(sh, pos, tan);
      dummy.position.copy(headOn ? pos : p1);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.setScalar(headOn ? 1 : 0);
      dummy.updateMatrix();
      heads.setMatrixAt(i, dummy.matrix);
      ember(color, 0.95, hue, 0.05).multiplyScalar(0.7);
      heads.setColorAt(i, color);
    }

    ribAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
    for (const m of [enemies, reticles, flashes, shards, heads]) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  },

  sound(t, _dt, sfx) {
    const tc = ((t % CYCLE) + CYCLE) % CYCLE;
    const cyc = Math.floor(t / CYCLE);

    // ロックオン: 1 機ごとに高く短く
    const lp = cyc * N + Math.min(N, Math.max(0, (tc - LOCK0) / LOCK_STEP + 1));
    if (lockTick(lp) > 0) {
      const i = (Math.floor(lp) - 1 + N) % N;
      sfx.pluck(tone(14 + (i % 3)), { gain: 0.08, decay: 0.25, pan: slots[i][0] / 10 });
    }

    // 発射: 風切りを 1 回
    if (fireTick((t - LAUNCH0) / CYCLE) > 0) {
      sfx.air({ gain: 0.22, decay: 1.4, freq: 900, sweep: 2.2 });
    }

    // 着弾: 左から右へ音階が上がっていく
    const hp = cyc * N + Math.min(N, Math.max(0, (tc - HIT0) / LAUNCH_STEP + 1));
    if (hitTick(hp) > 0) {
      const i = (Math.floor(hp) - 1 + N) % N;
      if (i % 2 === 0 || i === N - 1) {
        sfx.pluck(tone(4 + Math.floor(i / 2)), { gain: 0.22, decay: 1.6, pan: slots[i][0] / 9 });
      }
      if (i === N - 1) sfx.drop(tone(0), { gain: 0.25, decay: 0.9, bend: 0.5 });
    }
  },
};
