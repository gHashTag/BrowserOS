import SwiftUI

struct LogsTabView: View {
    @State private var sources: [LogSource] = []
    @State private var selectedSourceID: String?
    @State private var isLoading = false
    @State private var lastRefresh = Date()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                header
                cooperationOptions
                logSourcesSection
                selectedLogDetail
            }
            .frame(maxWidth: 880, alignment: .leading)
            .padding(20)
            .frame(maxWidth: .infinity)
        }
        .background(Color.grokBackground.ignoresSafeArea())
        .onAppear(perform: loadAll)
    }

    // MARK: - Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text("LOGS")
                    .font(.system(size: 22, weight: .bold))
                    .foregroundColor(.grokText)
                Spacer()
                Button(action: loadAll) {
                    Image(systemName: "arrow.clockwise")
                        .font(.system(size: 12, weight: .semibold))
                }
                .buttonStyle(.borderless)
                .disabled(isLoading)
            }
            Text("All variants, runtime logs, and Trinity events in one place.")
                .font(.system(size: 12))
                .foregroundColor(.grokMuted)
        }
    }

    // MARK: - Cooperation options (next-loop variants)

    private var cooperationOptions: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Next-loop variants")
                .font(.system(size: 14, weight: .semibold))
                .foregroundColor(.grokText)

            HStack(alignment: .top, spacing: 12) {
                optionCard(
                    number: 1,
                    title: "Preflight health check",
                    summary: "Probe provider model list or a tiny chat request before each turn; disable unavailable models in the picker and auto-select a healthy fallback. Highest confidence, adds latency.",
                    status: "Recommended next"
                )
                optionCard(
                    number: 2,
                    title: "Persistent reliability scoring",
                    summary: "Track per-model success/failure rates over time and auto-rank the fallback chain. Requires telemetry and convergence time.",
                    status: "Research"
                )
                optionCard(
                    number: 3,
                    title: "Multi-provider failover",
                    summary: "Allow the fallback chain to cross providers (OpenRouter → Z.AI → Ollama local). Most resilient, but involves multiple API keys and billing surfaces.",
                    status: "Future"
                )
            }
        }
    }

    private func optionCard(number: Int, title: String, summary: String, status: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Text("\(number)")
                    .font(.system(size: 11, weight: .bold, design: .rounded))
                    .foregroundColor(.white)
                    .frame(width: 20, height: 20)
                    .background(Circle().fill(Color.grokAccent))
                Text(title)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(.grokText)
                Spacer(minLength: 0)
            }
            Text(summary)
                .font(.system(size: 11))
                .foregroundColor(.grokMuted)
                .lineLimit(5)
            Text(status)
                .font(.system(size: 10, weight: .semibold))
                .foregroundColor(statusColor(status))
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(statusColor(status).opacity(0.12))
                .clipShape(Capsule())
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.grokSurface)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay {
            RoundedRectangle(cornerRadius: 12)
                .stroke(Color.grokBorder)
        }
    }

    private func statusColor(_ status: String) -> Color {
        switch status {
        case "Recommended next": return .green
        case "Research": return .orange
        case "Future": return .grokDim
        default: return .grokMuted
        }
    }

    // MARK: - Log sources

    private var logSourcesSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Log sources")
                .font(.system(size: 14, weight: .semibold))
                .foregroundColor(.grokText)

            if sources.isEmpty && !isLoading {
                Text("No log sources found.")
                    .font(.system(size: 12))
                    .foregroundColor(.grokMuted)
            }

            LazyVGrid(columns: [GridItem(.adaptive(minimum: 160), spacing: 10)], spacing: 10) {
                ForEach(sources) { source in
                    Button {
                        selectedSourceID = source.id
                    } label: {
                        VStack(alignment: .leading, spacing: 5) {
                            HStack(spacing: 5) {
                                Image(systemName: source.icon)
                                    .foregroundColor(source.tint)
                                    .font(.system(size: 12))
                                Text(source.name)
                                    .font(.system(size: 12, weight: .semibold))
                                    .foregroundColor(.grokText)
                                    .lineLimit(1)
                                Spacer(minLength: 0)
                            }
                            Text(source.path.lastPathComponent)
                                .font(.system(size: 10, design: .monospaced))
                                .foregroundColor(.grokDim)
                                .lineLimit(1)
                            HStack(spacing: 6) {
                                badge("\(source.errorCount) errors", tint: .red, show: source.errorCount > 0)
                                badge("\(source.warningCount) warnings", tint: .orange, show: source.warningCount > 0)
                                badge("\(source.lines.count) lines", tint: .grokMuted, show: true)
                            }
                        }
                        .padding(10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(selectedSourceID == source.id ? Color.grokElevated : Color.grokSurface)
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                        .overlay {
                            RoundedRectangle(cornerRadius: 10)
                                .stroke(selectedSourceID == source.id ? Color.grokAccent : Color.grokBorder)
                        }
                    }
                    .buttonStyle(.plain)
                }
            }

            Text("Refreshed: \(lastRefresh.formatted(date: .omitted, time: .standard))")
                .font(.system(size: 10))
                .foregroundColor(.grokDim)
        }
    }

    private func badge(_ text: String, tint: Color, show: Bool) -> some View {
        Group {
            if show {
                Text(text)
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundColor(tint)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 2)
                    .background(tint.opacity(0.12))
                    .clipShape(Capsule())
            }
        }
    }

    private var selectedLogDetail: some View {
        Group {
            if let source = sources.first(where: { $0.id == selectedSourceID }) {
                VStack(alignment: .leading, spacing: 10) {
                    HStack(spacing: 8) {
                        Image(systemName: source.icon)
                            .foregroundColor(source.tint)
                        Text(source.name)
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundColor(.grokText)
                        Spacer()
                        Button("Copy") {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(source.lines.joined(separator: "\n"), forType: .string)
                        }
                        .buttonStyle(.borderless)
                        .font(.system(size: 11))
                    }
                    Text(source.path)
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundColor(.grokDim)
                        .textSelection(.enabled)
                    logLinesView(source: source)
                }
                .padding(12)
                .background(Color.grokSurface)
                .clipShape(RoundedRectangle(cornerRadius: 12))
                .overlay {
                    RoundedRectangle(cornerRadius: 12)
                        .stroke(Color.grokBorder)
                }
            }
        }
    }

    private func logLinesView(source: LogSource) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            ForEach(Array(source.displayLines.enumerated()), id: \.offset) { index, line in
                HStack(alignment: .top, spacing: 6) {
                    Text("\(source.startLine + index + 1)")
                        .font(.system(size: 9, design: .monospaced))
                        .foregroundColor(.grokDim)
                        .frame(width: 38, alignment: .trailing)
                    Text(line)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundColor(lineColor(line))
                        .textSelection(.enabled)
                        .lineLimit(3)
                    Spacer(minLength: 0)
                }
            }
        }
        .padding(8)
        .background(Color.black.opacity(0.18))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private func lineColor(_ line: String) -> Color {
        let lower = line.lowercased()
        if lower.contains("error") || lower.contains("fatal") || lower.contains("failed") || lower.contains("exception") {
            return .red
        }
        if lower.contains("warning") || lower.contains("warn") {
            return .orange
        }
        return .grokText
    }

    // MARK: - Loading

    private func loadAll() {
        guard !isLoading else { return }
        isLoading = true
        DispatchQueue.global(qos: .userInitiated).async {
            var loaded: [LogSource] = []

            let eventLogPath = ProjectPaths.trinityEventLog
            loaded.append(parseSource(name: "Event Log", path: eventLogPath, icon: "list.bullet.rectangle", tint: .blue))

            let cronLogPath = ProjectPaths.trinityLog
            loaded.append(parseSource(name: "Cron Log", path: cronLogPath, icon: "clock.arrow.2.circlepath", tint: .purple))

            let logsDir = "\(ProjectPaths.trinity)/logs"
            if let files = try? FileManager.default.contentsOfDirectory(atPath: logsDir).sorted() {
                for file in files where file.hasSuffix(".log") {
                    let path = "\(logsDir)/\(file)"
                    let name = file.replacingOccurrences(of: ".log", with: "")
                    loaded.append(parseSource(name: name, path: path, icon: "doc.text", tint: .grokMuted))
                }
            }

            let queenLogPath = "\(ProjectPaths.trinity)/queen.log"
            loaded.append(parseSource(name: "Queen Log", path: queenLogPath, icon: "crown", tint: .yellow))

            DispatchQueue.main.async {
                sources = loaded.filter { !$0.lines.isEmpty || FileManager.default.fileExists(atPath: $0.path) }
                if selectedSourceID == nil, let first = sources.first {
                    selectedSourceID = first.id
                }
                lastRefresh = Date()
                isLoading = false
            }
        }
    }

    private func parseSource(name: String, path: String, icon: String, tint: Color) -> LogSource {
        var lines: [String] = []
        if let data = FileManager.default.contents(atPath: path),
           let text = String(data: data, encoding: .utf8)?.replacingOccurrences(of: "\r\n", with: "\n") {
            lines = text.components(separatedBy: "\n").filter { !$0.isEmpty }
        }
        let errorCount = lines.filter { lineColor($0) == .red }.count
        let warningCount = lines.filter { lineColor($0) == .orange }.count
        return LogSource(
            name: name,
            path: path,
            icon: icon,
            tint: tint,
            lines: lines,
            errorCount: errorCount,
            warningCount: warningCount
        )
    }
}

// MARK: - Log source model

struct LogSource: Identifiable {
    let id = UUID().uuidString
    let name: String
    let path: String
    let icon: String
    let tint: Color
    let lines: [String]
    let errorCount: Int
    let warningCount: Int

    var displayLines: [String] {
        Array(lines.suffix(120))
    }

    var startLine: Int {
        max(0, lines.count - displayLines.count)
    }
}

// MARK: - String helpers

private extension String {
    var lastPathComponent: String {
        (self as NSString).lastPathComponent
    }
}
