# Credits Tracking UI Design

## Overview

Surface credit balance to users across two locations: a compact badge in the side panel chat header, and a dedicated Usage & Billing settings page. Credits refresh after each completed message turn or on error.

## 1. Side Panel — Credit Badge

**Location:** Chat header, next to provider selector. Only visible when provider is `browseros`.

**Display:**
- Coin/credit icon + remaining count (e.g., "87")
- Color-coded by threshold:
  - Green: >30 credits
  - Yellow/orange: 1–30 credits
  - Red: 0 credits
- Clicking the badge navigates to the Usage & Billing settings page

**Update triggers:**
- Message turn completes successfully (agent finishes all tool calls and responds)
- CREDITS_EXHAUSTED error mid-turn (badge syncs to 0, error shown in chat)

## 2. Settings — Usage & Billing Page

**Sidebar entry:** "Usage & Billing" in the "Other" section (icon: CreditCard or Coins).

**Route:** `/settings/usage`

**Content:**
- Credits card: large display of remaining credits (e.g., "87 / 100") with color-coded progress bar
- Reset info: "Resets daily at midnight UTC" with last reset date
- Credit cost: "1 credit per request"
- Placeholder section: "Need more credits?" with disabled "Add Credits" button (future payment/recharge)

## 3. Data Flow

**Hook:** `useCredits()` — React Query hook fetching `GET /credits` from the agent server.

**Refresh strategy:**
- Refetch after each completed message turn (`onFinish` callback in chat session)
- Refetch on CREDITS_EXHAUSTED error
- Refetch on window focus (React Query default)
- No aggressive polling

**State sharing:** Credits query is global (React Query cache). Both side panel badge and settings page read from the same cache key.

## 4. Error Handling (0 credits)

When credits are exhausted mid-conversation:
- Chat stream shows error via existing `ChatError.tsx` pattern: "Daily credits exhausted. Resets at midnight UTC." with link to Usage & Billing page
- Header badge turns red (0 credits)
- Chat input stays enabled — user can switch to a different provider

## 5. Future Hooks

- "Add Credits" button on Usage & Billing page (currently disabled placeholder)
- Payment integration will live entirely within the Usage & Billing page
- Credit badge could show a "+" icon when balance is low, linking to recharge
