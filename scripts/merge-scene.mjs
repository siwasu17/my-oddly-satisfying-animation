#!/usr/bin/env node
/**
 * scene/<name> を main にマージして、worktree とブランチまで片付ける。
 *
 *   npm run merge-scene <name>                停止 → マージ → 検証 → 後始末
 *   npm run merge-scene <name> -- --dry-run   実行するコマンドを並べるだけ
 *   npm run merge-scene <name> -- --keep      マージと検証だけ。worktree とブランチは残す
 *   npm run merge-scene -- --list             マージできる scene/* ブランチの一覧
 *
 * 手でやると事故る箇所を全部ここに閉じ込めてある:
 *   - worktree の中からは main にマージできない（main は親リポジトリのチェックアウト）
 *   - package-lock.json が衝突したときにマーカーを継ぎ接ぎすると壊れる
 *   - worktree で検証が通っていても、マージ後の main は別物
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ESC = '\u001b[';
const color = {
  dim: (s) => `${ESC}2m${s}${ESC}0m`,
  bold: (s) => `${ESC}1m${s}${ESC}0m`,
  green: (s) => `${ESC}32m${s}${ESC}0m`,
  yellow: (s) => `${ESC}33m${s}${ESC}0m`,
  red: (s) => `${ESC}31m${s}${ESC}0m`,
};

function usage() {
  console.log(`使い方:
  npm run merge-scene <name>                マージして worktree とブランチまで片付ける
  npm run merge-scene <name> -- --dry-run   実行するコマンドを並べるだけ
  npm run merge-scene <name> -- --keep      マージと検証だけ。worktree とブランチは残す
  npm run merge-scene -- --list             マージできる scene/* ブランチの一覧`);
}

// --- コマンド実行 ---------------------------------------------------------

/** 出力を取り込んで実行する。失敗しても投げない。 */
function run(cmd, args, cwd) {
  const result = spawnSync(cmd, args, { cwd: cwd ?? REPO_ROOT, encoding: 'utf8' });
  return {
    ok: result.status === 0,
    out: (result.stdout ?? '').trim(),
    err: (result.stderr ?? '').trim(),
  };
}

/** 出力をそのまま端末に流して実行する。npm のような長い処理向け。 */
function runLive(cmd, args, cwd) {
  console.log(color.dim(`  $ ${cmd} ${args.join(' ')}`));
  const result = spawnSync(cmd, args, { cwd: cwd ?? REPO_ROOT, stdio: 'inherit' });
  return result.status === 0;
}

const git = (args, cwd) => run('git', args, cwd);

/** 失敗を許さない git。読み取り専用のものにだけ使う。 */
function gitOut(args, cwd) {
  const result = git(args, cwd);
  if (!result.ok) {
    console.error(color.red(`✗ git ${args.join(' ')} に失敗しました`));
    if (result.err) console.error(result.err);
    process.exit(1);
  }
  return result.out;
}

function fail(message, ...details) {
  console.error(color.red(`✗ ${message}`));
  for (const line of details) console.error(`  ${line}`);
  process.exit(1);
}

// --- リポジトリの場所 -----------------------------------------------------

// ここだけは cwd（実行された場所）で見る。REPO_ROOT で見ると、worktree の中から
// 呼ばれても親リポジトリの値が返ってしまい、Step 0 の判定がすり抜ける。
const where = spawnSync(
  'git',
  ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'],
  { encoding: 'utf8' },
);
if (where.status !== 0) {
  console.error(color.red('✗ git リポジトリの中で実行してください。'));
  process.exit(1);
}
const [GIT_DIR, GIT_COMMON_DIR] = where.stdout.trim().split('\n');
const REPO_ROOT = dirname(GIT_COMMON_DIR);

// --- worktree の情報 ------------------------------------------------------

/** `git worktree list --porcelain` を解析して、ブランチかパスで 1 つ引く。 */
function findWorktree(name, branch) {
  const blocks = gitOut(['worktree', 'list', '--porcelain']).split('\n\n');
  const suffix = join('.claude', 'worktrees', name);

  for (const block of blocks) {
    const lines = block.split('\n');
    const path = lines.find((l) => l.startsWith('worktree '))?.slice('worktree '.length);
    if (!path) continue;
    const ref = lines.find((l) => l.startsWith('branch '))?.slice('branch '.length);
    const locked = lines.some((l) => l === 'locked' || l.startsWith('locked '));
    if (ref === `refs/heads/${branch}` || path.endsWith(suffix)) {
      return { path, locked, branch: ref };
    }
  }
  return null;
}

function listMergeable() {
  const branches = gitOut(['branch', '--list', 'scene/*', '--format=%(refname:short)'])
    .split('\n')
    .filter(Boolean);
  if (branches.length === 0) {
    console.log('マージできる scene/* ブランチはありません。');
    return;
  }
  console.log(color.bold('マージできるブランチ:'));
  for (const branch of branches) {
    const name = branch.slice('scene/'.length);
    const wt = findWorktree(name, branch);
    const note = wt ? color.dim(`  worktree: ${wt.path}${wt.locked ? ' (locked)' : ''}`) : '';
    console.log(`  ${name.padEnd(22)}${note}`);
  }
}

// --- main -----------------------------------------------------------------

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  usage();
  process.exit(0);
}

if (args.includes('--list')) {
  listMergeable();
  process.exit(0);
}

const dryRun = args.includes('--dry-run');
const keep = args.includes('--keep');
const name = args.find((a) => !a.startsWith('--'));

if (!name) {
  usage();
  console.log('');
  listMergeable();
  process.exit(1);
}

const branch = `scene/${name}`;

// --- Step 0: 実行場所の確認 -----------------------------------------------

// worktree では専用の .git ディレクトリを持つので、共通の .git とは別の場所を指す。
if (GIT_DIR !== GIT_COMMON_DIR) {
  fail(
    'worktree の中では実行できません。',
    'main は親リポジトリでチェックアウトされているため、そちらで実行してください。',
    'Claude Code のセッションなら ExitWorktree({ action: "keep" }) で抜けてから。',
    color.dim('（remove で抜けるとブランチごと消えてコミットを失います）'),
  );
}

// --- Step 1: 事前チェック -------------------------------------------------

const head = gitOut(['rev-parse', '--abbrev-ref', 'HEAD']);
if (head !== 'main') {
  fail(`いまのブランチは ${head} です。main で実行してください。`);
}

if (gitOut(['status', '--porcelain']) !== '') {
  fail(
    'main に未コミットの変更があります。',
    '先に片付けてください（マージ後に巻き戻せなくなるため、この状態では進みません）。',
  );
}

if (!git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).ok) {
  console.error(color.red(`✗ ブランチ ${branch} がありません。`));
  console.error('');
  listMergeable();
  process.exit(1);
}

const changed = gitOut(['diff', '--name-only', `main...${branch}`]).split('\n').filter(Boolean);
if (changed.length === 0) {
  fail(`${branch} は main と差分がありません。`, '取り込むものがないブランチです。');
}

// 共有ファイルを触っているブランチは、取り込む前に中身を見てほしい。
const shared = changed.filter((f) => !/^src\/scenes\/[^/]+\.ts$/.test(f));
if (shared.length > 0) {
  console.log(color.yellow('! このブランチは共有ファイルも変更しています:'));
  for (const file of shared) console.log(`    ${file}`);
  console.log(color.dim('  意図した変更か確認してから取り込んでください。'));
  console.log('');
}

const worktree = findWorktree(name, branch);
if (worktree) {
  if (worktree.locked) {
    fail(
      `worktree ${worktree.path} は locked です。`,
      '他のセッションが作業中の可能性があります。触らずに終了します。',
    );
  }
  const dirty = git(['status', '--porcelain'], worktree.path);
  if (dirty.ok && dirty.out !== '') {
    fail(
      `worktree ${worktree.path} に未コミットの変更があります。`,
      'マージすると取りこぼすので、先にコミットするか捨ててください。',
    );
  }
}

const before = gitOut(['rev-parse', 'HEAD']);

console.log(color.bold(`${branch} を main にマージします`));
console.log(
  color.dim(
    `  main: ${before.slice(0, 7)}  ${branch}: ${gitOut(['rev-parse', '--short', branch])}`,
  ),
);
console.log(color.dim(`  変更: ${changed.join(', ')}`));
if (worktree) console.log(color.dim(`  worktree: ${worktree.path}`));
console.log('');

if (dryRun) {
  console.log(color.yellow('--dry-run: 実行するのは次のコマンドです。'));
  console.log(`  node scripts/play.mjs --stop ${name}`);
  console.log(`  git merge --no-ff ${branch} -m "Merge branch '${branch}'"`);
  console.log(color.dim('  # package-lock.json が衝突したら:'));
  console.log(color.dim('  git checkout HEAD -- package-lock.json'));
  console.log(color.dim('  npm install --package-lock-only'));
  console.log(color.dim('  git add package-lock.json && git commit --no-edit'));
  console.log(color.dim('  # package-lock.json が動いていたら:'));
  console.log(color.dim('  npm ci'));
  console.log('  npm run build');
  if (!keep) {
    if (worktree) console.log(`  git worktree remove ${worktree.path}`);
    console.log(`  git branch -d ${branch}`);
  }
  console.log('');
  console.log(color.dim('検証に失敗した場合は git reset --hard で元に戻します。'));
  process.exit(0);
}

// --- Step 2: dev サーバーを止める -----------------------------------------

// worktree を消す前に止める。消してからだとプロセスの作業ディレクトリが無くなる。
const stopped = run('node', [join(REPO_ROOT, 'scripts', 'play.mjs'), '--stop', name]);
if (stopped.out) console.log(color.dim(`  ${stopped.out}`));

// --- Step 3: マージ -------------------------------------------------------

let lockRegenerated = false;

const merge = git(['merge', '--no-ff', branch, '-m', `Merge branch '${branch}'`]);
if (!merge.ok) {
  const conflicts = gitOut(['diff', '--name-only', '--diff-filter=U']).split('\n').filter(Boolean);
  const onlyLockfile = conflicts.length > 0 && conflicts.every((f) => f === 'package-lock.json');

  if (!onlyLockfile) {
    git(['merge', '--abort']);
    fail(
      'マージが衝突しました。自動では解決できません。',
      `衝突: ${conflicts.join(', ') || '(不明)'}`,
      'マージは中断済みで、main は元のままです。手で解決してください。',
    );
  }

  // マーカーを継ぎ接ぎせず、main 側を採用してから作り直す。
  console.log(color.yellow('! package-lock.json が衝突しました。作り直して解決します。'));
  if (!git(['checkout', 'HEAD', '--', 'package-lock.json']).ok) {
    fail('package-lock.json を main 側に戻せませんでした。', 'git merge --abort で中断してください。');
  }
  if (!runLive('npm', ['install', '--package-lock-only', '--no-audit', '--no-fund'])) {
    fail('npm install --package-lock-only に失敗しました。', 'git merge --abort で中断してください。');
  }
  git(['add', 'package-lock.json']);

  const stillConflicted = gitOut(['diff', '--name-only', '--diff-filter=U']);
  if (stillConflicted !== '') {
    fail('未解決の衝突が残っています。', stillConflicted.replaceAll('\n', ', '));
  }
  if (!git(['commit', '--no-edit']).ok) {
    fail('マージコミットを作れませんでした。');
  }
  lockRegenerated = true;
}

const mergeCommit = gitOut(['rev-parse', 'HEAD']);
console.log(`${color.green('✓')} マージしました ${color.bold(mergeCommit.slice(0, 7))}`);

// --- Step 4: マージ後の main で検証 ---------------------------------------

/** 検証に失敗したらマージを取り消して終了する。 */
function rollback(what) {
  console.error('');
  console.error(color.red(`✗ ${what} に失敗しました。マージを取り消します。`));

  if (gitOut(['rev-parse', 'HEAD']) !== mergeCommit) {
    fail(
      '他のコミットが積まれているため自動では戻せません。',
      `手で戻す場合: git reset --hard ${before.slice(0, 7)}`,
    );
  }
  if (!git(['reset', '--hard', before]).ok) {
    fail('巻き戻しに失敗しました。', `手で戻してください: git reset --hard ${before.slice(0, 7)}`);
  }

  console.error(color.yellow(`  main を ${before.slice(0, 7)} に戻しました。`));
  console.error(`  worktree とブランチ ${branch} はそのまま残しています。直して再実行してください。`);
  process.exit(1);
}

console.log('');
console.log(color.bold('マージ後の main で検証します'));

const lockChanged =
  lockRegenerated ||
  gitOut(['diff', '--name-only', before, mergeCommit, '--', 'package-lock.json']) !== '';

if (lockChanged || !existsSync(join(REPO_ROOT, 'node_modules'))) {
  if (!runLive('npm', ['ci', '--no-audit', '--no-fund'])) rollback('npm ci');
}
// build は tsc --noEmit を含むので、型チェックはこれで足りる。
if (!runLive('npm', ['run', 'build'])) rollback('build');
console.log(`${color.green('✓')} typecheck / build が通りました`);

// --- Step 5: 後始末 -------------------------------------------------------

const removed = [];

if (keep) {
  console.log(color.dim(`--keep: worktree とブランチ ${branch} は残しました。`));
} else {
  if (worktree) {
    const result = git(['worktree', 'remove', worktree.path]);
    if (result.ok) removed.push(`worktree ${worktree.path}`);
    else console.error(color.yellow(`! worktree を削除できませんでした: ${result.err}`));
  }
  // -d のまま使う。取りこぼしがあれば git が拒否してくれる。
  const deleted = git(['branch', '-d', branch]);
  if (deleted.ok) removed.push(`ブランチ ${branch}`);
  else console.error(color.yellow(`! ブランチを削除できませんでした: ${deleted.err}`));
}

// --- Step 6: 報告 ---------------------------------------------------------

console.log('');
console.log(`${color.green('✓')} ${color.bold(name)} を main に取り込みました`);
console.log(`  マージコミット: ${mergeCommit.slice(0, 7)}`);
if (lockRegenerated) console.log('  package-lock.json: 衝突したため作り直しました');
for (const item of removed) console.log(`  削除: ${item}`);
console.log(color.dim('  push はしていません。必要なら git push origin main を実行してください。'));
