# Credits Tracking UI Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Show credit balance in the side panel chat header and a dedicated Usage & Billing settings page, with live updates after each message turn.

**Architecture:** A `useCredits()` React Query hook fetches `GET /credits` from the agent server. The side panel header shows a color-coded badge (green >30, yellow 1-30, red 0). A new settings page at `/settings/usage` shows full details. Credits refresh after each completed chat turn or on CREDITS_EXHAUSTED error.

**Tech Stack:** React, React Query, Shadcn UI, Lucide icons, Hono (server already done)

---

### Task 1: Create useCredits() hook

**Files:**
- Create: `apps/agent/lib/credits/useCredits.ts`

**Step 1: Write the hook**

```typescript
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getAgentServerUrl } from '@/lib/browseros/helpers'

interface CreditsInfo {
  credits: number
  lastResetAt?: string
}

const CREDITS_QUERY_KEY = ['credits']

async function fetchCredits(): Promise<CreditsInfo> {
  const baseUrl = await getAgentServerUrl()
  const response = await fetch(`${baseUrl}/credits`)
  if (!response.ok) throw new Error(`Failed to fetch credits: ${response.status}`)
  return response.json()
}

export function useCredits() {
  return useQuery<CreditsInfo>({
    queryKey: CREDITS_QUERY_KEY,
    queryFn: fetchCredits,
    refetchOnWindowFocus: true,
    staleTime: 30_000,
    retry: 1,
  })
}

export function useInvalidateCredits() {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: CREDITS_QUERY_KEY })
}
```

**Step 2: Commit**

```bash
git add apps/agent/lib/credits/useCredits.ts
git commit -m "feat: add useCredits React Query hook"
```

---

### Task 2: Create CreditBadge component

**Files:**
- Create: `apps/agent/components/credits/CreditBadge.tsx`

**Step 1: Write the component**

The badge shows a coin icon + credit count, color-coded by threshold. Only renders when credits data is available.

```tsx
import { Coins } from 'lucide-react'
import type { FC } from 'react'
import { cn } from '@/lib/utils'

interface CreditBadgeProps {
  credits: number
  onClick?: () => void
}

function getCreditColor(credits: number): string {
  if (credits <= 0) return 'text-red-500'
  if (credits <= 30) return 'text-yellow-500'
  return 'text-green-500'
}

export const CreditBadge: FC<CreditBadgeProps> = ({ credits, onClick }) => {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium transition-colors hover:bg-muted/50',
        getCreditColor(credits),
      )}
      title={`${credits} credits remaining`}
    >
      <Coins className="h-3.5 w-3.5" />
      <span>{credits}</span>
    </button>
  )
}
```

**Step 2: Commit**

```bash
git add apps/agent/components/credits/CreditBadge.tsx
git commit -m "feat: add CreditBadge component with color thresholds"
```

---

### Task 3: Add CreditBadge to ChatHeader

**Files:**
- Modify: `apps/agent/entrypoints/sidepanel/index/ChatHeader.tsx`

**Step 1: Update ChatHeader**

Add the credit badge after the provider selector, only when provider is `browseros`. The badge links to the Usage & Billing settings page.

Changes to `ChatHeader.tsx`:
1. Import `CreditBadge` and `useCredits`
2. After the `ChatProviderSelector` closing tag (line 61), add the badge conditionally

```tsx
// Add imports at top:
import { CreditBadge } from '@/components/credits/CreditBadge'
import { useCredits } from '@/lib/credits/useCredits'

// After line 61 (closing </ChatProviderSelector>), before closing </div>:
{selectedProvider.type === 'browseros' && <CreditsBadgeWrapper />}
```

Create a small wrapper component inside the file to keep the hook call conditional:

```tsx
const CreditsBadgeWrapper: FC = () => {
  const { data } = useCredits()
  if (data === undefined) return null
  return (
    <CreditBadge
      credits={data.credits}
      onClick={() => window.open('/app.html#/settings/usage', '_blank')}
    />
  )
}
```

**Step 2: Commit**

```bash
git add apps/agent/entrypoints/sidepanel/index/ChatHeader.tsx
git commit -m "feat: show credit badge in chat header for BrowserOS provider"
```

---

### Task 4: Add credit refresh on message completion

**Files:**
- Modify: `apps/agent/entrypoints/sidepanel/index/useChatSession.ts`

**Step 1: Update useChatSession**

Import `useInvalidateCredits` and call it when a message turn completes (status transitions from streaming/submitted to ready) and when an error occurs.

```typescript
// Add import:
import { useInvalidateCredits } from '@/lib/credits/useCredits'

// Inside useChatSession(), near other hook calls:
const invalidateCredits = useInvalidateCredits()
```

Find the existing completion detection logic (where `saveLocalConversation` or `saveRemoteConversation` is called after status becomes 'ready'). Add `invalidateCredits()` call there.

Also, in the error handling path (where `chatError` is set), add `invalidateCredits()` to sync badge on CREDITS_EXHAUSTED.

**Step 2: Commit**

```bash
git add apps/agent/entrypoints/sidepanel/index/useChatSession.ts
git commit -m "feat: refresh credits after chat message completion and on error"
```

---

### Task 5: Update ChatError for CREDITS_EXHAUSTED

**Files:**
- Modify: `apps/agent/entrypoints/sidepanel/index/ChatError.tsx`

**Step 1: Add CREDITS_EXHAUSTED detection to parseErrorMessage**

In `parseErrorMessage()` (line 29), add a new detection block after the existing rate limit check (line 48):

```typescript
// After the 'BrowserOS LLM daily limit reached' block, add:
if (message.includes('CREDITS_EXHAUSTED') || message.includes('Daily credits exhausted')) {
  return {
    text: 'Daily credits exhausted. Credits reset at midnight UTC.',
    url: '/app.html#/settings/usage',
    isRateLimit: true,
  }
}
```

**Step 2: Commit**

```bash
git add apps/agent/entrypoints/sidepanel/index/ChatError.tsx
git commit -m "feat: handle CREDITS_EXHAUSTED error in chat"
```

---

### Task 6: Create Usage & Billing settings page

**Files:**
- Create: `apps/agent/entrypoints/app/usage/UsagePage.tsx`

**Step 1: Write the page component**

Follow the same pattern as `AISettingsPage.tsx` — a standalone page component rendered inside the settings sidebar layout.

```tsx
import { Coins } from 'lucide-react'
import type { FC } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useCredits } from '@/lib/credits/useCredits'
import { cn } from '@/lib/utils'

function getCreditColor(credits: number): string {
  if (credits <= 0) return 'text-red-500'
  if (credits <= 30) return 'text-yellow-500'
  return 'text-green-500'
}

function getProgressColor(credits: number): string {
  if (credits <= 0) return 'bg-red-500'
  if (credits <= 30) return 'bg-yellow-500'
  return 'bg-green-500'
}

export const UsagePage: FC = () => {
  const { data, isLoading } = useCredits()

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-12 text-muted-foreground text-sm">
        Loading usage data...
      </div>
    )
  }

  const credits = data?.credits ?? 0
  const total = 100
  const percentage = Math.min((credits / total) * 100, 100)

  return (
    <div className="space-y-6 p-6">
      <div>
        <h2 className="font-semibold text-lg">Usage & Billing</h2>
        <p className="text-muted-foreground text-sm">
          Monitor your BrowserOS AI credit usage.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Coins className="h-5 w-5" />
            Credits
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-baseline gap-2">
            <span className={cn('font-bold text-3xl', getCreditColor(credits))}>
              {credits}
            </span>
            <span className="text-muted-foreground text-sm">/ {total} daily</span>
          </div>

          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={cn('h-full rounded-full transition-all', getProgressColor(credits))}
              style={{ width: `${percentage}%` }}
            />
          </div>

          <div className="space-y-1 text-muted-foreground text-sm">
            <p>1 credit per request</p>
            <p>Resets daily at midnight UTC</p>
            {data?.lastResetAt && (
              <p>Last reset: {new Date(data.lastResetAt).toLocaleDateString()}</p>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Need more credits?</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-3 text-muted-foreground text-sm">
            Additional credit packages will be available soon.
          </p>
          <Button variant="outline" disabled>
            Add Credits (Coming Soon)
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
```

**Step 2: Commit**

```bash
git add apps/agent/entrypoints/app/usage/UsagePage.tsx
git commit -m "feat: add Usage & Billing settings page"
```

---

### Task 7: Register route and sidebar entry

**Files:**
- Modify: `apps/agent/entrypoints/app/App.tsx` — add route
- Modify: `apps/agent/components/sidebar/SettingsSidebar.tsx` — add sidebar entry

**Step 1: Add route to App.tsx**

Inside the `<Route path="settings">` block (after line 103, before closing `</Route>`):

```tsx
import { UsagePage } from './usage/UsagePage'

// Add as new route:
<Route path="usage" element={<UsagePage />} />
```

**Step 2: Add sidebar entry to SettingsSidebar.tsx**

Import `CreditCard` from lucide-react (line 1). Add entry to the "Other" section in `primarySettingsSections` array (after line 81):

```typescript
{ name: 'Usage & Billing', to: '/settings/usage', icon: CreditCard },
```

**Step 3: Commit**

```bash
git add apps/agent/entrypoints/app/App.tsx apps/agent/components/sidebar/SettingsSidebar.tsx
git commit -m "feat: register usage page route and sidebar entry"
```

---

### Task 8: Verify end-to-end

**Step 1: Start dev server**

```bash
bun run dev:watch -- --new
```

**Step 2: Visual verification checklist**

- [ ] Open side panel — credit badge shows next to BrowserOS provider name
- [ ] Badge color is green when credits > 30
- [ ] Send a chat message — after response completes, badge count decrements
- [ ] Click badge — opens settings/usage page
- [ ] Settings sidebar shows "Usage & Billing" under "Other"
- [ ] Usage page shows credit count, progress bar, reset info
- [ ] Exhaust credits — badge turns red, chat shows error message

**Step 3: Commit any fixes**
