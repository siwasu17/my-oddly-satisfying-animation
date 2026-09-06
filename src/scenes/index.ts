import type { SceneModule } from '../types.ts';

/**
 * タブと数字キーの並び順。
 *
 * 動きの質が続けて似ないよう、面で見せるものと線で見せるものを交互にしている。
 * 先頭 4 つは URL の #1〜#4 が変わらないよう、初版の順のまま置いている。
 *
 * ここに書かれていないシーンはファイル名順で末尾に付く。つまり
 * **シーンを 1 本足すときにこのファイルを編集する必要はない**（並列作業で
 * 衝突しないよう、追加のたびに触る共有ファイルを無くしてある）。
 * 並びを整えたくなったときだけ、ユーザーの判断でここへ足す。
 */
const ORDER: readonly string[] = [
  'waveLattice',
  'flipGarden',
  'twistColumn',
  'breathingRings',
  'rainRings',
  'silkSheet',
  'dominoRing',
  'driftingBubbles',
  'braidedHelix',
  'gimbalRings',
  'curtainWave',
  'lightCorridor',
  'marbleMachine',
  'cascadeTower',
  'murmuration',
  'koiPond',
];

/**
 * 同じ階層の .ts をすべて読み込む。
 * eager なので、ビルド後は静的な import と同じものになる（遅延読み込みはしない）。
 */
const modules = import.meta.glob<Record<string, unknown>>('./*.ts', { eager: true });

/** './waveLattice.ts' → 'waveLattice' */
function baseName(path: string): string {
  return path.replace(/^\.\//, '').replace(/\.ts$/, '');
}

/** export された値が SceneModule かどうかを実行時に見分ける。 */
function isSceneModule(value: unknown): value is SceneModule {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<SceneModule>;
  return (
    typeof v.name === 'string' &&
    typeof v.desc === 'string' &&
    typeof v.build === 'function' &&
    typeof v.update === 'function' &&
    typeof v.camera === 'object' &&
    v.camera !== null &&
    Array.isArray(v.camera.pos) &&
    Array.isArray(v.camera.target)
  );
}

/** 1 ファイル 1 シーン。SceneModule の export がちょうど 1 つあることを求める。 */
function pickScene(path: string, mod: Record<string, unknown>): SceneModule {
  const found = Object.entries(mod).filter(([, value]) => isSceneModule(value));
  if (found.length === 0) {
    throw new Error(
      `src/scenes/${baseName(path)}.ts が SceneModule を export していません。` +
        ' export const <名前>: SceneModule = { ... } を 1 つ書いてください。',
    );
  }
  if (found.length > 1) {
    const names = found.map(([key]) => key).join(', ');
    throw new Error(
      `src/scenes/${baseName(path)}.ts に SceneModule の export が複数あります（${names}）。` +
        ' 1 ファイル 1 シーンにしてください。',
    );
  }
  return found[0]![1] as SceneModule;
}

/** ORDER にあるものはその順、無いものは名前順で末尾へ。 */
function rank(name: string): number {
  const index = ORDER.indexOf(name);
  return index === -1 ? ORDER.length : index;
}

const files = Object.entries(modules)
  .map(([path, mod]) => ({ name: baseName(path), path, mod }))
  .filter((file) => file.name !== 'index')
  .sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));

export const SCENES: readonly SceneModule[] = files.map((file) => pickScene(file.path, file.mod));
