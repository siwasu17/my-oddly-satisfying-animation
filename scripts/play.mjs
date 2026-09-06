#!/usr/bin/env node
/**
 * dev サーバーを背面で起動して URL を出す。完成報告のときの引き渡し用。
 *
 *   node scripts/play.mjs --bg [name]     背面で起動して URL を出力する
 *   node scripts/play.mjs --list          起動中の一覧
 *   node scripts/play.mjs --stop <name>   停止（--stop --all で全部）
 *
 * name は worktree の名前（.claude/worktrees/<name>）。省略するとリポジトリ本体。
 * ポートは指定しない。Vite が空いているところへ自動で繰り上げるので、
 * 並列セッションの dev サーバーと衝突しない。
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

const ESC = '\u001b[';
const dim = (s) => `${ESC}2m${s}${ESC}0m`;
const bold = (s) => `${ESC}1m${s}${ESC}0m`;
const green = (s) => `${ESC}32m${s}${ESC}0m`;
const red = (s) => `${ESC}31m${s}${ESC}0m`;

/** worktree の中から呼ばれても、親リポジトリの場所を指す。 */
function repoRoot() {
  const out = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    encoding: 'utf8',
  });
  if (out.status !== 0) {
    console.error(red('✗ git リポジトリの中で実行してください。'));
    process.exit(1);
  }
  return dirname(out.stdout.trim());
}

const ROOT = repoRoot();
const STATE_DIR = join(ROOT, '.claude', '.play');
const WT_ROOT = join(ROOT, '.claude', 'worktrees');

/** name → 起動するディレクトリ。'main' と省略はリポジトリ本体。 */
function dirFor(name) {
  if (!name || name === 'main') return ROOT;
  const dir = join(WT_ROOT, name);
  if (!existsSync(dir)) {
    console.error(red(`✗ worktree がありません: ${dir}`));
    console.error('  bash scripts/wt.sh list で一覧を確認してください。');
    process.exit(1);
  }
  return dir;
}

const stateFile = (name) => join(STATE_DIR, `${name}.json`);

function readState(name) {
  try {
    return JSON.parse(readFileSync(stateFile(name), 'utf8'));
  } catch {
    return null;
  }
}

/** 記録された pid がまだ生きているか。 */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function listRunning() {
  if (!existsSync(STATE_DIR)) return [];
  return readdirSync(STATE_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .map((name) => ({ name, state: readState(name) }))
    .filter((entry) => entry.state)
    .map((entry) => ({ ...entry, alive: alive(entry.state.pid) }));
}

function stop(name) {
  const state = readState(name);
  if (!state) {
    console.log(`${name}: 起動していません。`);
    return;
  }
  if (alive(state.pid)) {
    // detached で起動しているのでプロセスグループごと落とす（Vite は npm の子）。
    try {
      process.kill(-state.pid, 'SIGTERM');
    } catch {
      try {
        process.kill(state.pid, 'SIGTERM');
      } catch {
        // すでに終了している
      }
    }
  }
  rmSync(stateFile(name), { force: true });
  console.log(`${green('✓')} 停止しました: ${name}`);
}

/** 起動ログに URL が出るまで待つ。 */
async function waitForUrl(logPath, pid) {
  for (let i = 0; i < 120; i++) {
    if (!alive(pid)) return null;
    const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
    const match = log.match(/http:\/\/localhost:\d+\//);
    if (match) return match[0];
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

async function start(name) {
  const dir = dirFor(name);
  const key = name || 'main';

  const running = readState(key);
  if (running && alive(running.pid)) {
    console.log(`${green('✓')} すでに起動しています: ${bold(running.url)}`);
    console.log(dim(`  停止: node scripts/play.mjs --stop ${key}`));
    return;
  }

  if (!existsSync(join(dir, 'node_modules'))) {
    console.error(red(`✗ ${dir} に node_modules がありません。`));
    console.error('  先に npm install を実行してください。');
    process.exit(1);
  }

  mkdirSync(STATE_DIR, { recursive: true });
  const logPath = join(STATE_DIR, `${key}.log`);
  const log = openSync(logPath, 'w');

  const child = spawn('npm', ['run', 'dev'], {
    cwd: dir,
    detached: true, // 自分のプロセスグループを持たせて、まとめて停止できるようにする
    stdio: ['ignore', log, log],
  });
  child.unref();

  const url = await waitForUrl(logPath, child.pid);
  if (!url) {
    console.error(red('✗ 起動 URL を検出できませんでした。'));
    console.error(existsSync(logPath) ? readFileSync(logPath, 'utf8') : '');
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      // すでに終了している
    }
    process.exit(1);
  }

  writeFileSync(
    stateFile(key),
    JSON.stringify({ pid: child.pid, url, dir, startedAt: new Date().toISOString() }, null, 2),
  );

  console.log(`${green('✓')} ${bold(key)} を起動しました`);
  console.log(`  ${bold(url)}`);
  console.log(dim(`  停止: node scripts/play.mjs --stop ${key}`));
}

// --- main -----------------------------------------------------------------

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`使い方:
  node scripts/play.mjs --bg [name]     背面で起動して URL を出力する
  node scripts/play.mjs --list          起動中の一覧
  node scripts/play.mjs --stop <name>   停止（--stop --all で全部）`);
  process.exit(0);
}

if (args.includes('--stop')) {
  const targets = args.includes('--all')
    ? listRunning().map((entry) => entry.name)
    : [args.find((a) => !a.startsWith('--')) ?? 'main'];
  if (targets.length === 0) console.log('起動中の dev サーバーはありません。');
  for (const target of targets) stop(target);
  process.exit(0);
}

if (args.length === 0 || args.includes('--list')) {
  const running = listRunning();
  if (running.length === 0) {
    console.log('起動中の dev サーバーはありません。');
    console.log(dim('  起動: node scripts/play.mjs --bg [name]'));
    process.exit(0);
  }
  console.log(bold('起動中:'));
  for (const entry of running) {
    const mark = entry.alive ? green('●') : red('○');
    const note = entry.alive ? entry.state.url : dim('(プロセスが見つかりません)');
    console.log(`  ${mark} ${entry.name.padEnd(20)} ${note}`);
  }
  process.exit(0);
}

await start(args.find((a) => !a.startsWith('--')));
