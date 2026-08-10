// Fixture for make finish-mark-order.
//
// recordCompletedTurn is inside the deferred Task — the ordering #1248
// fixed.  The check must reject this.
runner.onFinish = { [weak self] task, failure, usage in
    guard let self else { return }
    Task {
        delegationRegistry.recordCompletedTurn(taskID: task.id)
        await self.handleWorkerFinished(task: task, failure: failure, usage: usage)
    }
}
