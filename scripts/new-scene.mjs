#!/usr/bin/env node
/**
 * templates/scene.ts を src/scenes/<camelCase>.ts にコピーして新しいシーンを作る。
 *
 *   node scripts/new-scene.mjs koi-pond
 *
 * src/scenes/index.ts はディレクトリを自動で読み込むので、登録作業は無い。
 * これは並列作業で共有ファイルの衝突を無くすための設計（CLAUDE.md 参照）。
 */
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const template = join(root, 'templates', 'scene.ts');

const name = process.argv[2];

if (!name) {
  console.error('使い方: node scripts/new-scene.mjs <scene-name>');
  console.error('例: node scripts/new-scene.mjs koi-pond');
  process.exit(1);
}

if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(name)) {
  console.error(`不正な名前です: "${name}"`);
  console.error('kebab-case（小文字英数とハイフン、先頭は英字）で指定してください。例: koi-pond');
  process.exit(1);
}

/** koi-pond → koiPond（ファイル名 = export 名） */
const camel = name.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
/** koi-pond → Koi Pond（タブに出る表示名） */
const title = name
  .split('-')
  .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
  .join(' ');

const target = join(root, 'src', 'scenes', `${camel}.ts`);

if (existsSync(target)) {
  console.error(`src/scenes/${camel}.ts はすでに存在します。別の名前にしてください。`);
  process.exit(1);
}

const source = await readFile(template, 'utf8');
await writeFile(target, source.replaceAll('__NAME__', camel).replaceAll('__TITLE__', title));

console.log(`✓ src/scenes/${camel}.ts を作成しました。`);
console.log('');
console.log('次にやること:');
console.log('');
console.log('  npm run dev                          # 末尾のタブに追加されているのを確認する');
console.log(`  # src/scenes/${camel}.ts だけを編集する（他のファイルは共有物）`);
console.log('');
console.log('検証:');
console.log('');
console.log('  npm run typecheck');
console.log('  npm run build');
console.log(`  npm run smoke ${camel}`);
