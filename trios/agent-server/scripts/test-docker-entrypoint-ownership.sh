#!/bin/sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT HUP INT TERM
STUB_DIR="$TMP_DIR/bin"
WORK_DIR="$TMP_DIR/workspace"
CALLS="$TMP_DIR/calls"
MARKER="$WORK_DIR/.trinity-ownership-v1"
mkdir -p "$STUB_DIR" "$WORK_DIR/trios/.git"

cat >"$STUB_DIR/id" <<'EOF'
#!/bin/sh
if [ "${1:-}" = -u ]; then printf '%s\n' 4242; fi
exit 0
EOF
cat >"$STUB_DIR/chown" <<'EOF'
#!/bin/sh
printf 'chown:%s\n' "$*" >>"$ENTRYPOINT_CALLS"
EOF
cat >"$STUB_DIR/su" <<'EOF'
#!/bin/sh
last=""
for arg do last="$arg"; done
exec /bin/sh -c "$last"
EOF
cat >"$STUB_DIR/git" <<'EOF'
#!/bin/sh
printf 'git:%s\n' "$*" >>"$ENTRYPOINT_CALLS"
case "$*" in
  *rev-parse*) printf '%s\n' deadbee ;;
esac
exit 0
EOF
chmod +x "$STUB_DIR"/*

run_entrypoint() {
  ENTRYPOINT_CALLS="$CALLS" \
  PATH="$STUB_DIR:$PATH" \
  TRIOS_REPO_URL=https://example.invalid/trios.git \
  TRIOS_REPO_REF=main \
  TRIOS_TOOL_SHELL_USER=bee \
  WORKSPACE_DIR="$WORK_DIR" \
    "$ROOT/docker-entrypoint.sh" /usr/bin/true >/dev/null
}

printf 'uid=4242\n' >"$MARKER"
: >"$CALLS"
run_entrypoint
if grep -q '^chown:' "$CALLS"; then
  echo "valid completion marker triggered recursive chown" >&2
  exit 1
fi

printf 'uid=7\n' >"$MARKER"
: >"$CALLS"
run_entrypoint
expected="chown:-R bee $WORK_DIR"
first_call="$(sed -n '1p' "$CALLS")"
if [ "$first_call" != "$expected" ]; then
  echo "repair must be the exact first operation: got '$first_call'" >&2
  exit 1
fi
if [ "$(grep -c '^chown:' "$CALLS")" -ne 1 ]; then
  echo "owner mismatch did not trigger exactly one repair" >&2
  exit 1
fi
if [ "$(cat "$MARKER")" != 'uid=4242' ]; then
  echo "repair did not publish the current uid completion marker" >&2
  exit 1
fi
if ! sed -n '2,$p' "$CALLS" | grep -q '^git:'; then
  echo "git preflight did not follow ownership repair" >&2
  exit 1
fi

echo "docker entrypoint ownership contract: PASS"
