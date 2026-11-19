# Walkthrough

An agent answers a reviewer's "show me how this flows" with a step-by-step walkthrough on its reply. The reviewer clicks the reply and steps through the lines in the diff. [`docs/agent-review.md`](../../../../docs/agent-review.md) has the agent-facing rules.

## Sub-features

- `difit walkthrough add <threadId>`, from an argument or stdin: attaches to the thread's latest agent reply and moves off any older reply; adding again replaces it
- `warnings` for an unknown step field (not stored), a file the review target lacks, or a line past the file's end; the step is still stored
- Several cases, each with an optional `title` and `setup`; with more than one case the warnings and refusals name the step as `case 2 step 1`
- `get` and `remove`; both exit 1 once nothing is attached
- Refusals: 409 before any agent reply, 404 for a missing or deleted thread, 400 for a bad shape (no case, a case without steps, a step without `file`, `line` or `description`)
- The browser: the reply gets a `따라가기 n단계` button and never opens by itself; the bar's `이전`·`다음` highlight the step's lines, `diff 에 안 보이는 줄` when the line is not in the diff; closing returns to the thread with one history entry for the whole walkthrough
- With several cases the bar has a `경우` select (no select for one case); picking a case goes to its step `1 / n` and moves the highlight; `처음 상태` shows the picked case's `setup`
- A removed walkthrough stays removed when a tab loaded before the removal saves

## How to get to it (user POV)

The reviewer asks in a comment how the code flows. The agent replies with `difit comment add`, then runs `difit walkthrough add`. The reviewer clicks the reply text or its button.

## Driving it with harness.sh

```bash
( . "$S/env.sh"; cd "$REPO"
  difit comment add --port "$PORT" '{"type":"thread","id":"t1","author":"User","filePath":"math.js","position":{"side":"new","line":2},"body":"sub 이 어떻게 도는지 보여 주세요."}'
  difit comment add --port "$PORT" '{"type":"reply","threadId":"t1","filePath":"math.js","position":{"side":"new","line":2},"body":"add 를 본떠 연산자를 바꾸지 않았습니다."}'
  echo '{"cases":[{"steps":[
    {"file":"math.js","line":1,"description":"add 는 두 값을 더한다."},
    {"file":"math.js","line":2,"description":"sub 도 a + b 를 돌려준다."},
    {"file":"nope.js","line":1,"description":"없는 파일","callPath":"x"}]}]}' |
    difit walkthrough add t1 --port "$PORT"
  difit walkthrough get t1 --port "$PORT"
  difit walkthrough remove t1 --port "$PORT"
  difit walkthrough get t1 --port "$PORT"; echo "get after remove exit $?"
) 2>&1 | tee "$S/evidence/walkthrough.txt"
```

Proof:

- `add` prints `success` with two warnings: `step 3: ignored unknown field "callPath"` and `step 3: nope.js is not in <short sha>`.
- `get` prints the steps, without `callPath`, and `commit` as the full SHA of the review target.
- After `remove`, `get` prints `Error: No walkthrough on thread t1` and exits 1.

The bar is a screen: run `add` again and drive it in a browser (Playwright from `node_modules`, with `PLAYWRIGHT_BROWSERS_PATH` pointing at `~/.cache/ms-playwright`). Before the click there is no `region` named `따라가기`; after clicking the reply it reads `1 / 3`, `history.length` grew by one, and `tr[data-walkthrough-step]` is the `math.js` line 1 row. Step 3 shows `diff 에 안 보이는 줄` and no row. Closing leaves no bar and `history.state.difitPlace` is `{"kind":"thread","threadId":"t1"}`.
