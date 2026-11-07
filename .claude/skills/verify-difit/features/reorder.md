# Reorder

The reviewer drags a commit in the commit list by the handle at the left of its row. difit rewrites the history at once in the new order, and the review, its comments, its decisions and its unfolded fixups follow the new SHAs. [`docs/adr/0009`](../../../../docs/adr/0009-reviewer-rewords-rewrite-history.md) has the rules.

## Sub-features

- `POST /api/reorder`, which takes every commit the review lists, oldest first, and returns the old-to-new map
- The warnings on the default branch and on a commit the upstream holds, passed with `acknowledged`
- Refusals: a git operation in progress, a thread the agent is working on, HEAD moved, a conflict, a list that has gone stale
- `POST /api/history-rewritten`, where an agent that rebased by hand reports what became of each commit
- `/api/diff` with `historyMoves`, `/api/fixups`, `/api/comments-json` and `difit comment get` on the new SHAs
- A selection with old SHAs, which lands on the same commits in the new order

## How to get to it (user POV)

Hover a row of the commit list, grab the handle at its left and drop it where the line shows; on a phone, open the commit drawer, where the handle is always there. Dragging outside the handle still picks a range. On the default branch, or for a commit already pushed, a notice above the list warns and offers `그래도 옮기기`. While the agent is working, or when the commits conflict, the notice says why and nothing changes.

## Driving it with harness.sh

Dropping is a browser action with no CLI, so it goes to the API the browser writes to. The seeded repository is on `main`, so put it on another branch to skip the warning. `start` passes the target first and the base second.

```bash
S=$(bash .claude/skills/verify-difit/harness.sh new)
( . "$S/env.sh"; cd "$REPO"
  git checkout -q -b feature
  git rev-parse HEAD > "$EVIDENCE/base.txt"
  echo a > a.txt; git add -A; git commit -qm 'add a'
  echo b > b.txt; git add -A; git commit -qm 'add b'
  echo c > c.txt; git add -A; git commit -qm 'add c'
)
bash .claude/skills/verify-difit/harness.sh start "$S" HEAD "$(cat "$S/evidence/base.txt")"
( . "$S/env.sh"; cd "$REPO"
  BASE=$(cat "$EVIDENCE/base.txt"); A=$(git rev-parse HEAD~2); B=$(git rev-parse HEAD~1); C=$(git rev-parse HEAD)
  curl -s "$URL/api/diff" >/dev/null
  difit comment add --port "$PORT" "{\"type\":\"thread\",\"id\":\"t1\",\"author\":\"User\",\"position\":{\"scope\":\"commit\"},\"fixupTarget\":\"$A\",\"body\":\"a needs a test\"}"
  sleep 1
  echo tested > a.txt; git add -A; git commit -qm "fixup! $A" -m 'Review-Thread: t1'
  curl -s -X POST -H 'Content-Type: application/json' \
    -d "{\"order\":[\"$C\",\"$A\",\"$B\"]}" \
    "$URL/api/reorder?base=$BASE&target=$C" | tee "$EVIDENCE/reorder.json"
  echo
  git log --reverse --format='%h %s' "$BASE..HEAD"
  curl -s "$URL/api/diff" > "$EVIDENCE/diff.json"
  curl -s "$URL/api/diff?base=$B&target=$C" > "$EVIDENCE/stale-view.json"
  difit comment get --port "$PORT"
  git worktree list
  git status --porcelain
) 2>&1 | tee "$S/evidence/reorder.txt"
```

Proof:

- `git log` shows `add c`, `add a`, `add b`, `fixup! <new SHA of add a>`.
- `reorder.json` holds `rewritten`, an entry from each old SHA to its new one, and `git rev-parse HEAD` is the new SHA of the fixup.
- `diff.json` has `review.commits` in the new order on the new SHAs, `review.requested.targetCommitish` on the new SHA of `add b`, and `historyMoves`.
- `stale-view.json` shows only `c.txt`: the view of `add c` asked for with its old SHAs is that commit on its new parent.
- `comment get` shows the thread on the new short SHA of `add a`.
- `git worktree list` has one line, and `git status --porcelain` is what it was before.

On the default branch, the same POST without `acknowledged` answers 409 `{"reason":"needs-confirmation","warnings":["default-branch"]}` and `HEAD` does not move. Adding `"acknowledged":["default-branch"]` rewrites.

A pushed commit: before `start`, make a bare repository with `git init -q --bare "$S/remote.git"`, then in `$REPO` run `git remote add origin "$S/remote.git"` and `git push -q -u origin feature`. The POST answers 409 `{"reason":"needs-confirmation","warnings":["pushed-commit"]}` and `HEAD` does not move. With `"acknowledged":["pushed-commit"]` it rewrites, and `git -C "$S/remote.git" rev-parse feature` is what it was.

The agent at work: a thread added with `"author":"User"` and no answer makes the POST answer 409 `{"reason":"comments-waiting"}` while no `wait` is open and no Claude Code session socket answers, and `{"reason":"agent-working"}` with a listener on `CLAUDE_CODE_MESSAGING_SOCKET`.

A conflict: commit a line and then edit that line, and ask for the edit first. The POST answers 409 `{"reason":"conflict","conflict":{"commit":{"sha":…,"subject":…},"agentAttached":false}}` with the git output, and `HEAD` and the working tree stay as they were.

Handing it over: keep `difit comment wait --port "$PORT"` running in the background and repeat the POST; `agentAttached` is `true`. The button is a browser action, so it goes to what the browser writes: `POST /api/comments` with a thread whose `position` is `{"scope":"commit"}` and `fixupTarget` the commit, or real Chromium on the page. `wait` ends with the thread, `comment get` shows it as `[답변 대기]`, and another POST answers `comments-waiting`, because the `wait` has ended and a new one returns at once on that thread. Then, as the agent: rebase by hand, and `POST /api/history-rewritten` with `{"rewritten":{"<old>":"<new>"}}`. `/api/diff` shows `review.commits` on the new SHAs in the new order, `comment get` shows the thread on the new short SHA, and a reply makes it `[답변 완료]`. A fixup waiting above the review stays above it through the agent's rebase and stays `[승인 대기]`; a rebase that moves it below the review's last commit gets 409 `{"reason":"stale-view"}` from that POST.

A merge kept in the range: before `start`, make a side branch and merge it with `--no-ff`, with a commit after the merge. Ask for that commit before the merge. After the POST, `git log --merges` still lists the merge, `git log --first-parent` has the new order, and `git rev-parse HEAD^{tree}` is unchanged. Moving the commit the side branch grows from past that merge answers 409 `{"reason":"conflict"}`.

Stale lists: an `order` that leaves a commit out or names another answers 409 `{"reason":"stale-view"}`; the order as it stands answers 409 `{"reason":"no-change"}`.

## Gotchas

- `order` holds only what `review.commits` lists. Fixups between them go along with the commit before them, or right behind their target when it moved past them; commits above the reviewed target stay above it.
- The query of `/api/reorder` names the review, not the commit. After a rewrite the old SHAs in it are still understood, because the server keeps the moves until it stops.
- The fixup comes a second after the comment, because a comment newer than the fixup's author date is the agent's turn and the POST is refused with `comments-waiting`.
- A thread's stored line does not move, so `comment get` still prints it. The page finds the line again from the code snapshot when an earlier commit's lines shifted it.
