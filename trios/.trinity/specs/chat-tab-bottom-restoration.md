# Chat Tab Bottom Restoration Specification

Issue: T27-EPIC-001
Task: CHAT-SCROLL-001
Owner: Chat UI

## Purpose

Open chat history at its latest content whenever the user returns from another
TriOS tab.

## Behavior

- Transitioning from a non-chat tab to Chat requests a bottom scroll.
- Initial chat appearance also resolves to the bottom anchor.
- The target is a permanent anchor after messages and loading indicators.
- Compact and expanded layouts use the same restoration request.
- Returning to Chat marks automatic streaming scroll as enabled again.
- New messages and streaming deltas request a throttled bottom scroll only
  while the final content anchor is within 100 points of the viewport bottom.
- Every throttled request publishes a consumable sequence and its animation
  policy; the `ScrollViewReader` observes that request and calls `scrollTo`.
- Viewport height and final-anchor position are measured independently.
  Content offset is never treated as viewport height.

## Tests

1. Non-chat to Chat requests bottom restoration.
2. Chat to Chat does not create a redundant request.
3. Chat to another tab does not request chat scrolling.
4. The restoration target is the final content anchor.
5. A final anchor inside the threshold is classified as near bottom.
6. A final anchor outside the threshold preserves manual reading position.
7. Short content remains near bottom.
8. A forced scroll publishes a new consumable request and animation policy.

## Invariants

- Manual reading position is not changed while Chat remains active.
- Conversation persistence and streaming are unchanged.
- New Swift and Markdown content is English and ASCII-only.
