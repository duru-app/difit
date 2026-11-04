# Review server

`difit <target> [compare-with]` starts a local server that serves one diff to the browser and to agents.

## Sub-features

- A commit (`HEAD`, a SHA), a range (`<target> <base>`), the working tree (`.`, `staged`, `working`)
- A unified diff from stdin (`-`)
- `--include-untracked` on working-tree targets
- `--background`, which detaches the server and prints its port as JSON

## How to get to it (user POV)

The user or an agent runs `difit` inside a repository. Agents use `--background` and read the port it prints.

## Driving it with harness.sh

```bash
bash .claude/skills/verify-difit/harness.sh start "$S"            # or: start "$S" . --include-untracked
( . "$S/env.sh"; curl -s "$URL/api/diff" ) > "$S/evidence/diff.json"
```

For stdin, skip `harness.sh start`. The server stays in the foreground, so `timeout` ends it:

```bash
( . "$S/env.sh"; cd "$REPO"
  git show HEAD | timeout 8 difit - --no-open --keep-alive > "$EVIDENCE/stdin.txt" 2>&1 &
  for _ in $(seq 25); do grep -q 'server started on' "$EVIDENCE/stdin.txt" 2>/dev/null && break; sleep 0.2; done
  curl -s "$(grep -oE 'http://localhost:[0-9]+' "$EVIDENCE/stdin.txt" | head -1)/api/diff" > "$EVIDENCE/stdin-diff.json"
  wait
)
```

Proof: `/api/diff` returns `files[]` with `math.js`, `additions` 1 and `deletions` 0 for `HEAD`. For a commit target, `baseCommitish` and `targetCommitish` also name the commits asked for.

## Gotchas

- `git show HEAD | difit - --background` fails with `No diff content received from stdin`, because the background child starts with stdin ignored. This is defect #219, not a sandbox problem, until that issue is closed.
- `harness.sh start` records its server for `doctor` and `stop`. A server you start by hand is yours to stop.
- Without `--background` or `--no-open` a run opens a browser. Always pass one of them here.
- Inside a Claude Code session difit inherits `CLAUDE_CODE_MESSAGING_SOCKET` and sends review messages to that session. `env.sh` unsets it, so sandbox runs stay silent.
