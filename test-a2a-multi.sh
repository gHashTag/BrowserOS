#!/usr/bin/env bash

# @license AGPL-3.0-or-later
# Copyright 2025 BrowserOS
#
# A2A Multi-Agent Test Script
#
# Manual test runner for all 5 multi-agent scenarios:
# - Directed routing
# - Event fanout
# - Reconnect correctness
# - Late join
# - Mixed traffic
#

set -e pipefail
set -e nounset

# ANSI color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# Test counters
TOTAL_TESTS=0
PASSED_TESTS=0
FAILED_TESTS=0

# Print banner
echo -e "${BOLD}A2A Multi-Agent Test Suite${NC}"
echo -e "${CYAN}========================================${NC}"
echo ""

# Check if required binaries exist
if ! command -v a2a-chat-client &>/dev/null; then
  echo -e "${RED}✗ Error: a2a-chat-client not found${NC}"
  echo -e "${YELLOW}→ Please ensure you have started the BrowserOS server${NC}"
  exit 1
fi

# Function to print test result
print_result() {
  local test_name="$1"
  local status="$2"
  local message="$3"

  if [ "$status" = "PASS" ]; then
    echo -e "${GREEN}✓${NC} ${BOLD}${test_name}${NC}: ${message}"
    PASSED_TESTS=$((PASSED_TESTS + 1))
  elif [ "$status" = "FAIL" ]; then
    echo -e "${RED}✗${NC} ${BOLD}${test_name}${NC}: ${message}"
    FAILED_TESTS=$((FAILED_TESTS + 1))
  else
    echo -e "${YELLOW}?${NC} ${BOLD}${test_name}${NC}: ${message}"
  fi
  TOTAL_TESTS=$((TOTAL_TESTS + 1))
}

# Function to run directed routing test
test_directed_routing() {
  echo -e "${BLUE}Test 1: Directed Routing${NC}"
  echo ""

  # Start two agents in background
  echo -e "Starting Agent1 (echo mode) on port 3001..."
  echo -e "Starting Agent2 (echo mode) on port 3001..."
  echo ""

  # Use the existing clients
  # Note: This is a simplified manual test approach
  # In production, these would be automated via test files

  sleep 2

  echo -e "${YELLOW}⚠ Manual verification required:${NC}"
  echo -e "1. Check that both agents connected to ws://127.0.0.1:3001/a2a/ws"
  echo -e "2. Send 'Hello from Agent1 to Agent2' from Agent1 client"
  echo -e "3. Verify Agent2 received the message (not Agent1)"
  echo -e "4. Verify Agent1 did NOT receive its own message (no loopback)"
  echo ""

  # For automated testing, use: bun test apps/server/tests/agent/portable/directed-routing.test.ts
  echo -e "${CYAN}See: packages/browseros-agent/apps/server/tests/agent/portable/directed-routing.test.ts${NC}"

  print_result "Directed routing" "INTEGRATION - Manual verification required"
}

# Function to run event fanout test
test_event_fanout() {
  echo -e "${BLUE}Test 2: Event Fanout${NC}"
  echo ""

  echo -e "${YELLOW}⚠ Manual verification required:${NC}"
  echo -e "1. Check SSE stream at http://127.0.0.1:3001/a2a/:conversationId/stream"
  echo -e "2. Connect 3 subscribers to the stream"
  echo -e "3. Broadcast event: { type: 'text-delta', text: 'Broadcast' }"
  echo -e "4. Verify all 3 subscribers received the event"
  echo -e "5. Disconnect one subscriber and broadcast another event"
  echo -e "6. Verify remaining 2 subscribers received new event, disconnected one did not"
  echo ""

  echo -e "${CYAN}See: packages/browseros-agent/apps/server/tests/agent/portable/event-fanout.test.ts${NC}"

  print_result "Event fanout" "INTEGRATION - Manual verification required"
}

# Function to run reconnect correctness test
test_reconnect_correctness() {
  echo -e "${BLUE}Test 3: Reconnect Correctness${NC}"
  echo ""

  echo -e "${YELLOW}⚠ Manual verification required:${NC}"
  echo -e "1. Connect agent to ws://127.0.0.1:3001/a2a/ws"
  echo -e "2. Send 3 messages (seq 1, 2, 3)"
  echo -e "3. Force disconnect (simulate network issue)"
  echo -e "4. Verify agent reconnects with exponential backoff"
  echo -e "5. After reconnect, send messages 4, 5 (seq should continue)"
  echo -e "6. Verify all 5 messages received in correct order (1,2,3,4,5)"
  echo ""

  echo -e "${CYAN}See: packages/browseros-agent/apps/server/tests/agent/portable/reconnect-correctness.test.ts${NC}"

  print_result "Reconnect correctness" "INTEGRATION - Manual verification required"
}

# Function to run late join test
test_late_join() {
  echo -e "${BLUE}Test 4: Late Join${NC}"
  echo ""

  echo -e "${YELLOW}⚠ Manual verification required:${NC}"
  echo -e "1. Start Agent1 and Agent2 (both echo mode)"
  echo -e "2. Exchange 3 messages between them"
  echo -e "3. Start Agent3 (late joiner, echo mode)"
  echo -e "4. Send 'Hello from Agent1 to Agent2'"
  echo -e "5. Verify Agent3 receives new message (not history)"
  echo -e "6. Verify Agent3 did NOT receive previous 3 messages"
  echo -e "7. Verify all 3 agents continue operating after join"
  echo ""

  echo -e "${CYAN}See: packages/browseros-agent/apps/server/tests/agent/portable/late-join.test.ts${NC}"

  print_result "Late join" "INTEGRATION - Manual verification required"
}

# Function to run mixed traffic test
test_mixed_traffic() {
  echo -e "${BLUE}Test 5: Mixed Traffic${NC}"
  echo ""

  echo -e "${YELLOW}⚠ Manual verification required:${NC}"
  echo -e "1. Connect to ws://127.0.0.1:3001/a2a/ws"
  echo -e "2. Send 'ready' message (control)"
  echo -e "3. Send 'chat' message (data): 'test message'"
  echo -e "4. Verify ready was processed BEFORE chat"
  echo -e "5. Send SSE event: { type: 'text-delta', text: 'streaming' }"
  echo -e "6. Verify SSE event and chat remain in separate channels"
  echo -e "7. Send 'error' message (control): 'Warning'"
  echo -e "8. Verify error was logged, but data stream continues"
  echo ""

  echo -e "${CYAN}See: packages/browseros-agent/apps/server/tests/agent/portable/mixed-traffic.test.ts${NC}"

  print_result "Mixed traffic" "INTEGRATION - Manual verification required"
}

# Function to run all tests
run_all_tests() {
  local choice=""

  while [ -z "$choice" ]; do
    echo -e ""
    echo -e "${BOLD}Select test to run:${NC}"
    echo ""
    echo -e "  ${BLUE}1${NC}) Directed routing"
    echo -e "  ${BLUE}2${NC}) Event fanout"
    echo -e "  ${BLUE}3${NC}) Reconnect correctness"
    echo -e "  ${BLUE}4${NC}) Late join"
    echo -e "  ${BLUE}5${NC}) Mixed traffic"
    echo -e "  ${BLUE}6${NC}) Run all tests"
    echo -e "  ${BLUE}0${NC}) Exit"
    echo ""
    read -p "Select option: " choice

    case "$choice" in
      1) test_directed_routing
         ;;
      2) test_event_fanout
         ;;
      3) test_reconnect_correctness
         ;;
      4) test_late_join
         ;;
      5) test_mixed_traffic
         ;;
      6)
         echo -e "${GREEN}Running all tests...${NC}"
         test_directed_routing
         test_event_fanout
         test_reconnect_correctness
         test_late_join
         test_mixed_traffic
         echo ""
         echo -e "${GREEN}All tests completed!${NC}"
         echo ""
         echo -e "${BOLD}Results:${NC}"
         echo -e "  Total: ${TOTAL_TESTS}"
         echo -e "  Passed: ${PASSED_TESTS}"
         if [ ${FAILED_TESTS} -gt 0 ]; then
           echo -e "  Failed: ${RED}${FAILED_TESTS}${NC}"
         fi
         echo ""
         echo -e "${BOLD}Press Enter to return to menu...${NC}"
         read -p "Return to menu: " choice
         ;;
      0)
         echo -e "${YELLOW}Exiting...${NC}"
         exit 0
         ;;
    esac
  done
}

# Show menu and run
run_all_tests
