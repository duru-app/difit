#!/usr/bin/env bash
# Usage:
#   harness.sh new                       create a sandbox and print its path
#   harness.sh start <sandbox> [--repo <dir>] [args]
#                                        start a background server (default args: HEAD)
#   harness.sh doctor <sandbox>          read-only health check, exit 1 when not usable
#   harness.sh stop <sandbox>            stop this sandbox's server, keep only evidence/
set -euo pipefail

[ -r /proc/self/environ ] || { echo "harness.sh needs /proc: it runs on Linux and WSL only." >&2; exit 2; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
ENTRY="$ROOT/dist/cli/index.js"

server_pid() {
  [ -f "$1/server.json" ] && sed -E 's/.*"pid":([0-9]+).*/\1/' "$1/server.json"
}

server_url() {
  [ -f "$1/server.json" ] && sed -E 's/.*"url":"([^"]+)".*/\1/' "$1/server.json"
}

is_our_server() {
  local pid
  pid="$(server_pid "$1")" || return 1
  grep -qzxF "DIFIT_CONFIG_DIR=$1/config" "/proc/$pid/environ" 2>/dev/null
}

not_a_sandbox() {
  echo "Not a sandbox: '$1'. Pass the path 'harness.sh new' printed." >&2
  exit 2
}

resolve_sandbox() {
  case "$(basename -- "${1:-}")" in
    difit-verify-*) ;;
    *) not_a_sandbox "${1:-}" ;;
  esac
  [ -d "$1" ] || not_a_sandbox "$1"
  SANDBOX="$(cd -- "$1" && pwd -P)"
}

require_live_sandbox() {
  resolve_sandbox "${1:-}"
  [ -f "$SANDBOX/env.sh" ] || { echo "Sandbox already stopped: $SANDBOX" >&2; exit 2; }
}

newest_build_time() {
  find "$ROOT/dist" -type f -printf '%T@\n' | sort -n | tail -1
}

cmd_new() {
  [ -f "$ENTRY" ] || { echo "No build at $ENTRY. Run: pnpm run build" >&2; exit 1; }
  local sandbox node
  sandbox="$(mktemp -d "${TMPDIR:-/tmp}/difit-verify-XXXXXX")"
  sandbox="$(cd -- "$sandbox" && pwd -P)"
  node="$(command -v node)"
  mkdir -p "$sandbox/home/.claude" "$sandbox/config" "$sandbox/evidence" "$sandbox/repo" "$sandbox/bin"
  cat >"$sandbox/bin/difit" <<EOF
#!/usr/bin/env bash
exec '$node' '$ENTRY' "\$@"
EOF
  chmod +x "$sandbox/bin/difit"
  cat >"$sandbox/env.sh" <<EOF
export PATH='$sandbox/bin':"\$PATH"
export HOME='$sandbox/home'
export USERPROFILE='$sandbox/home'
export CLAUDE_CONFIG_DIR='$sandbox/home/.claude'
export DIFIT_CONFIG_DIR='$sandbox/config'
export DIFIT_DISABLE_AUTOUPDATE=1
export GIT_AUTHOR_NAME=verify GIT_AUTHOR_EMAIL=verify@example.com
export GIT_COMMITTER_NAME=verify GIT_COMMITTER_EMAIL=verify@example.com
export GIT_CONFIG_NOSYSTEM=1
export EVIDENCE='$sandbox/evidence'
export REPO='$sandbox/repo'
unset CLAUDE_CODE_MESSAGING_SOCKET NODE_ENV
if [ -s '$sandbox/server.json' ]; then
  export PORT="\$(sed -E 's/.*"port":([0-9]+).*/\1/' '$sandbox/server.json')"
  export URL="http://localhost:\$PORT"
fi
EOF
  (
    # shellcheck source=/dev/null
    . "$sandbox/env.sh"
    cd "$REPO"
    git init --quiet -b main
    printf 'export const add = (a, b) => a + b;\n' >math.js
    git add math.js
    git commit --quiet -m 'add math'
    printf 'export const add = (a, b) => a + b;\nexport const sub = (a, b) => a + b;\n' >math.js
    git commit --quiet -am 'add sub'
  )
  echo "$sandbox"
}

cmd_start() {
  local sandbox="$1" repo=""
  shift
  if [ "${1:-}" = "--repo" ]; then
    repo="${2:?--repo needs a directory}"
    shift 2
  fi
  if is_our_server "$sandbox"; then
    echo "Server already running: $(cat "$sandbox/server.json")" >&2
    exit 1
  fi
  [ "$#" -gt 0 ] || set -- HEAD
  if ! (
    # shellcheck source=/dev/null
    . "$sandbox/env.sh" && cd "${repo:-$REPO}" && difit "$@" --background </dev/null >"$sandbox/server.json.tmp"
  ); then
    rm -f "$sandbox/server.json.tmp"
    exit 1
  fi
  mv "$sandbox/server.json.tmp" "$sandbox/server.json"
  cat "$sandbox/server.json"
}

cmd_doctor() {
  local sandbox="$1" failed=0 built="" newer url pid started
  if [ -f "$ENTRY" ]; then
    echo "ok: build $ENTRY"
    built="$(newest_build_time)"
    newer="$(find "$ROOT/src" -type f ! -name '*.test.*' -newermt "@$built" -print -quit)"
    if [ -n "$newer" ]; then
      echo "FAIL: $newer changed after the last build. Run: pnpm run build"
      failed=1
    else
      echo "ok: no source changed after the last build"
    fi
  else
    echo "FAIL: no build at $ENTRY. Run: pnpm run build"
    failed=1
  fi
  if is_our_server "$sandbox"; then
    url="$(server_url "$sandbox")"
    pid="$(server_pid "$sandbox")"
    echo "ok: server pid $pid at $url"
    started="$(($(date +%s) - $(ps -o etimes= -p "$pid")))"
    if ! grep -qzxF "$ENTRY" "/proc/$pid/cmdline"; then
      echo "FAIL: this server runs another checkout's build, not $ENTRY"
      failed=1
    elif [ -n "$built" ] && [ "${built%.*}" -gt "$((started + 1))" ]; then
      echo "FAIL: the build is newer than this server. Run stop, new and start again"
      failed=1
    fi
    if curl -fsS -m 10 -o /dev/null "$url/api/diff"; then
      echo "ok: $url/api/diff answers"
    else
      echo "FAIL: $url/api/diff does not answer"
      failed=1
    fi
  else
    echo "FAIL: no server from this sandbox is running"
    failed=1
  fi
  return "$failed"
}

cmd_stop() {
  local sandbox="$1" pid
  if is_our_server "$sandbox"; then
    pid="$(server_pid "$sandbox")"
    kill "$pid"
    for _ in $(seq 50); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 "$pid" 2>/dev/null; then
      echo "pid $pid did not stop within 5 seconds; sandbox left in place" >&2
      exit 1
    fi
    echo "stopped pid $pid"
  fi
  rm -rf "$sandbox/home" "$sandbox/config" "$sandbox/repo" "$sandbox/bin" "$sandbox/env.sh" "$sandbox/server.json"
  echo "evidence kept at $sandbox/evidence"
}

case "${1:-}" in
  new) cmd_new ;;
  start)
    shift
    require_live_sandbox "${1:-}"
    shift
    cmd_start "$SANDBOX" "$@"
    ;;
  doctor)
    require_live_sandbox "${2:-}"
    cmd_doctor "$SANDBOX"
    ;;
  stop)
    resolve_sandbox "${2:-}"
    if [ -f "$SANDBOX/env.sh" ]; then
      cmd_stop "$SANDBOX"
    else
      echo "Already stopped. Evidence at $SANDBOX/evidence"
    fi
    ;;
  *)
    sed -n 2,7p "${BASH_SOURCE[0]}" >&2
    exit 2
    ;;
esac
