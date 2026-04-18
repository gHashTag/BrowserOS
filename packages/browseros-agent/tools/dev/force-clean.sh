#!/bin/bash
# Force-clean all BrowserOS dev processes and ports
# Use this when bun dev is stuck in restart loop

set -e

echo "=== BrowserOS Dev Force Clean ==="
echo ""

# 1. STOP everything - SIGKILL to be sure
echo "1. Killing all bun processes..."
pkill -9 -f "bun.*index.ts" 2>/dev/null || true
pkill -9 -f "bun.*wxt" 2>/dev/null || true
pkill -9 -f "browseros-dev" 2>/dev/null || true

# 2. Wait for processes to fully exit
sleep 2

# 3. Kill any process holding ports 3001, 9105, 9305, 9005
echo "2. Clearing ports 3001, 9105, 9305, 9005..."
for port in 3001 9105 9305 9005; do
    lsof -ti:$port 2>/dev/null | xargs -r kill -9 2>/dev/null || true
done

# 4. Wait and verify
sleep 1

echo "3. Verifying ports are free..."
BUSY=false
for port in 3001 9105 9305 9005; do
    if lsof -i:$port >/dev/null 2>&1; then
        echo "  ❌ Port $port is STILL BUSY!"
        BUSY=true
    else
        echo "  ✓ Port $port is free"
    fi
done

if [ "$BUSY" = true ]; then
    echo ""
    echo "⚠️  Some ports are still busy. You may need to:"
    echo "   1. Restart your terminal"
    echo "   2. Or run: sudo lsof -ti:\$(lsof -ti:9105,9305,9005,3001 | head -1) | xargs kill -9"
    exit 1
fi

echo ""
echo "✅ All ports cleared! You can now run: bun dev"
