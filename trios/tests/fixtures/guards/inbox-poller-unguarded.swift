// FIXTURE - deliberately broken. Not compiled, not linked, only grepped.
//
// This is the shape ChatViewModel.swift had after the dev-variant guard
// around the Queen inbox poller was deleted: the body survived, so the
// compiler was happy and a release build would have polled the dev inbox.
//
// `make guard-shapes` must reject this file. If it ever passes, the check
// can no longer see the regression it exists to catch.

        // #1150: Dev-only inbox poller. Reads `.trinity-dev/state/queen_inbox.jsonl`,
        // remembers its byte offset, and approves + delegates each new line.
        queenInboxOffset = UInt64(
            UserDefaults.standard.double(forKey: Self.queenInboxOffsetKey)
        )
        queenInboxPollTask = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                await self.pollQueenInbox()
                try? await Task.sleep(nanoseconds: 5_000_000_000)
            }
        }

        NSLog("ChatViewModel.init finished")
