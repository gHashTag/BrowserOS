// Broken fixture for the reaper's stream-open guard (make guard-shapes).
//
// The anchor is present and the guard is NOT. This is the exact shape an
// adversary produced: the pure predicates stay correct and fully tested, the
// reaper simply stops consulting one of them, and every scenario in the e2e
// suite still passes because the suite's helper carries its own copy of the
// line. guard-shapes must reject this file.
        for task in toProcess {
            let current = registry.task(forConversation: task.conversationId) ?? task

            if connectivityFailedTasks.contains(task.id), let runner = workerRunner {
                connectivityFailedTasks.remove(task.id)
                runner.start(task: task, brief: "")
                continue
            }
        }
