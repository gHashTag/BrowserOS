#!/bin/bash
set -euo pipefail

# check_openrouter_keys.sh
#
# Validates OpenRouter API keys stored in environment variables.
# Keys are NOT embedded in this file. Set them before running, e.g.:
#
#   export OPENROUTER_KEY_1="sk-..."
#   export OPENROUTER_KEY_2="sk-..."
#   bash check_openrouter_keys.sh
#
# Or load from a .env file that is gitignored:
#   set -a && source .env && set +a && bash check_openrouter_keys.sh

ENDPOINT="https://openrouter.ai/api/v1/auth/key"

# Collect all OPENROUTER_KEY_* variables in numeric order
keys=()
while true; do
    var="OPENROUTER_KEY_$(( ${#keys[@]} + 1 ))"
    value="${!var:-}"
    [[ -z "$value" ]] && break
    keys+=("$value")
done

if [[ ${#keys[@]} -eq 0 ]]; then
    echo "No OPENROUTER_KEY_* environment variables found." >&2
    echo "Set them first, for example:" >&2
    echo "  export OPENROUTER_KEY_1=\"sk-...\"" >&2
    exit 1
fi

mask_key() {
    local key="$1"
    if [[ ${#key} -le 12 ]]; then
        echo "${key:0:4}..."
    else
        echo "${key:0:8}...${key: -4}"
    fi
}

format_json() {
    if command -v python3 >/dev/null 2>&1; then
        python3 -m json.tool
    else
        cat
    fi
}

for key in "${keys[@]}"; do
    masked=$(mask_key "$key")
    echo "=== $masked ==="

    response=$(curl -sS -H "Authorization: Bearer $key" "$ENDPOINT" || true)

    if [[ -z "$response" ]]; then
        echo "⚠️  EMPTY RESPONSE (network or curl error)"
    elif echo "$response" | grep -q '"data"'; then
        echo "✅ VALID"
        echo "$response" | format_json | head -40
        balance=$(echo "$response" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('data',{}).get('usage','?'))" 2>/dev/null || echo "?")
        limit=$(echo "$response" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('data',{}).get('limit','?'))" 2>/dev/null || echo "?")
        echo "   Balance/Usage: $balance | Limit: $limit"
    elif echo "$response" | grep -qi "invalid"; then
        echo "❌ INVALID"
    elif echo "$response" | grep -qi "rate"; then
        echo "⏳ RATE LIMITED — wait before retrying"
    else
        echo "⚠️  UNKNOWN RESPONSE:"
        echo "$response" | format_json | head -20
    fi
    echo
    sleep 1
done
