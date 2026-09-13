import type { SceneModule } from '../types.ts';
import { ADDED_AT } from 'virtual:scene-added-at';

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

/**
 * 並び順は **git がそのファイルを追加した時刻**で決まる。新しいシーンほど先頭。
 *
 * 並びを固定するために編集する共有ファイルは無い（かつては ORDER という手書きの表があった）。
 * シーンを 1 本足すとき、このファイルを編集する必要は無い。
 *
 * まだコミットしていないシーンは `ADDED_AT` に無く、最新扱いで先頭に出る。
 * 同時刻に追加されたもの（初期の一括コミット）は名前の昇順で固定する。
 *
 * 新しいものが先頭に来る以上、#N の番号はシーンを足すたびにずれる。
 * URL の番号は固定されないものとして扱うこと。
 */
function addedAt(name: string): number {
  return ADDED_AT[name] ?? Number.POSITIVE_INFINITY;
}

const files = Object.entries(modules)
  .map(([path, mod]) => ({ name: baseName(path), path, mod }))
  .filter((file) => file.name !== 'index')
  .sort((a, b) => addedAt(b.name) - addedAt(a.name) || a.name.localeCompare(b.name));

export const SCENES: readonly SceneModule[] = files.map((file) => pickScene(file.path, file.mod));
