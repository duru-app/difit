---
name: verify-difit
description: Run the built difit CLI and server in an isolated sandbox and prove non-screen behavior with real commands. Use after changing src/cli or src/server, when checking comment, fixup or diff behavior end to end, or when asked to verify difit without a browser. Not for how a screen looks or feels, which a person reviews.
metadata:
  internal: true
---

# Verify difit

Drives the real CLI and server on Linux or WSL. It never touches this machine's `~/.difit`, `~/.claude` or a difit the user has open.

Screens are out of scope: a person reviews them in difit.

## Launch

```bash
pnpm run build                                        # once, and after every change under src/
S=$(bash .claude/skills/verify-difit/harness.sh new)  # sandbox with a two-commit repository
bash .claude/skills/verify-difit/harness.sh start "$S"  # background server on HEAD
```

Agent shells do not keep variables between tool calls. Note the path `new` prints and pass it literally in later calls, or keep launch, drive and cleanup in one call. `harness.sh` refuses any path not named `difit-verify-*`.

`start` passes extra arguments to difit (`start "$S" HEAD~1 HEAD`), runs in another project with `--repo <dir>` placed right after the sandbox, and prints `{"port":…,"url":…,"pid":…}` once the server answers. A sandbox holds one server, and several sandboxes can run side by side because each server picks a free port.

Run every drive in a subshell, so the sandbox's `HOME` does not leak into your shell:

```bash
( . "$S/env.sh"; cd "$REPO"; difit comment get --port "$PORT" )
```

`env.sh` sets `difit` on `PATH`, `REPO`, `EVIDENCE`, `PORT` and `URL`. Source it after `start`, because `PORT` and `URL` come from the running server.

The seeded repository has `math.js` with `add`, then a second commit that adds a `sub` which wrongly adds. Line 2 of the new side is the line to comment on.

## Doctor

```bash
bash .claude/skills/verify-difit/harness.sh doctor "$S"
```

Read-only. It exits 1 when there is no build, a source file changed after the last build, the server started before the last build or runs another checkout's build, this sandbox has no server, or `/api/diff` does not answer. Run it first whenever a result looks wrong: a stale build is the usual cause.

## Drive

[`features/README.md`](features/README.md) lists every feature with its commands and the end state that proves it. A proof covers every entry point its feature file lists, not only the convenient one.

## Evidence

Write what proves the result to `$EVIDENCE`:

```bash
( . "$S/env.sh"; cd "$REPO"; difit comment get --port "$PORT" --format json ) 2>&1 | tee "$S/evidence/comments.json"
```

- Capture the action and the resulting state, not only the final output.
- Check side effects alongside the output: the thread list, `decisions`, git commits, exit codes.
- Use the CLI where one exists. Only the writes a browser makes go straight to the API, and the feature files name them.
- A journey that cannot reach its end state is a failure with a reason. Do not weaken it to pass.

## Cleanup

```bash
bash .claude/skills/verify-difit/harness.sh stop "$S"
```

It stops only the server this sandbox started and removes everything except `$S/evidence`. Running it again reports that the sandbox is already stopped. Copy the evidence out if it must outlive the machine's temp folder.
