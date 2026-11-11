# Comments

`difit comment` is how an agent reads a review and answers it on a running server.

## Sub-features

- `add`: new threads and replies, from an argument or stdin
- `get`: text for reading, `--format json` for thread IDs and `decisions`
- `wait`: blocks until a thread is the agent's turn, prints one JSON line per thread, exits 0
- `add` reply with `threadId`: attaches to that thread; duplicates are judged inside it
- `resolve` (alias `remove`): resolves threads by ID, only those every message of which is by `Agent` and the reviewer never reopened, and reports a thread already closed with ✓ as resolved

## How to get to it (user POV)

An agent runs these against the port `--background` printed. A reviewer's comments reach the same session from the browser.

## Driving it with harness.sh

```bash
( . "$S/env.sh"; cd "$REPO"
  difit comment add --port "$PORT" '{"type":"thread","author":"User","filePath":"math.js","position":{"side":"new","line":2},"body":"sub should subtract"}'
  difit comment get --port "$PORT"
  timeout 10 difit comment wait --port "$PORT"; echo "wait exit $?"
  ID=$(difit comment get --port "$PORT" --format json | node -p 'JSON.parse(require("fs").readFileSync(0)).threads[0].id')
  difit comment add --port "$PORT" '{"type":"reply","filePath":"math.js","position":{"side":"new","line":2},"body":"Looking at it."}'
  difit comment resolve --port "$PORT" "$ID"; echo "reviewer thread resolve exit $?"
  difit comment add --port "$PORT" '{"type":"thread","author":"octocat","filePath":"math.js","position":{"side":"new","line":1},"body":"imported"}'
  OTHER=$(difit comment get --port "$PORT" --format json | node -p 'JSON.parse(require("fs").readFileSync(0)).threads.find((t) => t.messages[0].author === "octocat").id')
  difit comment resolve --port "$PORT" "$OTHER"; echo "other author resolve exit $?"
  difit comment add --port "$PORT" '{"type":"thread","filePath":"math.js","position":{"side":"new","line":1},"body":"my note"}'
  MINE=$(difit comment get --port "$PORT" --format json | node -p 'JSON.parse(require("fs").readFileSync(0)).threads.find((t) => t.messages[0].author === "Agent").id')
  difit comment resolve --port "$PORT" "$MINE" does-not-exist; echo "resolve exit $?"
  difit comment get --port "$PORT" --format json; echo "decisions before the reviewer's own close"
  curl -s -X POST -H 'Content-Type: application/json' -d "[{\"threadId\":\"$ID\",\"kind\":\"resolved\",\"fixupSha\":\"\",\"at\":\"$(date -u +%FT%T.000Z)\"}]" "$URL/api/decisions"; echo
  difit comment resolve --port "$PORT" "$ID"; echo "closed reviewer thread resolve exit $?"
  sleep 1
  curl -s -X POST -H 'Content-Type: application/json' -d "[{\"threadId\":\"$ID\",\"kind\":\"unresolved\",\"fixupSha\":\"\",\"at\":\"$(date -u +%FT%T.000Z)\"}]" "$URL/api/decisions"; echo
  difit comment resolve --port "$PORT" "$ID"; echo "reopened reviewer thread resolve exit $?"
  difit comment add --port "$PORT" '{"type":"thread","filePath":"math.js","position":{"side":"new","line":3},"body":"second note"}'
  NOTE=$(difit comment get --port "$PORT" --format json | node -p 'JSON.parse(require("fs").readFileSync(0)).threads.find((t) => t.messages[0].body === "second note").id')
  difit comment resolve --port "$PORT" "$NOTE"; echo "agent thread resolve exit $?"
  sleep 1
  curl -s -X POST -H 'Content-Type: application/json' -d "[{\"threadId\":\"$NOTE\",\"kind\":\"unresolved\",\"fixupSha\":\"\",\"at\":\"$(date -u +%FT%T.000Z)\"}]" "$URL/api/decisions"; echo
  difit comment resolve --port "$PORT" "$NOTE"; echo "reopened agent thread resolve exit $?"
  difit comment get --port "$PORT" --format json
) 2>&1 | tee "$S/evidence/comments.txt"
```

Proof:

- `add` prints `{"success":true,…,"count":1,"warnings":[]}`.
- `get` shows `math.js:L2` with the state in brackets.
- `wait` prints a line with `threadId` and `"label":"답변 대기"`, and exits 0.
- `get --format json` then has a `decisions` entry of kind `handed` for that thread.
- `resolve` on the reviewer's thread (`"author":"User"`) prints its ID under `errors` with `Refused`, adds no `resolved` entry to `decisions` and exits 1. The same holds for `OTHER`, a thread added with an author other than `Agent`, such as a GitHub login.
- `resolve` on a thread added without an author (`MINE`) prints it under `resolved` and adds a `resolved` entry to `decisions`.
- `resolve` with `MINE` and an unknown ID prints `MINE` under `resolved` and the second under `notFound`, and exits 1.
- After the reviewer's own close, `resolve` on that thread prints it under `resolved`, exits 0 and adds no decision.
- A thread the reviewer reopened with the button (`resolved` then `unresolved` in `decisions`, posted to `/api/decisions` as the browser does) is still refused, and so is `NOTE`, a thread the agent opened that the reviewer reopened.

## Reply with `threadId`

Two User threads at `math.js` line 2, then replies naming each by `"threadId"`:

- the same body sent to both leaves each thread with two messages, and a repeat changes nothing;
- after the reviewer closes the first thread (`resolved` posted to `/api/decisions`), the same reply (same `id`) naming it again leaves both threads unchanged (no copy on the other);
- `threadId` that does not exist prints a `warnings` entry and stores nothing;
- `threadId` with another `position` stores on the named thread and prints a `warnings` entry;
- the same replies without `threadId` still go to the newest open thread at the place.

## Reopen on a newer commit

The browser's `다시 열기` asks `/api/diff` for the same base and the newer commit. The review it opens takes over every thread and decision of the review whose target is an ancestor of the new one, and the older review is gone. Start on a branch with two commits and a SHA target, add a line thread, a commit-level thread and a thread closed with `resolved`, then commit a change that shifts the commented file down a line:

```bash
( . "$S/env.sh"; cd "$REPO"
  BASE=$(git rev-parse HEAD~2); OLD=$(git rev-parse HEAD~1); NEW=$(git rev-parse HEAD)
  curl -s "$URL/api/diff?base=$BASE&target=$NEW" | jq -c '{review: .review.selection, reviewMoves}'
  difit comment get --port "$PORT"
  timeout 5 difit comment wait --port "$PORT"; echo "wait exit $?"
  curl -s "$URL/api/comments-json?base=$BASE&target=$NEW" | jq -c '{threads: [.threads[].id], decisions: [.decisions[] | {threadId, kind}]}'
  curl -s "$URL/api/diff?base=$BASE&target=$OLD" | jq -c '.review.selection'
) 2>&1 | tee "$S/evidence/reopen.txt"
```

Proof:

- `/api/diff` names the new review and one `reviewMoves` entry from the older review to it.
- `get` lists every open thread, and `wait` prints them at once and exits 0. The resolved thread is in neither.
- `comments-json` of the new review has every thread and the `resolved` decision.
- Asking for the older target again returns the new review as its `review`, and its threads stay there.
- A `POST /api/reword` in the new review refused with `comments-waiting` lists each open thread once, naming the new review.
- In the browser, the toolbar count stays the same, and a whole-view thread on a shifted line shows on its new line number.
- A history that was folded does not count: its old target is no ancestor, and the comments stay with the older review.

## Gotchas

- `"author":"User"` is what makes a thread the reviewer's. Without it the author is `Agent`, which is never the agent's turn, so `wait` blocks forever. Wrap `wait` in `timeout`.
- What `resolve` leaves in `threads` and `decisions` is defined by `src/cli/comment.ts` in the checkout you built. Read it before asserting that end state.
- `get` in text form has no thread IDs. Read IDs from `--format json`.
