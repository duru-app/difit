# Reword

The reviewer changes a commit's message from the commit list. difit rewrites the history at once: no `amend!` commit, and the review, its comments and its decisions follow the new SHAs. [`docs/adr/0009`](../../../../docs/adr/0009-reviewer-rewords-rewrite-history.md) has the rules.

## Sub-features

- `POST /api/reword`, which rewrites the history and returns the old-to-new map
- `GET /api/commit-message`, which fills the edit form
- The warnings on the default branch and on a commit the upstream holds, passed with `acknowledged`
- Refusals: a git operation in progress, a thread the agent is working on, HEAD moved, a merge that conflicts when rebuilt
- `/api/diff`, `/api/fixups`, `/api/comments-json` and `difit comment get` on the new SHAs

## How to get to it (user POV)

Hover a row of the commit list and press the pencil, or open the commit drawer on a phone. Edit the message and press `저장`. On the default branch, or for a commit already pushed, the form first warns and offers `그래도 저장`. While the agent is working it refuses and says so.

## Driving it with harness.sh

Saving is a browser action with no CLI, so it goes to the API the browser writes to. The seeded repository is on `main`, so put it on another branch to skip the warning, or leave it there to see it. Start the review on the two seeded commits plus one to reword, and keep an unfolded fixup above them.

```bash
S=$(bash .claude/skills/verify-difit/harness.sh new)
( . "$S/env.sh"; cd "$REPO"
  git commit -q --allow-empty -m 'add thrid'
  git checkout -q -b feature
) 
bash .claude/skills/verify-difit/harness.sh start "$S" HEAD HEAD~2
( . "$S/env.sh"; cd "$REPO"
  TARGET=$(git rev-parse HEAD); BASE=$(git rev-parse HEAD~2); TYPO=$TARGET
  curl -s "$URL/api/diff" >/dev/null
  difit comment add --port "$PORT" "{\"type\":\"thread\",\"id\":\"t1\",\"author\":\"User\",\"position\":{\"scope\":\"commit\"},\"fixupTarget\":\"$TYPO\",\"body\":\"third, not thrid\"}"
  sleep 1
  git commit -q --allow-empty -m "fixup! $TYPO" -m 'Review-Thread: t1'
  curl -s -X POST -H 'Content-Type: application/json' \
    -d "{\"commit\":\"$TYPO\",\"original\":\"add thrid\",\"message\":\"add third\"}" \
    "$URL/api/reword?base=$BASE&target=$TARGET" | tee "$EVIDENCE/reword.json"
  git log --format='%h %s' "$BASE..HEAD"
  curl -s "$URL/api/diff" > "$EVIDENCE/diff.json"
  difit comment get --port "$PORT"
) 2>&1 | tee "$S/evidence/reword.txt"
```

Proof:

- `git log` shows `add third` and `fixup! <new SHA of that commit>`, and no `amend!`.
- `reword.json` holds `rewritten`, an entry from each old SHA to its new one, and `git rev-parse HEAD` is the new SHA of the fixup.
- `diff.json` has `review.commits` on the new SHAs, and `rewritten`.
- `comment get` shows the thread on the new short SHA with the new subject.
- `git worktree list` has one line, and `git status --porcelain` is what it was before.

On the default branch, the same POST without `acknowledged` answers 409 `{"reason":"needs-confirmation","warnings":["default-branch"]}` and `HEAD` does not move. Adding `"acknowledged":["default-branch"]` rewrites.

A pushed commit: before `start`, make a bare repository with `git init -q --bare "$S/remote.git"`, then in `$REPO` run `git remote add origin "$S/remote.git"` and `git push -q -u origin feature`. The POST answers 409 `{"reason":"needs-confirmation","warnings":["pushed-commit"]}` and `HEAD` does not move. With `"acknowledged":["pushed-commit"]` it rewrites, and `git -C "$S/remote.git" rev-parse feature` is what it was. A commit added after the push rewrites with no warning.

The agent at work: a thread added with `"author":"User"` makes the POST answer 409 `{"reason":"comments-waiting"}` while nothing is attached (`agent-working` with a listener on `CLAUDE_CODE_MESSAGING_SOCKET`), and a reply with `"fixPending":true` keeps it so. A later reply without the mark lets the POST through. `difit comment wait` running in the background with no such thread changes nothing.

A merge kept in the range: before `start`, make a side branch and merge it with `--no-ff` on top of the commit to reword. After the POST, `git log --merges` still lists the merge and `git rev-parse HEAD^{tree}` is unchanged. Resolve a conflict by hand in that merge instead and the POST answers 409 `{"reason":"conflict"}` with the git output, and `HEAD` and the working tree stay as they were. Its `conflict` carries the commit and `agentAttached`; handing it over goes as in `reorder.md`, with the wanted message in the comment.

A stopped rebase: `git rebase -i` with an `edit` before the POST answers 409 `{"reason":"operation-in-progress"}`.

## Gotchas

- The query of `/api/reword` names the review, not the commit. After a rewrite the old SHAs in it are still understood, because the server keeps the map until it stops.
- Only a review pinned to a commit can be reworded. `start` resolves names to SHAs, so `start "$S" HEAD HEAD~2` is pinned; a revision picked by branch name in the browser is not.
- The fixup above needs the commit list to come from the reviewed target, so add it after `start`.
- The fixup comes a second after the comment, because a comment newer than the fixup's author date is the agent's turn and the POST is refused with `comments-waiting`.
