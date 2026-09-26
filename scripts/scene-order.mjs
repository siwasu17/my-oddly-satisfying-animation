/**
 * シーンの並び順のもとになる「git がそのファイルを追加した時刻」を取り出す。
 *
 * タブは新しいシーンほど先頭に出る。その「新しさ」は手で管理せず、
 * git の履歴そのものを見る。並びを固定するために編集する共有ファイルが無いので、
 * 並列セッションがシーンを足しても衝突しない。
 *
 * vite.config.ts（仮想モジュール virtual:scene-added-at）と scripts/shot.mjs の
 * 両方がここを使う。#N の数え方を 1 箇所にまとめておくため。
 */

import { execFileSync } from 'node:child_process';

/** git を 1 回だけ叩く。失敗したら null（呼び出し側が警告を出す）。 */
function git(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

/**
 * { camelCase 名: 追加された epoch 秒 } を返す。
 *
 * `--diff-filter=A` の履歴を新しい順に舐めて、各パスの**初出**＝いちばん新しい「追加」を採る。
 * `--follow` は使わない。アーカイブから戻したシーンは「戻したコミットの日付」になり、
 * 戻したものがタブの先頭に現れるという従来の挙動がそのまま残る。
 */
export function sceneAddedAt(cwd = process.cwd()) {
  const log = git(
    ['log', '--diff-filter=A', '--name-only', '--format=@%at', '--', 'src/scenes/*.ts'],
    cwd,
  );
  if (log === null) {
    warn('git の履歴を読めなかった');
    return {};
  }

  const addedAt = /** @type {Record<string, number>} */ ({});
  let stamp = 0;
  for (const line of log.split('\n')) {
    if (line.startsWith('@')) {
      stamp = Number(line.slice(1)) || 0;
      continue;
    }
    const match = line.match(/^src\/scenes\/([^/]+)\.ts$/);
    if (!match || match[1] === 'index') continue;
    if (!(match[1] in addedAt)) addedAt[match[1]] = stamp;
  }

  if (Object.keys(addedAt).length === 0) warn('シーンの追加履歴が 1 件も見つからなかった');
  else if (git(['rev-parse', '--is-shallow-repository'], cwd)?.trim() === 'true') {
    warn('リポジトリが shallow clone（履歴が浅い）');
  }
  return addedAt;
}

/**
 * 並び替えの比較関数。追加が新しいものほど前。
 * 履歴に無いもの（まだコミットしていないシーン）は最新扱いで先頭へ。
 * 同時刻（初期の一括追加コミット）は名前の昇順で固定する。
 */
export function compareScenes(addedAt) {
  const at = (name) => addedAt[name] ?? Number.POSITIVE_INFINITY;
  return (a, b) => at(b) - at(a) || a.localeCompare(b);
}

function warn(reason) {
  console.warn(
    `[scene-order] ${reason}ため、シーンの並び順が本来のものと違います。` +
      ' CI なら checkout の fetch-depth: 0 を確認してください。',
  );
}
