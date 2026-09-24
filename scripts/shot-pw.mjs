#!/usr/bin/env node
/**
 * shot.mjs の Playwright 版。agent-browser が無い環境（クラウドのセッションなど）で使う。
 *
 *   node scripts/shot-pw.mjs <camelCase> [--at 秒]... [--viewport WxH] [--out-dir dir]
 *
 * やること:
 *   1. shot.mjs と同じ規則でシーンの通し番号 N を割り出す
 *   2. 自分のディレクトリの dev サーバーを掴む（無ければ play.mjs で背面起動する）
 *   3. <url>#N を開き、--at で指定した「シーン内の秒数」ごとに撮る
 *   4. ページ内の JS エラーを読み、あれば非ゼロで終了する
 *
 * ソフトウェア描画の環境は数 fps しか出ず、main.ts が dt を 0.05 秒で打ち切るので、
 * 実時間で待つとシーンの時間が大きく遅れる。そこで Playwright の時計を止め、
 * 1 フレームぶん（50ms）ずつ進めて描かせる。1 フレーム = シーン内 0.05 秒なので、
 * 「--at 7」はどの環境でも同じ瞬間になる。
 *
 * Playwright はプロジェクトの依存に入れていない。グローバルに入っているものを使う。
 * dev サーバーは止めない（play.mjs が管理している）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { compareScenes, sceneAddedAt } from './scene-order.mjs';

const ESC = '\u001b[';
const dim = (s) => `${ESC}2m${s}${ESC}0m`;
const bold = (s) => `${ESC}1m${s}${ESC}0m`;
const green = (s) => `${ESC}32m${s}${ESC}0m`;
const red = (s) => `${ESC}31m${s}${ESC}0m`;
const yellow = (s) => `${ESC}33m${s}${ESC}0m`;

/** main.ts が 1 フレームで進める dt の上限（秒）。時計はこの幅で進める */
const FRAME_MS = 50;
/** 開いた直後にシーンとカメラの補間を落ち着かせる秒数（--at を省いたときの既定） */
const DEFAULT_AT = [2];
const VALUE_FLAGS = new Set(['--at', '--viewport', '--out-dir']);

function git(...args) {
  const out = spawnSync('git', args, { encoding: 'utf8' });
  if (out.status !== 0) {
    console.error(red('✗ git リポジトリの中で実行してください。'));
    process.exit(1);
  }
  return out.stdout.trim();
}

const ROOT = dirname(git('rev-parse', '--path-format=absolute', '--git-common-dir'));
const HERE = git('rev-parse', '--show-toplevel');
const STATE_DIR = join(ROOT, '.claude', '.play');
const KEY = HERE === ROOT ? 'main' : basename(HERE);

// --- 引数 -----------------------------------------------------------------

const argv = process.argv.slice(2);
const flagValues = (name) => argv.flatMap((a, i) => (a === name && argv[i + 1] ? [argv[i + 1]] : []));
const SCENE = argv.find((a, i) => !a.startsWith('--') && !VALUE_FLAGS.has(argv[i - 1]));

if (!SCENE || argv.includes('--help')) {
  console.log(`使い方: node scripts/shot-pw.mjs <camelCase> [オプション]

  --at <秒>            シーン内の何秒目を撮るか。複数指定できる（既定 ${DEFAULT_AT.join(', ')}）
  --viewport <WxH>     ビューポート（既定 960x600）
  --out-dir <dir>      画像の置き場所（既定 .claude/.play/shots）`);
  process.exit(SCENE ? 0 : 1);
}
if (!existsSync(join(HERE, 'src', 'scenes', `${SCENE}.ts`))) {
  console.error(red(`✗ src/scenes/${SCENE}.ts が見つかりません。`));
  console.error(dim('  シーン名は camelCase（例: koiPond）で渡してください。'));
  process.exit(1);
}

const AT = (flagValues('--at').length ? flagValues('--at').map(Number) : DEFAULT_AT).sort((a, b) => a - b);
if (AT.some((s) => !Number.isFinite(s) || s < 0)) {
  console.error(red('✗ --at には 0 以上の秒数を渡してください。'));
  process.exit(1);
}
const [W, H] = (flagValues('--viewport')[0] || '960x600').split('x').map(Number);
const OUT_DIR = flagValues('--out-dir')[0] || join(HERE, '.claude', '.play', 'shots');

// --- 1. 通し番号（shot.mjs と同じ規則） -------------------------------------

const scenes = readdirSync(join(HERE, 'src', 'scenes'))
  .filter((f) => f.endsWith('.ts'))
  .map((f) => f.slice(0, -3))
  .filter((name) => name !== 'index')
  .sort(compareScenes(sceneAddedAt(HERE)));
const n = scenes.indexOf(SCENE) + 1;
if (n === 0) {
  console.error(red(`✗ ${SCENE} を並び順の中に見つけられませんでした。`));
  process.exit(1);
}

// --- 2. dev サーバー（shot.mjs と同じ） -------------------------------------

function readState() {
  try {
    return JSON.parse(readFileSync(join(STATE_DIR, `${KEY}.json`), 'utf8'));
  } catch {
    return null;
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function ensureServer() {
  const running = readState();
  if (running && alive(running.pid)) return running;
  console.log(dim(`dev サーバーを起動しています（${KEY}）...`));
  const started = spawnSync('node', [join(ROOT, 'scripts', 'play.mjs'), '--bg', KEY], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const next = started.status === 0 ? readState() : null;
  if (!next) {
    console.error(red('✗ dev サーバーを起動できませんでした。'));
    process.exit(1);
  }
  return next;
}

// --- 3. Playwright ---------------------------------------------------------

/** プロジェクトの依存には無いので、見つからなければグローバルの node_modules から読む。 */
async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    const root = spawnSync('npm', ['root', '-g'], { encoding: 'utf8' }).stdout.trim();
    try {
      return createRequire(join(root, 'noop.js'))('playwright');
    } catch {
      console.error(red('✗ playwright が見つかりません（プロジェクトにもグローバルにも無い）。'));
      process.exit(1);
    }
  }
}

const state = ensureServer();
const url = `${state.url.replace(/\/$/, '')}/#${n}`;
mkdirSync(OUT_DIR, { recursive: true });

const { chromium } = await loadPlaywright();
const preinstalled = '/opt/pw-browsers/chromium';
const browser = await chromium.launch({
  ...(existsSync(preinstalled) ? { executablePath: preinstalled } : {}),
  args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: W, height: H } });

// favicon はブラウザが勝手に取りに行くだけで、シーンとは関係ない。
const ignored = (u) => String(u || '').endsWith('/favicon.ico');
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));
page.on('console', (m) => {
  if (m.type() === 'error' && !ignored(m.location().url)) errors.push(`[console] ${m.text().split('\n')[0]}`);
});

// 時計を止めてから開く。以後の時間はこちらが進めたぶんだけ進む。
// 止めずに開くと、読み込みの間に実時間ぶんのフレームが進んで、撮るたびに瞬間がずれる。
const T0 = new Date('2026-01-01T00:00:00Z');
await page.clock.install({ time: T0 });
await page.clock.pauseAt(new Date(T0.getTime() + 1000));
await page.goto(url, { waitUntil: 'load' });

const shots = [];
let frames = 0;
for (const sec of AT) {
  const target = Math.round((sec * 1000) / FRAME_MS);
  for (; frames < target; frames++) await page.clock.fastForward(FRAME_MS);
  const out = join(OUT_DIR, `${KEY}-${SCENE}-${String(sec).replace('.', '_')}s.png`);
  await page.screenshot({ path: out });
  shots.push(out);
}
await browser.close();

// --- 4. 結果 ---------------------------------------------------------------

console.log(`${green('✓')} ${bold(SCENE)} — タブ ${bold(String(n))} 番目 / 全 ${scenes.length} 本`);
console.log(`  ${url}`);
AT.forEach((sec, i) => console.log(`  ${dim(`${sec}s`)} ${bold(shots[i])}`));
console.log(dim(`  停止: node scripts/play.mjs --stop ${KEY}`));

if (errors.length > 0) {
  console.error('');
  console.error(red('✗ ページ内で JS エラーが出ています。'));
  for (const e of errors) console.error(`  ${e}`);
  console.error('');
  console.error(yellow('  build と typecheck では拾えない種類の失敗です。直してから撮り直してください。'));
  process.exit(1);
}
