# Comments

`difit comment` is how an agent reads a review and answers it on a running server.

## Sub-features

- `add`: new threads and replies, from an argument or stdin
- `get`: text for reading, `--format json` for thread IDs and `decisions`, `--left-out` for the threads left out because their file is not in the diff; a thread whose lines moved since it was made gets the line found now plus `처음 단 줄:`, or `바뀐 줄:` with the reason, and in JSON an entry in `placements`
- `wait`: blocks until a thread is the agent's turn, prints one JSON line per thread, exits 0
- `wait` after the reviewer's `리뷰 끝` button (`POST /api/review-done`): prints `{"state":"review-done"}` and exits 0
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
- `get --format json` has `"placements": {}` while no thread's lines moved. `/api/comments-json` without `?placements=true` has no `placements` key.
- `wait` prints a line with `threadId` and `"label":"답변 대기"`, and exits 0.
- `get --format json` then has a `decisions` entry of kind `handed` for that thread.
- `resolve` on the reviewer's thread (`"author":"User"`) prints its ID under `errors` with `Refused`, adds no `resolved` entry to `decisions` and exits 1. The same holds for `OTHER`, a thread added with an author other than `Agent`, such as a GitHub login.
- `resolve` on a thread added without an author (`MINE`) prints it under `resolved` and adds a `resolved` entry to `decisions`.
- `resolve` with `MINE` and an unknown ID prints `MINE` under `resolved` and the second under `notFound`, and exits 1.
- After the reviewer's own close, `resolve` on that thread prints it under `resolved`, exits 0 and adds no decision.
- A thread the reviewer reopened with the button (`resolved` then `unresolved` in `decisions`, posted to `/api/decisions` as the browser does) is still refused, and so is `NOTE`, a thread the agent opened that the reviewer reopened.

## Review done

On a review with no thread waiting for the agent (a fresh `harness.sh` server), with the wait started first:

```bash
( . "$S/env.sh"; cd "$REPO"
  difit comment wait --port "$PORT" > "$S/wait.out" & WAIT=$!
  sleep 1
  curl -s -X POST "$URL/api/review-done"; echo
  wait $WAIT; echo "wait exit $?"; cat "$S/wait.out"
  timeout 10 difit comment wait --port "$PORT"; echo "later wait exit $?"
  difit comment add --port "$PORT" '{"type":"thread","author":"User","filePath":"math.js","position":{"side":"new","line":2},"body":"one more"}'
  difit comment get --port "$PORT" --format json
) 2>&1 | tee "$S/evidence/review-done.txt"
```

Proof:

- the waiting command exits 0 and its standard output is the one line `{"state":"review-done"}`;
- a wait started afterwards prints the same line at once;
- `get --format json` has `"reviewDone":true` after the button and loses it once a `User` comment is added.

## Reply with `threadId`

Two User threads at `math.js` line 2, then replies naming each by `"threadId"`:

- the same body sent to both leaves each thread with two messages, and a repeat changes nothing;
- after the reviewer closes the first thread (`resolved` posted to `/api/decisions`), the same reply (same `id`) naming it again leaves both threads unchanged (no copy on the other);
- `threadId` that does not exist prints a `warnings` entry and stores nothing;
- `threadId` with another `position` stores on the named thread and prints a `warnings` entry;
- the same replies without `threadId` still go to the newest open thread at the place.

## Stored reviews

The server writes threads, replies and decisions to `$DIFIT_CONFIG_DIR/reviews/<repository>.json` before it answers, and a server started again reads them back. End the server yourself (`kill -TERM` or `kill -KILL` on the `pid` in `$S/server.json`), then `harness.sh start "$S" …` again:

- same range: `get --format json` has the same `threads` and `decisions` as before the kill, `codeSnapshot` included;
- after a commit that deletes a commented line, started on the same compare-with side: `get` shows that thread with `바뀐 줄:` under its location;
- after a commit that takes a commented file out of the diff: the thread is in neither `get` output nor `wait`, and `get --left-out` lists it (`--format json` for the threads);
- `add` of a thread on a file the diff does not have: a `warnings` entry starting `Left out 1 thread(s)`, and the thread only in `get --left-out`;
- `start "$S" --repo <another worktree of $REPO> …`: the same threads;
- `start "$S" … --clean`: `get` and `get --left-out` print nothing, and so does the next start without `--clean`.

Give a reviewer thread its `codeSnapshot` (`{"content":"<the line>","commit":"<short target SHA>"}`) as the browser does; without it there is nothing to find the line by.

## Session status

`GET /api/session-status` is what the page header shows: `waits` (open `comment wait` connections), `checkedAgoMs` (since the server last saw one connect, ping or close; `null` when none ever came) and `connected` (a wait is open, or the last closed less than two minutes ago).

```bash
( . "$S/env.sh"; cd "$REPO"
  curl -s "$URL/api/session-status"; echo
  ( timeout 40 difit comment wait --port "$PORT" ) &
  sleep 2; curl -s "$URL/api/session-status"; echo
  wait; curl -s "$URL/api/session-status"; echo
  sleep 125; curl -s "$URL/api/session-status"; echo
) 2>&1 | tee "$S/evidence/session-status.txt"
```

Proof: `{"waits":0,"checkedAgoMs":null,"connected":false}` before any wait; `waits` 1 and `connected` true while it runs, with `checkedAgoMs` under 30000 even past 30 seconds; `waits` 0 and `connected` true right after it ends; `connected` false once two minutes pass.

## Gotchas

- `"author":"User"` is what makes a thread the reviewer's. Without it the author is `Agent`, which is never the agent's turn, so `wait` blocks forever. Wrap `wait` in `timeout`.
- What `resolve` leaves in `threads` and `decisions` is defined by `src/cli/comment.ts` in the checkout you built. Read it before asserting that end state.
- `get` in text form has no thread IDs. Read IDs from `--format json`.
- `get` relocates a moved thread on the diff of the screen it was made on (`view`), with whitespace-only changes ignored as the screen does when it opens. Unchecking Ignore Whitespace on the screen can show a different line.
