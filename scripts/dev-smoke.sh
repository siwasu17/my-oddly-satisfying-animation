#!/usr/bin/env bash
# dev サーバーを立てて配信を確認し、必ず落とす。
#
#   bash scripts/dev-smoke.sh [scene-name]
#
# scene-name は src/scenes/<name>.ts の名前（camelCase）。省略するとアプリ全体だけを見る。
#
# 完了報告の前の動作確認用。build が通っても、#app が見つからない・
# モジュール解決に失敗する、といった実行時の問題は build では拾えない。
#
# 終了時は trap で必ず dev サーバーを停止する。立てっぱなしにすると
# 並列セッションのポートを食いつぶすため。ポートは指定しない（Vite が自動で繰り上げる）。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAME="${1:-}"

if [ -n "$NAME" ] && [ ! -f "${ROOT}/src/scenes/${NAME}.ts" ]; then
  echo "src/scenes/${NAME}.ts が見つかりません。" >&2
  echo "シーン名は camelCase（例: koiPond）で渡してください。" >&2
  exit 1
fi

LOG="$(mktemp -t dev-smoke-XXXXXX.log)"
PID=""

cleanup() {
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    # Vite は npm の子プロセスなのでプロセスグループごと落とす。
    kill -- "-${PID}" 2>/dev/null || kill "$PID" 2>/dev/null
    wait "$PID" 2>/dev/null
  fi
  rm -f "$LOG"
}
trap cleanup EXIT INT TERM

echo "dev サーバーを起動しています ..."
# 独自のプロセスグループで起動して、まとめて停止できるようにする。
( cd "$ROOT" && set -m && exec npm run dev ) > "$LOG" 2>&1 &
PID=$!

URL=""
for _ in $(seq 1 60); do
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "✗ dev サーバーが起動前に終了しました。" >&2
    cat "$LOG" >&2
    exit 1
  fi
  URL="$(grep -o 'http://localhost:[0-9]*/' "$LOG" 2>/dev/null | head -1)"
  [ -n "$URL" ] && break
  perl -e 'select(undef,undef,undef,0.25)'
done

if [ -z "$URL" ]; then
  echo "✗ 起動 URL を検出できませんでした（タイムアウト）。" >&2
  cat "$LOG" >&2
  exit 1
fi

echo "  URL: ${URL}"
FAILED=0

# 1. index.html が 200 を返し、#app が入っていること
HTML="$(curl -fsS "$URL" 2>/dev/null)"
if [ -z "$HTML" ]; then
  echo "✗ index.html を取得できませんでした" >&2
  FAILED=1
elif ! printf '%s' "$HTML" | grep -q 'id="app"'; then
  echo "✗ index.html に #app がありません" >&2
  FAILED=1
else
  echo "✓ index.html"
fi

# 2. main.ts が Vite に変換されて配信されること（import が書き換わっているか）
MAIN="$(curl -fsS "${URL}src/main.ts" 2>/dev/null)"
if [ -z "$MAIN" ]; then
  echo "✗ src/main.ts を取得できませんでした" >&2
  FAILED=1
elif ! printf '%s' "$MAIN" | grep -q 'import .* from "/'; then
  echo "✗ src/main.ts が変換されていません（モジュール解決に失敗している可能性）" >&2
  printf '%s\n' "$MAIN" | head -5 >&2
  FAILED=1
else
  echo "✓ src/main.ts（モジュール解決 OK）"
fi

# 3. シーンのレジストリが自分のシーンを拾っていること
if [ -n "$NAME" ]; then
  INDEX="$(curl -fsS "${URL}src/scenes/index.ts" 2>/dev/null)"
  if [ -z "$INDEX" ]; then
    echo "✗ src/scenes/index.ts を取得できませんでした" >&2
    FAILED=1
  elif ! printf '%s' "$INDEX" | grep -q "/src/scenes/${NAME}.ts"; then
    echo "✗ src/scenes/index.ts が ${NAME} を読み込んでいません" >&2
    FAILED=1
  else
    echo "✓ src/scenes/index.ts が ${NAME} を収集"
  fi

  SCENE="$(curl -fsS "${URL}src/scenes/${NAME}.ts" 2>/dev/null)"
  if [ -z "$SCENE" ]; then
    echo "✗ src/scenes/${NAME}.ts を取得できませんでした" >&2
    FAILED=1
  else
    echo "✓ src/scenes/${NAME}.ts"
  fi
fi

# 4. 起動ログにエラーが出ていないこと
if grep -qiE '\[vite\].*(error|failed)|Internal server error' "$LOG"; then
  echo "✗ dev サーバーのログにエラーがあります" >&2
  grep -iE '\[vite\].*(error|failed)|Internal server error' "$LOG" | head -5 >&2
  FAILED=1
fi

if [ "$FAILED" -ne 0 ]; then
  echo "" >&2
  echo "dev-smoke 失敗" >&2
  exit 1
fi

echo ""
echo "✓ dev-smoke 成功"
