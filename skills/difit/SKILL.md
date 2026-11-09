---
name: difit
description: Ask the user for a code review by opening the changes in difit, a local diff viewer. Explicit opt-in only — use when the user names difit, asks to open or show the diff in the viewer, or has a standing instruction to request reviews through difit after changes. Do not use it for ordinary requests to review code, diffs, commits, branches, or pull requests.
---

# Difit

## When to Use This Skill

difit opens an external browser UI and starts a long-running local server, so launching it must be explicit opt-in:

- Use this skill only when the user explicitly names difit, asks to open or show the diff in a viewer, or has a standing instruction (for example in project docs or agent configuration) to request reviews through difit after code changes.
- Do NOT use it for ordinary review requests such as "review these changes", "use the reviewer agent", "find problems in this diff", or "review this PR/commit/branch". Answer those through your normal response channel.
- When a request is ambiguous, prefer the non-difit path.

## Overview

This skill requests a code review from the user using difit.
Before running commands, choose `<difit-command>` using the following rule:

- If `command -v difit` succeeds, use `difit`.
- Otherwise, use `npx difit`.
- If falling back to `npx difit` would require network access in a sandboxed environment without network permission, request escalated permissions and user approval before running it.
- The fixup review flow below exists only in the duru-app/difit fork. `npx difit` downloads the upstream package, so that flow needs the fork installed as `difit` on PATH.

If the user leaves review comments, they are printed to stdout when the chosen difit command exits.
When review comments are returned, continue work and address them.
If the server is shut down without comments, treat it as "no review comments were provided." Restarting it is unnecessary.
Manual verification of whether the page launched correctly is also unnecessary.

## Commands

- Review uncommitted changes before commit: `<difit-command> .`
- Review the HEAD commit: `<difit-command>`
- Review staging area changes: `<difit-command> staged`
- Review unstaged changes only: `<difit-command> working`

Basic Usage:

```bash
<difit-command> <target>                    # View single commit diff. ex: difit 6f4a9b7
<difit-command> <target> [compare-with]     # Compare two commits/branches. ex: difit feature main
```

## Optional Startup Comments

If there is something you want to tell the user when difit opens, attach it as startup comments with `--comment`.
This is useful for review findings, explanations, and any context the user should see directly on the diff.

```bash
<difit-command> <target> [compare-with] \
  --comment '{"type":"thread","filePath":"src/foobar.ts","position":{"side":"old","line":102},"body":"line 1\nline 2"}' \
  --comment '{"type":"thread","filePath":"src/example.ts","position":{"side":"new","line":{"start":36,"end":39}},"body":"Range comment for L36-L39"}' \
  --comment '{"type":"thread","filePath":"src/example.ts","position":{"side":"new","scope":"file"},"body":"Comment on the whole file"}' \
  --comment '{"type":"thread","position":{"scope":"commit"},"fixupTarget":"<sha>","body":"Comment on the whole commit"}'
```

- Use `type: "thread"` for each comment.
- Write comment bodies in the language the user is using.
- Use `position.side: "new"` for lines that exist on the target side of the diff.
- Use `position.side: "old"` for lines that exist only on the deleted side.
- Use range comments for issues that span multiple lines.
- Use `"scope": "file"` in place of `line` for a remark about the whole file rather than any of its lines, with `side: "old"` only when the diff deletes the file.
- For a remark about one commit as a whole, leave out `filePath`, use `"position": {"scope": "commit"}` with no `side`, and name the commit in `fixupTarget`.
- When a body or reply points at another place in the diff, write it as `path:line` or `path:start-end` (for example `src/cli/comment.ts:88`); difit turns it into a link to that line of the new file.
- To explain a flow with several steps or branches, a call sequence, or how parts relate, put a fenced code block with the language `mermaid` (a `flowchart` or a `sequenceDiagram`) in the body. difit draws it inside the card; a click or tap opens it larger only when it was shrunk to fit the card, and a diagram that already fits opens at the same size. Draw a flow top to bottom with `flowchart TD`: `flowchart LR` is shrunk to the card width until its text cannot be read. Keep it small, about 10 nodes or fewer, and keep the prose too. Do not use it for a simple list, a single fact or a table. Invalid mermaid is shown as source.
- Never copy secrets, tokens, passwords, API keys, private keys, or other credential-like material from the diff into `--comment` bodies or any command-line arguments.

## Including Untracked Files

For uncommitted changes, if files not yet added to git should also appear in the diff, add `--include-untracked`.

```bash
<difit-command> . --include-untracked
```

## Reusing a Running Server

Keep at most one live difit server per Git root and review target. When you edit again after starting a review, reuse the running server instead of launching another one — repeated launches create duplicate ports and browser tabs.

- Before starting difit, check whether a difit server you started earlier is still running for the same Git root (for example, the background process you launched is still alive).
- If one is running for the same target, do not start another and do not reopen its URL. For working-tree targets (`.`, `working`, `staged`) difit watches the repository, and the open page prompts the user to reload when the diff changes.
- If review rounds are expected to repeat, start the server with `--keep-alive` (the server survives browser disconnects) or `--background` (a detached keep-alive server; prints JSON like `{"port":4966,"url":"http://localhost:4966","pid":123}` and does not auto-open a browser, so share the URL with the user once).
- While the server stays alive, exchange feedback without restarting it:
  - `<difit-command> comment get --port <port>` — read the user's review comments (`--format json` for structured output).
  - `<difit-command> comment add --port <port> '<json>'` — add new comments to the running server (same JSON shape as `--comment`).
  - `<difit-command> comment resolve <threadId...> --port <port>` — resolve threads only you wrote (every message by `Agent`, never reopened by the reviewer). Any other thread, including one the reviewer replied to or reopened, one imported from GitHub or one added with another author, is refused with exit 1 and nothing is recorded; only the reviewer closes it, with ✓ or by approving a fixup. Answer such a thread by fixup or reply and leave it open. A thread the reviewer already closed with ✓ is reported under `resolved` with nothing recorded.
- If the review target changes (for example, a different commit range), stop the existing server and start a new one rather than leaving two servers for the same repository.

## Answering Review Comments With Fixup Commits

difit pins a review opened on a commit or branch to its SHA at startup. Fixup commits stacked on top afterwards are drawn under the comment they answer, and the user approves or rejects each one. Reviews of `.`, `working`, `staged`, `--pr`, or stdin have no commit to pin and show no overlay.

Each comment thread carries a state in the text output of `comment get`:

| Label            | Meaning                                                         | Agent action                       |
| ---------------- | --------------------------------------------------------------- | ---------------------------------- |
| `[답변 대기]`    | No reply or fix from you yet                                    | Fix it                             |
| `[답변 완료]`    | You replied in words after the user, with no fixup yet          | Wait                               |
| `[선택 대기]`    | Your reply offers choices the user has not picked from yet      | Wait                               |
| `[수정 중]`      | You replied that a fixup follows, and it has not arrived yet    | Push the fixup                     |
| `[승인 대기]`    | A fixup is waiting for the user's decision                      | Wait, or answer a reply after it   |
| `[승인됨]`       | Approved, not folded yet                                        | Fold at wrap-up, or answer a reply |
| `[접힘]`         | Folded into the target commit                                   | None                               |
| `[다시 수정 중]` | The user rejected the fixup                                     | Drop the fixup and fix again       |
| `[되돌림]`       | The user reverted a fix they made in the viewer on a new thread | Drop the fixup only                |

A message the user edited after posting it shows `고친 시각: <ISO time>` above its body (`updatedAt` in `--format json`). An edit made after you replied does not make the thread your turn again, so when that time is later than your reply, read the message again and answer whatever it now adds.

### Learning when it is your turn

A background command wakes you only when it exits, so while a review server you started is running, keep one `difit comment wait --port <port>` running as a background command. It exits as soon as a thread is your turn, printing each such thread as one JSON line: `threadId`, `filePath` (absent on a comment on a whole commit), `position`, `message` (the latest message), and on pinned reviews `state` (`awaiting-fix`, `awaiting-approval`, `approved`, `rejected`, `withdrawn` or `deleted`), `label` and, when fixups to drop are still in the range, `rejectedFixupShas` with all of them and `rejectedFixupSha` with the first, plus `fixupTarget` when the comment names the commit to fix into, `answer` when the latest message picks one of the choices you offered (see "Asking the user to pick"), and `fixupLines` when the user wrote it on lines of a fixup (see "Replies on fixup lines"). Answer every thread it brings as below, then start `difit comment wait` again the same way. It also prints threads that became your turn before it started, so nothing is lost between runs; a thread you have not answered comes back at once.

- A thread is your turn when it is `[답변 대기]` and the user spoke last, `[승인 대기]` and the user replied after the fixup was written, `[승인됨]` and the user replied after approving, or replied after the fixup was written while it is still in the range and you have not answered, `[다시 수정 중]` with no new fixup and no reply from you after the rejection, `[되돌림]` while its fixup is still in the range, or `[지움]`. On reviews without a pinned commit, any thread where the user spoke last is your turn. To answer in words instead of a fix (a question, or disagreeing with a rejection), add a reply with `comment add` (`"type": "reply"` with the thread's `filePath` and `position`); that also ends your turn, and a `[답변 대기]` thread shows `[답변 완료]` until the user replies. On a pinned review, when a fixup will follow the reply (you are still fixing, or waiting on tests), add `"fixPending": true` to it: the thread then shows `[수정 중]` instead, which is not the user's turn, and moves to `[승인 대기]` once the fixup arrives. Your latest reply decides, so a later reply without the mark takes it back. A user reply in between makes it your turn again. Once the promised fixup is committed, whether the reply carried `fixPending` or only said a fix would follow, add one short reply on the same thread saying what changed and what verification ran, so the thread does not end on a promise; the thread stays `[승인 대기]`.
- On `[승인 대기]` and `[승인됨]`, the decision stays with the user: reply in words; the user's reply does not undo an approval. When the reply asks for more changes, fold them into the existing fixup and reply too, since amending keeps the author date the turn is measured against and does not end it. Amending more changes into an approved fixup sends it back to `[승인 대기]` for the user to judge again. A reply the user wrote before approving is compared with the fixup's author date, so when the user's browser and the machine that made the fixup disagree on the time, a thread can come back with `message` still being the comment your fixup already answers and no new reply from the user. In that case reply in words, and it stops coming back.
- Exit code 0 with nothing on standard output means the review ended: start no more `difit comment wait` for it. A non-zero exit means it could not reach the server: show its standard error to the user, unless you stopped or restarted the server yourself; after a restart, start `difit comment wait` on the new port.

In Claude Code, a server started from your session (including `--background`) also sends each thread that newly became your turn into your session as a message from another session. Its first line is `difit review: your turn on <threadId> [<label>], ...; read with difit comment get --port <port> --format json`, and each following line is the same JSON `difit comment wait` prints. Answer it as below and keep `difit comment wait` running all the same: the message shape is undocumented and may stop arriving silently. When the same `threadId` with the same `state` comes both ways, answer it once. A thread you have not answered comes again with its new `state` when the user approves or unapproves it; answer it once as well. When the user edits their latest reply while it is still your turn, the thread comes again with the same `state` and the edited `message`; answer the edited text, once.

Once a thread reaches you either way, its card shows `응답 중` until you reply to it or push its fixup. It needs no action from you.

The user can also edit code in the viewer. difit then commits a `fixup! <target SHA>` commit with a `Review-Thread` trailer on top of HEAD and records it as approved. Its author is `reviewer-edit`.

The user can also reword a commit from the commit list. difit then commits an `amend! <target SHA>` commit that changes no file, whose message below the first paragraph is the new message with a `Review-Thread` trailer, and records it as approved under a new thread whose `filePath` is `/COMMIT_MSG` (line 1), with `fixupTarget` the reworded commit and author `reviewer-edit`. It needs nothing from you until folding.

A reply body can carry a `mermaid` code block the same way as a comment body (see the comment-bodies list above).

### Naming the thread a reply answers

A reply attaches by `filePath` and `position`. When several threads share a place, add `"threadId": "<id from comment get or comment wait>"` to the reply: it attaches to that thread and is checked for duplicates only inside it, so a retry after the thread was resolved does not copy onto a neighbour and the same text on two threads at one place is stored on both. An unknown or deleted `threadId` stores nothing and puts a line in `warnings`; a `filePath`/`position` that disagrees with the thread still attaches to the named thread and warns. Only `"type": "reply"` takes `threadId`.

### Asking the user to pick

When the user has to choose between options, attach them to a reply instead of listing them in the body; the user picks one by clicking its card in the thread. Only `"type": "reply"` takes `choices`.

```bash
difit comment add --port <port> '{"type":"reply","filePath":"src/config.ts","position":{"side":"new","line":40},"body":"Pick the shape of the setting.","choices":[{"id":"A","name":"Top-level boolean","description":"Simplest."},{"id":"B","name":"review.overlay.enabled","description":"Sits with the other review settings.","preview":{"label":"~/.difit/config.json","text":"{\n  \"review\": {}\n}"},"recommended":true}]}'
```

- Each choice needs `id` (unique within the reply), `name` and `description`; `preview` (`text`, optional `label`) and `recommended` are optional. The card shows three preview lines and folds the rest behind `더 보기`.
- Until the user posts anything after that reply, the thread shows `[선택 대기]`, the user's turn like `[답변 완료]`; a later reply of yours without choices keeps it, unless it carries `"fixPending": true` before the user has answered, which closes the choices and shows `[수정 중]` while it is your latest reply. Only your latest reply with choices can be picked from: a newer one closes the earlier choices. A reply takes `choices` or `fixPending`, not both.
- A pick arrives as an ordinary user reply whose body reads `고름: B — <name>`, with `"answer": {"messageId": "<id of your reply>", "choice": "B"}`; `difit comment wait` and the session message carry `answer` next to `message`. Changing the pick adds a new reply `바꿈: C — <name>` and leaves the earlier one; follow the latest. The user may also answer in words instead, which comes without `answer`.
- The text output of `comment get` lists the choices under your reply (`Choices:`) and adds `Picked B from Reply <n>` under the pick.

### Replies on fixup lines

The user can pick lines on a fixup drawn under a comment, or in the box a fixup that changed another file shows in that file, and reply on them. The reply joins the thread of the comment the fixup answers, with its body as typed and the lines in a separate `fixupLines` field: `fixupSha` and `patchId` of the fixup, `filePath` in the fixup commit (`oldPath` too when the fixup renamed the file), and `ranges`, each with `side`, `line` (a number or `[start, end]`) and `code`. An `old` range is a line the fixup deleted, numbered in the fixup's parent; a `new` range is numbered in the fixup commit and is a line it added or one it left alone. `difit comment wait` and the session message carry `fixupLines` next to `message`; the text output of `comment get` writes each range under the reply as `On fixup <short SHA> <path> L<n> (<side>):` followed by its code. Answer it like any reply on that thread.

### Answering a comment

1. Read threads with their ids. The text output has no ids.

   ```bash
   difit comment get --port <port> --format json
   ```

   The JSON also lists threads that are already resolved, so skip a thread whose latest `resolved` or `unresolved` entry in `decisions` is `resolved`. `comment resolve` leaves its thread in this list the same way. It closes only threads every message of which is by `Agent` and the reviewer never reopened; do not try to close the others.

   A comment the user made while viewing one commit or a run of commits has two more fields: `view` (the `baseCommitish` and `targetCommitish` of the diff it was made on) and `fixupTarget` (the SHA of the commit to fix into). A comment made on the whole review has `fixupTarget` only. The text output adds `고쳐 넣을 커밋: <short SHA> <subject>` right under that comment's location line. A comment without `view` was made on the whole review.

   On a run or the whole review, `fixupTarget` is the commit of that view that last changed the lines: the latest one when they came from several, judged by the kept lines alone when the comment also covers removed lines, and the view's last commit when every line is removed or the view left the lines unchanged. Lines rewritten by a commit the commit list leaves out, such as an earlier round's fixup, count for the commit that made them. A comment without `fixupTarget` predates this rule, or the server could not choose one when it was made.

   A comment on the whole file has `"position": {"side": "new", "scope": "file"}` with no `line` (`"side": "old"` when the diff deletes the file), and its text output location is the bare path, without `:L<n>`, followed by `(old)` for a deleted file. It is about the file as a whole, so read the whole file and fix wherever the remark applies, still in one fixup. Its `fixupTarget` is the last commit of the view that changed the file, or the view's last commit when none did; commits the commit list leaves out do not count. Reply to it with the same `position`.

   A comment on a whole commit has no `filePath`, `"position": {"scope": "commit"}`, and `fixupTarget` naming that commit. It is about the commit itself: its message, what it covers, whether to split or merge it. Its text output location is `커밋 <short sha> <subject>`, without a separate `고쳐 넣을 커밋:` line. When a code or message change answers it, make one `fixup!` or `amend!` into that commit with the `Review-Thread` trailer as for any comment. When it asks for something one fixup cannot do, such as splitting or reordering commits, do not act on it; reply and ask how to proceed. Reply with `{"type": "reply", "position": {"scope": "commit"}, "fixupTarget": "<sha>", ...}`, no `filePath`.

   A comment on several ranges of one file has `extraRanges` next to `line` in its `position`, e.g. `{"side": "new", "line": {"start": 77, "end": 80}, "extraRanges": [12, 40]}`: the lines in `extraRanges` belong to the same comment too. `line` is the range that ended lowest in the view the comment was written in, `extraRanges` lists the others, and the text output location lists them all, `path:L12,L40,L77-L80`. The card sits under whichever range ends lowest in the current view, so in the other of the unified and split views it can sit under another range than `line`. `codeSnapshot.extraContents` holds the code of each extra range in the same order, so find each range in HEAD by its own content. Fix every range in the same fixup, and reply, with or without choices, with the same `position` including `extraRanges`: a reply that gives only `line` does not attach to the comment. When the ranges cover both removed and kept lines, each range on the side other than `position.side` names its side, `{"side": "old", "start": 12, "end": 14}` (both ends even for one line), and its line numbers belong to that side's tree. Stored `extraRanges` list the ranges on `position.side` first and the other side's after them, each side top to bottom; reply with the `position` copied as it is. The text output location then leads each side's ranges with the side, old first, `path:old:L12-L14,new:L12-L13`, without the `(old)` suffix.

   - Line numbers belong to the `view` tree: read new-side lines with `git show <view.targetCommitish>:<file>` and old-side lines with `git show <view.baseCommitish>:<file>`. Without `view`, they belong to the review target.
   - Fix the code in HEAD. Later commits may have moved or changed those lines, so find the place by `codeSnapshot.content` rather than by line number. Make one fixup even when a later commit changed those lines; resolve the fold as in "Folding into a commit in the middle of the range".

2. Fix the code, then commit only that comment's changes as a fixup of the comment's `fixupTarget`, or of the review target when it has none, with the thread id as a trailer.

   ```bash
   git add <files changed for this comment>
   git commit --fixup=<fixupTarget, else review target SHA> --trailer "Review-Thread: <threadId>"
   ```

   On a git without `--trailer`, use `-m "Review-Thread: <threadId>"` instead; it lands below the `fixup!` subject after a blank line and reads the same.

   `--fixup` writes `fixup! <target subject>`, and autosquash folds it into the oldest commit in the range with that subject. If an earlier commit shares the target's subject, the fix lands there. Check first:

   ```bash
   git log --format=%s <review base>..<fixupTarget>^ | grep -Fx "$(git log -1 --format=%s <fixupTarget>)"
   ```

   If it prints anything, name the target by SHA instead, the shape fixups from the viewer use:

   ```bash
   git commit -m "fixup! <full fixupTarget SHA>" --trailer "Review-Thread: <threadId>"
   ```

- Keep one fixup commit per comment and target commit. When one comment needs changes in several commits, make one fixup per target commit, each with the same `Review-Thread` trailer (the target of a change outside the commented lines is the commit of the range that last changed those lines: `git blame <review target> -- <file>`, where a commit older than the range means the review target); the viewer shows them all under that comment, and the user approves or rejects them together.
- Before committing a fixup, check only that it builds (a compile, a type check); do not run the tests or a code review for each fixup. The user may reject the fix and ask for another shape, and every run made before that decision is thrown away. Tests and review run once, after every fixup is `[승인됨]` (see "Folding approved fixups").
- Re-read `comment get` right before committing and confirm the comment is still `[답변 대기]`, `[답변 완료]`, `[수정 중]` or `[다시 수정 중]`. The user may have edited that line in the viewer meanwhile.
- When fixing the same comment again before a decision, fold the change into the existing fixup for the same target commit instead of adding a commit: `git commit --amend --no-edit` when it is HEAD, otherwise `edit` it in `git rebase -i`.
- A rejected fixup shows up in the JSON `decisions` as `"kind": "rejected"` with its SHA. Drop it (`drop` in `git rebase -i`) before any other rebase, since rewriting the lines right next to it can clear the rejection mark, then fix again.
- For `[되돌림]`, drop the fixup as soon as you see it and do not fix again; until it is dropped, `difit comment wait` keeps bringing the thread back. A reverted reviewer edit that answered an existing comment from the diff shows `[다시 수정 중]` and is handled like any rejection.
- The user can also edit lines inside the fixup card under a comment. The viewer then adds the user's fixup on top of yours, with the same `Review-Thread` trailer and target commit, and approves both, which closes the comment; there is nothing for you to do. If the user reverts that edit, the comment goes back to `[승인 대기]` for the user to judge your fixup again, and `difit comment wait` does not bring it back. The reverted fixup remains only as a `rejected` record in `decisions`; drop it with the other rejected fixups when folding.
- `[지움]` means the user deleted the comment. Stop any work on it and do not reply to it. With `rejectedFixupShas`, drop those fixups; until they are dropped, `difit comment wait` keeps bringing the thread back. Deleted threads no longer appear in `comment get`.

### Folding approved fixups

Fold once, when the branch is wrapped up: every remaining fixup is `[승인됨]`, every rejected fixup is dropped, and so is every fixup whose `Review-Thread` trailer names a thread with a `"kind": "deleted"` record in the JSON `decisions`. `--autosquash` folds all fixups in range.

Run the tests and the code review the change needs once, on the tip with every approved fixup, before folding. A failure or a review finding is answered like a comment: a new fixup for the user to approve, then one more run.

When the `track-retro` skill is installed, read the diff of each fixup about to fold, the user's viewer edits included, and append one line per fixup to `~/.claude/projects/<project>/retro/<track>.md` before folding: `- YYYY-MM-DD | fixup: <what was wrong and why> | <owner commit subject>`.

The JSON `decisions` only accumulate. Approving a comment with several fixups adds one `approved` per fixup, all at the same time. When the user unapproves, `"kind": "unapproved"` is added; the later of `approved` and `unapproved` for a thread wins, and a `rejected` later than the approval wins over both. Read the current state from the text output labels.

On a git older than 2.32 (`git --version`), add `--keep-empty` to the fold command below and do not run the `Review-Thread` line-removal command after it. Without `--keep-empty` the user's commit message edits are lost, and the line-removal command rebases without it too, so it drops the `amend!` commits the fold kept. What to do instead is in the git 2.32 paragraph after it.

```bash
git rev-parse HEAD   # note this SHA as <pre-fold SHA>
GIT_SEQUENCE_EDITOR=: git rebase -i --autosquash <review base>
```

An `amend!` commit replaces its target's message with everything below its first paragraph, `Review-Thread` trailer included. On git 2.32 or later, right after folding and before recording where the fixups went, remove those lines; a commit left with one reads as a fixup in a later review and drops out of its commit list. This rewrites only the commits that carry the line:

```bash
git rebase <review base> --exec 'git log -1 --format=%B | grep -q "^Review-Thread: " || exit 0; git log -1 --format=%B | sed "/^Review-Thread: /d" | git commit -q --amend --allow-empty --no-verify --cleanup=whitespace -F -'
```

Folding `amend!` commits needs git 2.32 or later. An older git does not recognize them, and because they change no file, the fold command above silently drops them; the `git diff` check still passes, so the user's reword is lost without a trace. There, add `--keep-empty` to the fold command so the `amend!` commits stay, then drop each one in `git rebase -i <review base>` and `reword` its target with the message `git log -1 --format=%B <amend! SHA> | sed '1,/^$/d; /^Review-Thread: /d'` prints. That message has no `Review-Thread` line, so skip the line-removal command above. If you already folded without `--keep-empty`, find the `amend!` commits with `git log --format='%H %s' <review base>..<pre-fold SHA> | grep ' amend! '`, and `reword` each target the same way, finding it by subject since folding changed its SHA.

`<review base>` is the compare-with side of the diff, or `<SHA>^` for a single-commit review. Start from the review base, not the target commit: a fixup for a comment made on one commit, or one the user made in the viewer, can point at an earlier commit in the range. Folding only regroups changes, so afterwards `git diff --exit-code <pre-fold SHA> HEAD` must print nothing. Note the SHA itself rather than a shell variable: a variable does not survive into the next command when each command runs on its own.

- If a fixup deletes everything its target added, the rebase stops at `Could not apply ... fixup!`. Keep an empty commit with `git commit --amend --allow-empty --no-edit`, or drop it with `git reset --soft HEAD^`, then `git rebase --continue`.
- Fixups from the viewer name their target by SHA. Rebasing onto a newer base or rewording the target before folding gives it a new SHA and leaves the fixup unfolded, so do those after folding. The rebase still reports success; confirm nothing is left:

  ```bash
  git log --format='%h %s' <review base>..HEAD | grep -E '^[0-9a-f]+ (fixup|squash|amend)! '
  ```

  For a leftover fixup, its target is the comment's `fixupTarget` when it has one; otherwise find it with `git show <fixup SHA>` and `git blame <fixup SHA>^ -- <file>` (a commit older than the range means the review target), move it under that commit in `git rebase -i`, and mark it `fixup`.

Folding removes the fixup commits, so record where each fix went on the running server, pairing the old fixup SHA with the commit it folded into. With no merge commits in the range, folding drops only the fixups and keeps the order, so the folded commit sits on the same line of `git rev-list --reverse <review base>..HEAD` as its target does in `git rev-list --reverse <review base>..<review target SHA>`:

```bash
curl -X POST "http://localhost:<port>/api/decisions" \
  -H 'Content-Type: application/json' \
  -d '[{"threadId":"<threadId>","kind":"folded","fixupSha":"<old fixup SHA>","targetSha":"<folded commit SHA>","at":"<ISO 8601 time>"}]'
```

`{"success":true,"changed":true,...}` means it was stored. Resending the same record does not duplicate it; a non-array body or a record with a missing field stores nothing and returns 400.

### Folding into a commit in the middle of the range

When a fixup targets a commit in the middle of the range and a later commit changed the same lines, the fixup was written against HEAD and the rebase stops twice. difit does not resolve this; resolve it by hand and keep the commented commit as the target, since that is the commit the user chose and approved.

1. It first stops at `Could not apply <fixup SHA>... fixup! <target subject>`. The `HEAD` side of the conflict is the target commit's lines. Keep those lines plus the fix only, without what later commits changed.
2. `git add <file>`, then `GIT_EDITOR=true git rebase --continue`. git opens an editor for the combined message; `GIT_EDITOR=true` keeps the target's message and drops the fixup's subject and trailer.
3. It then stops at the later commit, `Could not apply <SHA>... <its subject>`. The `HEAD` side is now the fixed lines and the other side is that commit's original lines. Put that commit's own change back on top of the fixed lines, then `git add` and `GIT_EDITOR=true git rebase --continue` again. Each further commit that changed those lines can stop the same way.
4. When the rebase finishes, run `git diff --exit-code <pre-fold SHA> HEAD`. If it prints anything, the resolution changed the result: `git reset --hard <pre-fold SHA>` (or `git rebase --abort` while the rebase is still running) and ask the user in a `comment add` reply on that thread.

### Moving comments to the folded commit

Folding changes the target SHA, and a review reopened on the new SHA starts without the comments. Copy them from the old server, keeping thread ids and `codeSnapshot` so trailers and decisions still point at the same comments, along with `view` and `fixupTarget`, and reply ids with `choices`, `answer` and `fixupLines` so a pick still names the reply it answers and a reply on fixup lines keeps them:

```bash
difit comment get --port <old port> --format json > old.json

difit comment add --port <new port> "$(jq '[.threads[] | . as $t
  | ($t.messages[0] | {type: "thread", id: $t.id, filePath: $t.filePath, position: $t.position,
                       body, author, createdAt, codeSnapshot: $t.codeSnapshot,
                       view: $t.view, fixupTarget: $t.fixupTarget}),
    ($t.messages[1:][] | {type: "reply", id, filePath: $t.filePath, position: $t.position,
                          fixupTarget: $t.fixupTarget, body, author, createdAt, choices, answer, fixupLines})
  | with_entries(select(.value != null))]' old.json)"

jq '.decisions' old.json | curl -X POST "http://localhost:<new port>/api/decisions" \
  -H 'Content-Type: application/json' -d @-
```

The copied `view` and `fixupTarget` still name pre-fold SHAs, so in the new review such a comment shows only on the whole view, and its commit line shows the short SHA alone. For one you have not answered yet, fix up the commit on the same `git rev-list` line as above.

## Constraints

Can only be used inside a Git-managed directory.
