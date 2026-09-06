import type { SceneModule } from '../types.ts';

/**
 * シーンが追加された順（古い → 新しい）。
 *
 * **タブと数字キーの並びはこれを逆にしたもの**で、新しいシーンほど先頭に出る。
 * 追加日時は git 履歴から取っていて、同じコミットで入ったものは初版の並び
 * （面で見せるものと線で見せるものが交互になる順）を残してある。
 *
 * ここに書かれていないシーンは「いちばん新しいもの」として先頭に付く
 * （複数あればファイル名の降順）。つまり **シーンを 1 本足すときにこのファイルを
 * 編集する必要はない**（並列作業で衝突しないよう、追加のたびに触る共有ファイルを
 * 無くしてある）。落ち着いたところでユーザーがここへ追記すると並びが固定される。
 *
 * 新しいものが先頭に来る以上、#N の番号はシーンを足すたびにずれる。
 * URL の番号は固定されないものとして扱うこと。
 */
const ORDER: readonly string[] = [
  'waveLattice',
  'flipGarden',
  'breathingRings',
  'rainRings',
  'silkSheet',
  'dominoRing',
  'driftingBubbles',
  'braidedHelix',
  'gimbalRings',
  'curtainWave',
  'lightCorridor',
  'twistColumn',
  'marbleMachine',
  'cascadeTower',
  'murmuration',
  'koiPond',
  'loom',
  'lavaLamp',
  'nightParade',
  'jellyGlobe',
  'cloudRidge',
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

/** ORDER を逆に辿る（新しいものほど前）。ORDER に無いものは最新扱いで先頭へ。 */
function rank(name: string): number {
  const index = ORDER.indexOf(name);
  return index === -1 ? -1 : ORDER.length - 1 - index;
}

const files = Object.entries(modules)
  .map(([path, mod]) => ({ name: baseName(path), path, mod }))
  .filter((file) => file.name !== 'index')
  .sort((a, b) => rank(a.name) - rank(b.name) || b.name.localeCompare(a.name));

export const SCENES: readonly SceneModule[] = files.map((file) => pickScene(file.path, file.mod));
