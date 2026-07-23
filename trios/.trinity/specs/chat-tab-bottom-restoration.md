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

## Tests

1. Non-chat to Chat requests bottom restoration.
2. Chat to Chat does not create a redundant request.
3. Chat to another tab does not request chat scrolling.
4. The restoration target is the final content anchor.

## Invariants

- Manual reading position is not changed while Chat remains active.
- Conversation persistence and streaming are unchanged.
- New Swift and Markdown content is English and ASCII-only.
