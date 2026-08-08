A connection refusal keeps the task queued (no retry spent, no failed state), re-queues when link returns, and logs a distinct event — remove that distinction and a connection drop reverts to killing the task.
A genuine failure consumes a retry and moves to failed, unchanged.
