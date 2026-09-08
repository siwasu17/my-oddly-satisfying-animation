# ブラウザ自動操作（agent-browser / npm run shot）

Claude Code のセッションからこのアプリを目視確認するための手順とハマりどころ。
毎回読む必要はないので `CLAUDE.md` から分けてある。規則そのもの（`npm run shot` を使う）は
`CLAUDE.md` の「ブラウザで見るとき」にある。

## シーンを見るときは `npm run shot`

```bash
npm run shot -- <camelCase>
```

シーンの通し番号を `src/scenes/index.ts` と同じ規則で割り出して `<url>#N` へ直行し、
960x600 で撮り、**ページ内の JS エラーがあれば非ゼロで終了する**。
dev サーバーが立っていなければ背面で起動し、worktree ごとにポートもブラウザセッションも分ける。

タブを `snapshot -i` して `click` で探しに行かないこと。ref は操作のたびに振り直されるので、
`✗ Unknown ref` と再 snapshot の往復に落ちる。`#N` なら 1 回で決まる。

`build()` の中で投げられた例外は `typecheck` も `build` も `smoke` も拾えない。
`npm run shot` のエラー判定がその唯一の網になっている。

## それ以外の用途で agent-browser を使うとき

Run `agent-browser --help` for all commands.

1. `agent-browser open <url>` - Navigate to page
2. `agent-browser snapshot -i` - Get interactive elements with refs (@e1, @e2)
3. `agent-browser click @e1` / `fill @e2 "text"` - Interact using refs
4. Re-snapshot after page changes

## サンドボックス環境での起動フラグ

Claude Code をサンドボックス（cage など）付きで動かしていると、`agent-browser open` が
`Auto-launch failed: CDP response channel closed` で失敗する。macOS の seatbelt サンドボックスは
入れ子にできず、Chrome が自前のサンドボックスを初期化できないためで、ディレクトリの
書き込み許可を足しても解消しない。

**このフラグは `.claude/settings.json` の `env` に入れてあるので、通常は何もしなくてよい。**
`export` を毎回前置きしないこと。

```jsonc
"env": { "AGENT_BROWSER_ARGS": "--no-sandbox,--disable-gpu,--disable-crash-reporter,--disable-breakpad" }
```

- `--no-sandbox` … 入れ子サンドボックスの失敗を回避する（これが本体）
- `--disable-gpu` … GPU プロセス起動失敗による `GPU process isn't usable. Goodbye.` を避ける
- `--disable-crash-reporter` `--disable-breakpad` … Crashpad が
  `~/Library/Application Support/Google/Chrome for Testing/` に書けずに出すエラーを黙らせる

設定は**セッション起動時に読まれる**ので、効いていないと感じたら
`echo $AGENT_BROWSER_ARGS` で確認し、空ならその場だけ `export` する。

`~/.agent-browser`（セッション状態・ソケット・Chrome バイナリ）への書き込みは必須。
並列セッションでタブを取り合わないよう、`AGENT_BROWSER_SESSION` をセッションごとに分ける
（`npm run shot` は worktree 名から `osa-<name>` を自動で設定する）。
