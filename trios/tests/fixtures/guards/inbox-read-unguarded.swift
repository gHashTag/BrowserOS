// FIXTURE - deliberately broken. Not compiled, not linked, only grepped.
//
// pollQueenInbox() with its own dev-variant guard deleted. The startup site
// still has a guard, so the background loop is never created in a release
// build - but any other caller reaching this function directly now reads the
// dev inbox out of a release app (1090). The body is legal Swift on its own,
// so the compiler stays silent.
//
// `make guard-shapes` must reject this file. If it ever passes, the check
// can no longer see the regression it exists to catch.

    /// Reads any new lines appended since the last poll and delegates each one.
    /// The byte offset is persisted to UserDefaults after each read, so a
    /// restart resumes from where it stopped without re-delegating.
    private func pollQueenInbox() async {
        // The guard at the startup site stops the background loop from ever
        // being created in a release build. This one guards the read itself,
        // so no other caller - `enqueueQueenInboxEntry` included - can reach a
        // dev inbox out of a release app (1090).
        let path = Self.queenInboxPath
        guard FileManager.default.fileExists(atPath: path),
              let handle = try? FileHandle(forReadingFrom: URL(fileURLWithPath: path))
        else { return }
        defer { try? handle.close() }
    }
