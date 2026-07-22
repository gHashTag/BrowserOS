#!/bin/bash
# E2E: two clade-meshd instances exchange a sealed chat frame over UDP.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../../../../.." && pwd)"
BIN="$PROJECT_DIR/trios/target/debug/clade-meshd"
TMP="$(mktemp -d)"
trap 'kill $(jobs -p) 2>/dev/null || true; rm -rf "$TMP"' EXIT

# Build the daemon once.
echo "[e2e] building clade-meshd..."
cargo build -p clade-meshd --manifest-path "$PROJECT_DIR/trios/Cargo.toml" 2>&1 | tail -5

mkdir -p "$TMP/keys1" "$TMP/keys2"

# Start node 1.
env \
  TRIOS_MESH_NODE_ID=1 \
  TRIOS_MESH_PORT=9505 \
  TRIOS_MESH_UDP_BIND=127.0.0.1:9601 \
  TRIOS_MESH_KEY_DIR="$TMP/keys1" \
  TRIOS_MESH_CHAT_STORE="$TMP/store1.json" \
  "$BIN" > "$TMP/d1.log" 2>&1 &
D1=$!

# Start node 2.
env \
  TRIOS_MESH_NODE_ID=2 \
  TRIOS_MESH_PORT=9506 \
  TRIOS_MESH_UDP_BIND=127.0.0.1:9602 \
  TRIOS_MESH_KEY_DIR="$TMP/keys2" \
  TRIOS_MESH_CHAT_STORE="$TMP/store2.json" \
  "$BIN" > "$TMP/d2.log" 2>&1 &
D2=$!

wait_for_health() {
  local url=$1
  for _ in $(seq 1 50); do
    if curl -fs "$url/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

echo "[e2e] waiting for daemons..."
wait_for_health "http://127.0.0.1:9505" || { echo "node 1 health failed"; cat "$TMP/d1.log"; exit 1; }
wait_for_health "http://127.0.0.1:9506" || { echo "node 2 health failed"; cat "$TMP/d2.log"; exit 1; }

# Extract public keys and UDP addresses from startup logs.
PUB1=$(grep -o 'public_key=[^ ]*' "$TMP/d1.log" | cut -d= -f2-)
PUB2=$(grep -o 'public_key=[^ ]*' "$TMP/d2.log" | cut -d= -f2-)
UDP1=$(grep -o 'udp=[^ ]*' "$TMP/d1.log" | cut -d= -f2)
UDP2=$(grep -o 'udp=[^ ]*' "$TMP/d2.log" | cut -d= -f2)

echo "[e2e] node 1 udp=$UDP1 pub=${PUB1:0:16}..."
echo "[e2e] node 2 udp=$UDP2 pub=${PUB2:0:16}..."

# Seed each side with the other's key + UDP address.
echo "[e2e] seeding peers..."
curl -fs -X POST "http://127.0.0.1:9505/seed-peer" \
  -H 'Content-Type: application/json' \
  -d "{\"peer\":2,\"public_key\":\"$PUB2\",\"address\":\"$UDP2\"}" >/dev/null

curl -fs -X POST "http://127.0.0.1:9506/seed-peer" \
  -H 'Content-Type: application/json' \
  -d "{\"peer\":1,\"public_key\":\"$PUB1\",\"address\":\"$UDP1\"}" >/dev/null

# Send a message from node 1 to node 2.
echo "[e2e] sending message..."
SEND=$(curl -fs -X POST "http://127.0.0.1:9505/messages/send" \
  -H 'Content-Type: application/json' \
  -d '{"dst":2,"kind":0,"text":"hello over udp"}')
echo "[e2e] send response: $SEND"
if ! echo "$SEND" | grep -q '"queued":true'; then
  echo "[e2e] message was not queued/forwarded"
  exit 1
fi

# Poll node 2 until the message arrives.
echo "[e2e] polling node 2..."
for _ in $(seq 1 50); do
  POLL=$(curl -fs "http://127.0.0.1:9506/messages/poll?since_id=0" 2>/dev/null || echo '{}')
  if echo "$POLL" | grep -q 'hello over udp'; then
    echo "[e2e] SUCCESS: message delivered over UDP"
    kill $D1 $D2 2>/dev/null || true
    wait $D1 $D2 2>/dev/null || true
    exit 0
  fi
  sleep 0.1
done

echo "[e2e] FAIL: message did not arrive at node 2"
echo "node 1 log:"
cat "$TMP/d1.log"
echo "node 2 log:"
cat "$TMP/d2.log"
exit 1
