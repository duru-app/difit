# Comments

`difit comment` is how an agent reads a review and answers it on a running server.

## Sub-features

- `add`: new threads and replies, from an argument or stdin
- `get`: text for reading, `--format json` for thread IDs and `decisions`
- `wait`: blocks until a thread is the agent's turn, prints one JSON line per thread, exits 0
- `add` reply with `threadId`: attaches to that thread; duplicates are judged inside it
- `resolve` (alias `remove`): resolves threads by ID

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
  difit comment resolve --port "$PORT" "$ID" does-not-exist; echo "resolve exit $?"
  difit comment get --port "$PORT" --format json
) 2>&1 | tee "$S/evidence/comments.txt"
```

Proof:

- `add` prints `{"success":true,…,"count":1,"warnings":[]}`.
- `get` shows `math.js:L2` with the state in brackets.
- `wait` prints a line with `threadId` and `"label":"답변 대기"`, and exits 0.
- `get --format json` then has a `decisions` entry of kind `handed` for that thread.
- `resolve` with one real and one unknown ID prints the first under `resolved` and the second under `notFound`, and exits 1.

## Reply with `threadId`

Two User threads at `math.js` line 2, then replies naming each by `"threadId"`:

- the same body sent to both leaves each thread with two messages, and a repeat changes nothing;
- after `resolve` of the first thread, the same reply (same `id`) naming it again leaves both threads unchanged (no copy on the other);
- `threadId` that does not exist prints a `warnings` entry and stores nothing;
- `threadId` with another `position` stores on the named thread and prints a `warnings` entry;
- the same replies without `threadId` still go to the newest open thread at the place.

## Gotchas

- `"author":"User"` is what makes a thread the reviewer's. Without it the author is `Agent`, which is never the agent's turn, so `wait` blocks forever. Wrap `wait` in `timeout`.
- What `resolve` leaves in `threads` and `decisions` is defined by `src/cli/comment.ts` in the checkout you built. Read it before asserting that end state.
- `get` in text form has no thread IDs. Read IDs from `--format json`.
