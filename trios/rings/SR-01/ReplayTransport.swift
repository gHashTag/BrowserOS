import Foundation

/// Replays a recorded SSE stream instead of calling a provider.
///
/// The missing organ from the brain atlas. trios validates every change with one
/// live run against one provider on one machine, so a failure that appears one
/// time in three costs a whole session to characterise: each attempt is a
/// different conversation with a different model on a different day.
///
/// A recording removes every one of those variables. The same bytes arrive in
/// the same order every time, so a bug either reproduces or it does not, and
/// "one in three" becomes a fact you can bisect rather than a mood.
///
/// After FoundationDB and TigerBeetle: the value is not that the simulation is
/// realistic, it is that it is *identical* on every run.
///
/// Covered in CI by the chat SSE harness rather than by `make cassettes`: the
/// app-level suite needs a window server, this does not.
actor ReplayTransport: ChatTransportProtocol {
    enum ReplayError: Error, CustomStringConvertible {
        case cassetteMissing(String)
        case cassetteEmpty(String)

        var description: String {
            switch self {
            case .cassetteMissing(let path): return "No recording at \(path)"
            case .cassetteEmpty(let path): return "The recording at \(path) has no events"
            }
        }
    }

    private let path: String
    /// Delay between events. Zero by default: a replay that sleeps for realism
    /// turns a two-second test into a two-minute one and buys nothing, because
    /// nothing downstream measures wall-clock.
    private let interEventDelay: Duration
    private var isCancelled = false

    init(path: String, interEventDelay: Duration = .zero) {
        self.path = path
        self.interEventDelay = interEventDelay
    }

    func sendMessage(body: Data) async throws -> AsyncStream<SSEEvent> {
        isCancelled = false
        guard let contents = try? String(contentsOfFile: path, encoding: .utf8) else {
            throw ReplayError.cassetteMissing(path)
        }
        let events = Self.parse(contents)
        guard !events.isEmpty else { throw ReplayError.cassetteEmpty(path) }
        // A cassette proves stream handling. Effects extend it to what the bee
        // actually wrote, so the commit path - baseline diff, owned-path filter,
        // branch update - is exercised too rather than always seeing an empty
        // working tree and reporting "changed no files" as a pass.
        Self.applyEffects(Self.parseEffects(contents))

        let delay = interEventDelay
        return AsyncStream { continuation in
            Task { [weak self] in
                for event in events {
                    if await self?.isCancelled == true { break }
                    if delay > .zero { try? await Task.sleep(for: delay) }
                    continuation.yield(event)
                }
                continuation.finish()
            }
        }
    }

    func cancel() async {
        isCancelled = true
    }

    /// Reads a cassette: one raw SSE `data:` payload per line.
    ///
    /// The recording is the wire format rather than decoded events on purpose.
    /// A cassette of decoded events would test the code below the parser and
    /// silently skip the parser itself, which is where several real defects
    /// have lived.
    /// A file the cassette says the worker wrote.
    struct Effect: Equatable {
        let relativePath: String
        let contents: String
    }

    /// Reads `#effect: write <path> <content>` directives.
    ///
    /// Deliberately one line per effect and no escaping: a cassette is a test
    /// fixture a human writes and reads, and a format that needs a parser to
    /// review is a format nobody reviews.
    static func parseEffects(_ contents: String) -> [Effect] {
        contents
            .components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { $0.hasPrefix("#effect: write ") }
            .compactMap { line in
                let body = String(line.dropFirst("#effect: write ".count))
                let parts = body.split(separator: " ", maxSplits: 1).map(String.init)
                guard parts.count == 2, !parts[0].isEmpty else { return nil }
                return Effect(relativePath: parts[0], contents: parts[1])
            }
    }

    /// Writes the declared files, refusing anything outside the project.
    ///
    /// A cassette is checked-in data, and data that can write anywhere on the
    /// disk is a scripting language nobody audited. Paths are resolved against
    /// the project root and rejected if they escape it.
    static func applyEffects(_ effects: [Effect]) {
        let root = URL(fileURLWithPath: ProjectPaths.root).standardizedFileURL
        for effect in effects {
            let target = URL(fileURLWithPath: effect.relativePath, relativeTo: root)
                .standardizedFileURL
            guard target.path.hasPrefix(root.path + "/") else {
                NSLog("[ReplayTransport] refused effect outside the project: %@", effect.relativePath)
                continue
            }
            try? FileManager.default.createDirectory(
                at: target.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try? (effect.contents + "\n").write(to: target, atomically: true, encoding: .utf8)
        }
    }

    static func parse(_ contents: String) -> [SSEEvent] {
        contents
            .components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && !$0.hasPrefix("#") }
            .compactMap { line in
                // Feed the real parser, prefixing a bare payload so a cassette
                // can be hand-written without the SSE framing.
                let framed = line.hasPrefix("data: ") ? line : "data: " + line
                return SSEEventParser.parse(line: framed)
            }
    }
}

/// Writes a cassette while a real stream runs.
///
/// Recording is opt-in via `TRIOS_RECORD_CASSETTE`, because a transport that
/// always writes to disk is a transport that fills it.
actor CassetteRecorder {
    private let path: String
    private var lines: [String] = []

    init(path: String) {
        self.path = path
    }

    func record(_ raw: String) {
        lines.append(raw)
    }

    /// Flushes to disk. Called at stream end rather than per event: an
    /// interrupted recording is worse than none, because it looks complete.
    func flush() {
        let directory = (path as NSString).deletingLastPathComponent
        try? FileManager.default.createDirectory(
            atPath: directory,
            withIntermediateDirectories: true
        )
        let header = "# trios SSE cassette. One raw event payload per line.\n"
        try? (header + lines.joined(separator: "\n") + "\n")
            .write(toFile: path, atomically: true, encoding: .utf8)
    }
}
