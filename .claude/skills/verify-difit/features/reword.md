# Reword

The reviewer changes a commit's message from the commit list. difit rewrites the history at once: no `amend!` commit, and the review, its comments and its decisions follow the new SHAs. [`docs/adr/0009`](../../../../docs/adr/0009-reviewer-rewords-rewrite-history.md) has the rules.

## Sub-features

- `POST /api/reword`, which rewrites the history and returns the old-to-new map
- `GET /api/commit-message`, which fills the edit form
- The warning on the default branch, passed with `acknowledged`
- Other local branches holding the reworded commit move with HEAD; one open in another worktree stays and is named in the warning `branch-elsewhere`, and the default branch stays and is named in `default-branch-left`
- A symbolic branch (`refs/heads/master` pointing at `main`) is judged as the branch it points at
- Stopping the server mid-rewrite, or starting it again after a kill, leaves no temporary worktree
- Refusals: a git operation in progress, HEAD or a moving branch moved, a merge that conflicts when rebuilt, in HEAD's history or in a moving branch
- `/api/diff`, `/api/fixups`, `/api/comments-json` and `difit comment get` on the new SHAs

## How to get to it (user POV)

Hover a row of the commit list and press the pencil, or open the commit drawer on a phone. Edit the message and press `저장`. On the default branch the form first warns and offers `그래도 저장`.

## Driving it with harness.sh

Saving is a browser action with no CLI, so it goes to the API the browser writes to. The seeded repository is on `main`, so put it on another branch to skip the warning, or leave it there to see it. Start the review on the two seeded commits plus one to reword, and keep an unfolded fixup above them.

```bash
S=$(bash .claude/skills/verify-difit/harness.sh new)
( . "$S/env.sh"; cd "$REPO"
  git checkout -q -b feature
  git commit -q --allow-empty -m 'add thrid'
) 
bash .claude/skills/verify-difit/harness.sh start "$S" HEAD HEAD~2
( . "$S/env.sh"; cd "$REPO"
  TARGET=$(git rev-parse HEAD); BASE=$(git rev-parse HEAD~2); TYPO=$TARGET
  git commit -q --allow-empty -m "fixup! $TYPO" -m 'Review-Thread: t1'
  curl -s "$URL/api/diff" >/dev/null
  difit comment add --port "$PORT" "{\"type\":\"thread\",\"id\":\"t1\",\"author\":\"User\",\"position\":{\"scope\":\"commit\"},\"fixupTarget\":\"$TYPO\",\"body\":\"third, not thrid\"}"
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

A merge kept in the range: before `start`, make a side branch and merge it with `--no-ff` on top of the commit to reword. After the POST, `git log --merges` still lists the merge and `git rev-parse HEAD^{tree}` is unchanged. Resolve a conflict by hand in that merge instead and the POST answers 409 `{"reason":"conflict"}` with the git output, and `HEAD` and the working tree stay as they were.

A stopped rebase: `git rebase -i` with an `edit` before the POST answers 409 `{"reason":"operation-in-progress"}`.

Stacked branches: before `start`, stack `work2` on the reviewed branch and `work3` on `work2`, and open `work3` in another worktree:

```bash
( . "$S/env.sh"; cd "$REPO"
  git checkout -q -b work2 && git commit -q --allow-empty -m 'stacked work'
  git checkout -q -b work3 && git commit -q --allow-empty -m 'opened elsewhere'
  git checkout -q feature
  git worktree add -q "$S/other" work3
)
```

The POST without `acknowledged` answers 409 with `"warnings":["branch-elsewhere"]` and `"warningBranches":{"branch-elsewhere":["work3"]}`, and no ref moves. With `"acknowledged":["branch-elsewhere"]` it answers 200 with `"branches":{"moved":["work2"],"left":[{"name":"work3","why":"worktree"}]}`. Then `git log --format=%s feature..work2` is `stacked work` on the new HEAD (`git rev-parse work2~1` equals `git rev-parse HEAD`), `git reflog -1 work2` says `difit: rewrite history`, `work3` is where it was, and `git -C "$S/other" status --porcelain` stays empty. A branch under `git rebase -i` or `git bisect` in the other worktree stays too, with `"why":"operation"`, and so does every branch that a `git rebase -i --update-refs` stopped there will move at its end; `git rebase --continue` in that worktree then finishes without `update_ref failed`.

The default branch holding the reworded commit while HEAD is on another branch: start on `feature` above the seeded `main` and reword `add sub`. The POST answers 409 with `"warnings":["default-branch-left"]` and `"warningBranches":{"default-branch-left":["main"]}`. With that warning acknowledged it answers 200 with `"left":[{"name":"main","why":"default"}]` and `main` is where it was. Add `git symbolic-ref refs/heads/master refs/heads/main` first and the answers are the same. A local `master` that tracks `origin/main` while `origin/HEAD` names `main` and no local `main` exists counts as the default branch the same way: it is named in `default-branch-left`, and with HEAD on it the POST warns `default-branch`.

Stopping mid-rewrite: stack 150 empty commits on a branch above `feature`, POST in the background, and once `.git/worktrees/worktree/rebase-merge` exists send `kill -INT` (or `-TERM`) to the pid in `server.json`. `git worktree list` has one line afterwards and no `difit-history-rewrite-*` folder is left in the server's `TMPDIR`. With `kill -9` both are left until `start` runs again on the same repository.

## Gotchas

- The query of `/api/reword` names the review, not the commit. After a rewrite the old SHAs in it are still understood, because the server keeps the map until it stops.
- Only a review pinned to a commit can be reworded. `start` resolves names to SHAs, so `start "$S" HEAD HEAD~2` is pinned; a revision picked by branch name in the browser is not.
- The fixup above needs the commit list to come from the reviewed target, so add it after `start`.
