# Fixup review

An agent answers a thread with a fixup commit carrying a `Review-Thread` trailer. The reviewer approves or rejects it. [`docs/agent-review.md`](../../../../docs/agent-review.md) is the full procedure and states every thread state.

## Sub-features

- A fixup commit linked to a thread by its trailer
- `/api/fixups`, which lists fixups on the reviewed commit with their `threadIds`
- Approve and reject, recorded in `decisions`

## How to get to it (user POV)

The reviewer comments in the browser, the agent commits a fixup, and the card shows it under the line with approve and reject buttons.

## Driving it with harness.sh

Approve and reject are browser actions with no CLI, so they go to the API the browser writes to.

```bash
( . "$S/env.sh"; cd "$REPO"
  difit comment add --port "$PORT" '{"type":"thread","author":"User","filePath":"math.js","position":{"side":"new","line":2},"body":"sub should subtract"}'
  ID=$(difit comment get --port "$PORT" --format json | node -p 'JSON.parse(require("fs").readFileSync(0)).threads[0].id')
  sed -i '2s/a + b/a - b/' math.js
  git commit -q -a --fixup=HEAD --trailer "Review-Thread: $ID"
  git log -2 --format='%h %s | %(trailers:key=Review-Thread,valueonly)'
  curl -s "$URL/api/fixups" > "$EVIDENCE/fixups.json"
  difit comment get --port "$PORT"
  SHA=$(git rev-parse HEAD)
  curl -s -X POST -H 'Content-Type: application/json' \
    -d "[{\"threadId\":\"$ID\",\"kind\":\"approved\",\"fixupSha\":\"$SHA\",\"at\":\"$(date -u +%FT%T.000Z)\"}]" "$URL/api/decisions"
  difit comment get --port "$PORT"
) 2>&1 | tee "$S/evidence/fixup.txt"
```

Proof:

- `/api/fixups` lists the commit with `subject` `fixup! add sub` and `threadIds` holding the thread ID.
- `get` moves the thread from `[답변 대기]` to `[승인 대기]`, then to `[승인됨]` after the decision.
- `/api/decisions` answers `{"success":true,"changed":true,…}`.

A fixup that renames a file, in a repository that turns rename detection off, runs the same way. Set this before `harness.sh start`, then use `git mv math.js calc.js`, `git commit --fixup=<reviewed sha> --trailer "Review-Thread: $ID"`, and a second fixup that edits `calc.js`:

```bash
( . "$S/env.sh"; cd "$REPO"; git config diff.renames false )
```

Proof: `/api/fixups` lists the first with `status` `renamed`, `path` `calc.js` and `oldPath` `math.js`, and the second with its changed lines under `calc.js`. `get` shows `[승인 대기]`, and `/api/diff` still shows `math.js` on the reviewed commit.

A thread added with `comment add` (or `--comment` at startup) on a review pinned to a range of several commits gets its `fixupTarget` when the server takes it in, by the rule the screen uses. Start the server on the range (`difit HEAD HEAD~3 --background`) and add a thread on a line an earlier commit of the range wrote.

Proof: `get` prints `고쳐 넣을 커밋: <that commit>` under the thread, and `get --format json` carries its full SHA as `fixupTarget`. A line the range did not change gets the range's last commit. A reply, and a thread on a review that follows a branch or the working tree, get none.

## Gotchas

- The body of `/api/decisions` is a bare array. An object answers 400 `Expected an array of review decisions`.
- Decision times are in `at`, not `createdAt`. A decision with an unknown field shape is rejected the same way.
- Use `--fixup=<sha>` on the reviewed commit. After the first fixup, `HEAD` is the fixup itself.
