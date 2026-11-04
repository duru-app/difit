# Release package

The tarball the fork release publishes, which auto-update installs on every machine. `scripts/check-release-package.js` installs it in a temporary folder and runs it. The release workflow blocks the release when this fails.

## Sub-features

- The package holds every file of `dist` and installs the bundled skills
- The installed `difit` prints the release version and serves a diff and the web page

## How to get to it (user POV)

Users install it with `npm i -g` on the release URL, or receive it through auto-update on the next run.

## Driving it with harness.sh

The script makes its own temporary environment, so `harness.sh start` is not needed. `$S` here only holds the evidence. Run it after `pnpm run build`:

```bash
D=$(mktemp -d)
npm pack --ignore-scripts --pack-destination "$D"
tar xzf "$D"/difit-*.tgz -C "$D"
(cd "$D/package" && npm pkg set version=5.0.12-inteh.1)
tar czf "$D/check.tgz" -C "$D" package
node scripts/check-release-package.js "$D/check.tgz" 5.0.12-inteh.1 > "$S/evidence/package.txt" 2>&1
echo "exit $?"
rm -rf "$D"
```

Proof: each check prints an `ok:` line and the exit code is 0. To prove a change to the script itself, remove a file from `$D/package` before the second `tar`, such as `skills/difit/SKILL.md`, and confirm exit 1 with a message naming that file.

## Gotchas

- Use a version shaped like `<x.y.z>-inteh.<n>`. Other versions skip skill installation, so the check fails with a missing-skill message on a healthy package.
- Packing from a stale `dist` compares against that same stale `dist`. Build first.
- Running the script only proves the package. The Actions steps around it run through `workflow_dispatch` on a branch, which checks the package and skips the release.
