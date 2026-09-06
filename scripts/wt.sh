#!/usr/bin/env bash
# 並列作業用の git worktree を管理する。
#
#   bash scripts/wt.sh new <scene-name>   worktree + scene/<name> ブランチを作って npm install
#   bash scripts/wt.sh list               現在の worktree 一覧
#   bash scripts/wt.sh rm <scene-name>    worktree を削除（ブランチは残す）
#
# worktree は .claude/worktrees/<name> に置く。このディレクトリは .gitignore に
# 入れてあるので、親リポジトリ側の git status や検索が他セッションの作業を拾うことはない。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WT_ROOT="${ROOT}/.claude/worktrees"

usage() {
  sed -n '2,9p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 1
}

cmd="${1:-}"
name="${2:-}"

case "$cmd" in
  new)
    [ -n "$name" ] || usage

    if ! printf '%s' "$name" | grep -Eq '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'; then
      echo "不正な名前です: \"$name\"" >&2
      echo "kebab-case（小文字英数とハイフン、先頭は英字）で指定してください。例: koi-pond" >&2
      exit 1
    fi

    branch="scene/${name}"
    dir="${WT_ROOT}/${name}"

    if [ -e "$dir" ]; then
      echo "既に存在します: $dir" >&2
      exit 1
    fi

    mkdir -p "$WT_ROOT"

    if git -C "$ROOT" show-ref --verify --quiet "refs/heads/${branch}"; then
      echo "既存ブランチ ${branch} を worktree に割り当てます。"
      git -C "$ROOT" worktree add "$dir" "$branch"
    else
      # 分岐元はローカルの現在の HEAD。push していない main の変更も持ち込む。
      git -C "$ROOT" worktree add -b "$branch" "$dir" HEAD
    fi

    echo ""
    echo "依存をインストールしています (${dir}) ..."
    # worktree には node_modules が無い。依存は three と vite だけなので短い。
    (cd "$dir" && npm install --no-audit --no-fund)

    echo ""
    echo "✓ worktree の準備ができました。"
    echo ""
    echo "  cd ${dir}"
    echo "  claude"
    echo ""
    echo "ブランチ: ${branch}"
    ;;

  list)
    git -C "$ROOT" worktree list
    ;;

  rm)
    [ -n "$name" ] || usage
    dir="${WT_ROOT}/${name}"
    git -C "$ROOT" worktree remove "$dir"
    echo "✓ worktree を削除しました: $dir"
    echo "  ブランチ scene/${name} は残しています（不要なら git branch -d scene/${name}）。"
    ;;

  *)
    usage
    ;;
esac
