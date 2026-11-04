# Symbol index

Clicking a name in a Java file looks it up through a SCIP index of the commit, built with `scip-java`. The index is built outside the repository from `git archive`.

Run this only when the index code changes (`src/server/scip-*.ts`, or the symbol routes in `src/server/server.ts`). The unit tests cover the rest, and one build takes minutes.

## Sub-features

- The state of a commit's index: `queued`, `building`, `ready`, `failed`, `unavailable`
- `/api/symbol`, which answers from the index when it is ready and by name until then
- `/api/symbol-callers` and `/api/symbol-index/<commit>/log`

## How to get to it (user POV)

The reviewer opens a commit in a Java project, clicks a name and presses find. Opening the diff starts the build.

## Driving it with harness.sh

This needs a real Java project with a `gradlew` or a Maven build, and `scip-java` on `PATH`. The seeded repository has no Java, so `start --repo` runs the server in that project.

Set `JAVA_REPO`, `COMMIT`, and a `FROM`, `NAME`, `LINE` and `COLUMN` that point at a name in a Java file of `$COMMIT^`:

```bash
export GRADLE_USER_HOME="$HOME/.gradle"   # keeps the real cache: env.sh replaces HOME
repo_state() { git -C "$JAVA_REPO" status --short --ignored; git -C "$JAVA_REPO" worktree list; git -C "$JAVA_REPO" for-each-ref; }
S=$(bash .claude/skills/verify-difit/harness.sh new)
repo_state > "$S/evidence/repo-before.txt"
bash .claude/skills/verify-difit/harness.sh start "$S" --repo "$JAVA_REPO" "$COMMIT" && ( . "$S/env.sh"; cd "$JAVA_REPO"
  BASE=$(git rev-parse "$COMMIT^")
  for _ in $(seq 180); do
    curl -s -G "$URL/api/symbol" --data-urlencode "name=$NAME" --data-urlencode "ref=$BASE" \
      --data-urlencode "from=$FROM" --data-urlencode "line=$LINE" --data-urlencode "column=$COLUMN" > "$EVIDENCE/symbol.json"
    node -p 'const d=JSON.parse(require("fs").readFileSync(process.argv[1]));JSON.stringify({source:d.source,index:d.index})' "$EVIDENCE/symbol.json"
    grep -qE '"source":"index"|"status":"(ready|failed|unavailable)"' "$EVIDENCE/symbol.json" && break
    sleep 5
  done
  find "$DIFIT_CONFIG_DIR/scip-index" -maxdepth 2 -type f
)
grep -q '"source":"index"' "$S/evidence/symbol.json" && echo "answered from the index" || echo "FAIL: not answered from the index"
repo_state | diff "$S/evidence/repo-before.txt" - && echo "repository unchanged"
bash .claude/skills/verify-difit/harness.sh stop "$S"
```

Proof:

- The state goes from `queued` to `building`, then the answer has `"source":"index"`. An answer with `"source":"name"` and status `ready` means the lookup found nothing at that spot. Try a class declared in that file. If names you know are declared still miss, reading the index is broken, and that is a failure.
- `index.lookup.v2.gz` exists for the commit under the sandbox's `scip-index`.
- The block prints `answered from the index` and `repository unchanged`. Both are needed, because the second says nothing about the index.

## Gotchas

- `queued` first is normal when another commit of the same review builds ahead of this one. One build pair took about 5 minutes on a large Gradle project.
- `failed` is a real result with a reason. `/api/symbol-index/<commit>/log` returns the build log.
- Without `GRADLE_USER_HOME` the sandbox's empty `HOME` makes Gradle download everything again.
- `$EVIDENCE` holds that project's code lines, file names and branch names. For a private project, keep it on this machine and do not paste it into a PR or an issue.
