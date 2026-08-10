// FIXTURE - deliberately broken. Not compiled, not linked, only grepped.
//
// enqueueQueenInboxEntry() with the dev-variant guard deleted. This is the
// one entrance for a delegation arriving from outside the chat UI (1090);
// without the guard a release build happily encodes the entry and appends it
// to an inbox path that only the dev variant is supposed to own, and the
// caller is told the delegation was queued. The remaining body compiles, so
// nothing else notices.
//
// `make guard-shapes` must reject this file. If it ever passes, the check
// can no longer see the regression it exists to catch.

    @discardableResult
    internal func enqueueQueenInboxEntry(
        issue: String,
        worker: String?,
        title: String?,
        paths: [String]?,
        skill: String?,
        criteria: [String]?
    ) async -> Bool {
        let entry = QueenInboxEntry(
            issue: issue,
            worker: worker,
            title: title,
            paths: paths,
            skill: skill,
            criteria: criteria
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        guard var data = try? encoder.encode(entry) else {
            return false
        }
        data.append(0x0A)
        return true
    }
