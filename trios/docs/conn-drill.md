A connection refusal keeps the task queued (no retry spent, no failed state) and re-queues when the link returns; the journal distinguishes the two cases by a distinct event — not by message text — so removing that distinction lets a connection drop kill the task again.
A genuine failure consumes a retry and moves to failed, unchanged.
