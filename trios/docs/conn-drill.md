Connection-refusal events keep the task queued and do not consume a retry.
True failure events consume a retry and move the task to failed, as before.
