#!/usr/bin/env node
/**
 * 自分のシーンを 1 コマンドで見る。
 *
 *   node scripts/shot.mjs <camelCase> [--wait ms] [--viewport WxH] [--out path]
 *
 * やること:
 *   1. src/scenes/index.ts と同じ規則でシーンの通し番号 N を割り出す
 *   2. 自分のディレクトリの dev サーバーを掴む（無ければ背面起動する）
 *   3. <url>#N を開いてスクリーンショットを撮る
 *   4. ページ内の JS エラーを読み、あれば非ゼロで終了する
 *
 * タブを snapshot して click で探す必要は無い。#N は main.ts の initialIndex() が読む。
 * agent-browser の起動フラグと、並列セッションが混ざらないためのセッション名は
 * このスクリプトが設定するので、呼ぶ側で export しなくてよい。
 *
 * dev サーバーは止めない（play.mjs が管理している）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const ESC = '\u001b[';
const dim = (s) => `${ESC}2m${s}${ESC}0m`;
const bold = (s) => `${ESC}1m${s}${ESC}0m`;
const green = (s) => `${ESC}32m${s}${ESC}0m`;
const red = (s) => `${ESC}31m${s}${ESC}0m`;
const yellow = (s) => `${ESC}33m${s}${ESC}0m`;

const DEFAULT_ARGS = '--no-sandbox,--disable-gpu,--disable-crash-reporter,--disable-breakpad';
const VALUE_FLAGS = new Set(['--wait', '--viewport', '--out']);

function git(...args) {
  const out = spawnSync('git', args, { encoding: 'utf8' });
  if (out.status !== 0) {
    console.error(red('✗ git リポジトリの中で実行してください。'));
    process.exit(1);
  }
  return out.stdout.trim();
}

/** worktree の中から呼ばれても、親リポジトリの場所を指す。 */
const ROOT = dirname(git('rev-parse', '--path-format=absolute', '--git-common-dir'));
const HERE = git('rev-parse', '--show-toplevel');
const STATE_DIR = join(ROOT, '.claude', '.play');

/** play.mjs が使っているキー。リポジトリ本体なら 'main'、worktree ならその名前。 */
const KEY = HERE === ROOT ? 'main' : basename(HERE);

// --- 引数 -----------------------------------------------------------------

const argv = process.argv.slice(2);

if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
  console.log(`使い方:
  node scripts/shot.mjs <camelCase> [オプション]

  <camelCase>          src/scenes/<camelCase>.ts のシーン名

オプション:
  --wait <ms>          撮る前に待つ時間（既定 1500。カメラの補間が落ち着くまで）
  --viewport <WxH>     ビューポート（既定 960x600。大きくすると読み込む画像も重くなる）
  --out <path>         保存先（既定 .claude/.play/shots/<key>-<scene>.png）
  --keep-errors        ページ内エラーがあっても終了コードを 0 にする`);
  process.exit(0);
}

function flag(name, fallback) {
  const i = argv.indexOf(name);
  return i === -1 || i === argv.length - 1 ? fallback : argv[i + 1];
}

/** フラグでもフラグの値でもない最初の引数がシーン名。 */
function positional() {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) continue;
    if (i > 0 && VALUE_FLAGS.has(argv[i - 1])) continue;
    return argv[i];
  }
  return null;
}

const SCENE = positional();
const WAIT = Number(flag('--wait', 1500));
const VIEWPORT = String(flag('--viewport', '960x600'));
const KEEP_ERRORS = argv.includes('--keep-errors');

if (!SCENE) {
  console.error(red('✗ シーン名（camelCase）を渡してください。'));
  process.exit(1);
}
if (!existsSync(join(HERE, 'src', 'scenes', `${SCENE}.ts`))) {
  console.error(red(`✗ src/scenes/${SCENE}.ts が見つかりません。`));
  console.error(dim('  シーン名は camelCase（例: koiPond）で渡してください。'));
  process.exit(1);
}

// --- 1. 通し番号を割り出す -------------------------------------------------

/**
 * src/scenes/index.ts の並び順を再現する。
 * ORDER にあるものはその順、無いものは名前順で末尾へ（index.ts の rank() と同じ）。
 */
function sceneOrder(dir) {
  const source = readFileSync(join(dir, 'src', 'scenes', 'index.ts'), 'utf8');
  const block = source.match(/const ORDER[^=]*=\s*\[([\s\S]*?)\]/);
  const order = block ? [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];
  const rank = (name) => {
    const i = order.indexOf(name);
    return i === -1 ? order.length : i;
  };
  return readdirSync(join(dir, 'src', 'scenes'))
    .filter((f) => f.endsWith('.ts'))
    .map((f) => f.slice(0, -3))
    .filter((name) => name !== 'index')
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

// --- 2. dev サーバーを掴む -------------------------------------------------

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
  if (started.status !== 0) {
    console.error(red('✗ dev サーバーを起動できませんでした。'));
    process.exit(1);
  }
  const next = readState();
  if (!next) {
    console.error(red('✗ 起動したはずの dev サーバーの URL を読めませんでした。'));
    process.exit(1);
  }
  return next;
}

// --- 3. agent-browser ------------------------------------------------------

const env = {
  ...process.env,
  // サンドボックス下では入れ子のサンドボックスを初期化できないので、Chrome 側を無効化する。
  AGENT_BROWSER_ARGS: process.env.AGENT_BROWSER_ARGS || DEFAULT_ARGS,
  // 並列セッションどうしでタブを取り合わないよう、worktree ごとに分ける。
  AGENT_BROWSER_SESSION: process.env.AGENT_BROWSER_SESSION || `osa-${KEY}`,
};

function browser(...args) {
  const out = spawnSync('agent-browser', args, { encoding: 'utf8', env, timeout: 120000 });
  if (out.error && out.error.code === 'ENOENT') {
    console.error(red('✗ agent-browser が見つかりません。'));
    console.error(dim('  見た目の確認を飛ばす場合は、その旨をユーザーに伝えてください。'));
    process.exit(1);
  }
  const text = `${out.stdout || ''}${out.stderr || ''}`.trim();
  return { status: out.status === null ? 1 : out.status, out: text };
}

/**
 * --json 付きで呼んで data を返す。
 * errors / console のバッファは --clear でも reload でも消えないので、
 * 「撮る前」と「撮った後」の差分を取るためにここを通す。
 */
function browserData(...args) {
  const res = browser(...args, '--json');
  try {
    const parsed = JSON.parse(res.out);
    return parsed && parsed.data ? parsed.data : null;
  } catch {
    return null;
  }
}

function errorList() {
  const data = browserData('errors');
  return data && Array.isArray(data.errors) ? data.errors : [];
}

function consoleErrorList() {
  const data = browserData('console');
  const messages = data && Array.isArray(data.messages) ? data.messages : [];
  return messages.filter((m) => m.type === 'error');
}

/** 同期的に待つ（撮る前にカメラの補間とアニメーションを落ち着かせる）。 */
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const scenes = sceneOrder(HERE);
const n = scenes.indexOf(SCENE) + 1;
if (n === 0) {
  console.error(red(`✗ ${SCENE} を並び順の中に見つけられませんでした。`));
  process.exit(1);
}

const state = ensureServer();
const url = `${state.url.replace(/\/$/, '')}/#${n}`;

const outPath = flag('--out', null) || join(STATE_DIR, 'shots', `${KEY}-${SCENE}.png`);
mkdirSync(dirname(outPath), { recursive: true });

// 開く前の状態を控えておく。あとで差分だけを「このシーンが出したエラー」とみなす。
const errorsBefore = errorList().length;
const consoleBefore = consoleErrorList().length;

const opened = browser('open', url);
if (opened.status !== 0) {
  console.error(red('✗ ページを開けませんでした。'));
  console.error(opened.out);
  process.exit(1);
}

const size = VIEWPORT.split('x');
browser('set', 'viewport', size[0], size[1]);

// ビューポートを変えたあとの状態で読み込み直してから撮る。
browser('reload');

sleep(WAIT);

const shot = browser('screenshot', outPath);
if (shot.status !== 0) {
  console.error(red('✗ スクリーンショットを撮れませんでした。'));
  console.error(shot.out);
  process.exit(1);
}

// --- 4. ページ内のエラーを読む ---------------------------------------------

const jsErrors = errorList().slice(errorsBefore);
const consoleErrors = consoleErrorList().slice(consoleBefore);

console.log(`${green('✓')} ${bold(SCENE)} — タブ ${bold(String(n))} 番目 / 全 ${scenes.length} 本`);
console.log(`  ${url}`);
console.log(`  ${bold(outPath)}`);
console.log(dim(`  停止: node scripts/play.mjs --stop ${KEY}`));

if (jsErrors.length > 0 || consoleErrors.length > 0) {
  console.error('');
  console.error(red('✗ ページ内で JS エラーが出ています。'));
  for (const e of jsErrors) console.error(`  ${String(e.text || e).split('\n')[0]}`);
  for (const m of consoleErrors) console.error(`  [console] ${String(m.text || '').split('\n')[0]}`);
  console.error('');
  console.error(yellow('  build と typecheck では拾えない種類の失敗です。直してから撮り直してください。'));
  console.error(yellow(`  詳細: agent-browser errors --json --session ${env.AGENT_BROWSER_SESSION}`));
  if (!KEEP_ERRORS) process.exit(1);
}
