import SwiftUI
import UniformTypeIdentifiers

// MARK: - Color / icon helpers for log levels

extension LogLevel {
    var color: Color {
        switch self {
        case .trace, .debug: return .grokDim
        case .info: return .blue.opacity(0.8)
        case .warn: return .orange
        case .error, .fatal: return .red
        }
    }

    var icon: String {
        switch self {
        case .trace, .debug: return "circle"
        case .info: return "info.circle"
        case .warn: return "exclamationmark.triangle"
        case .error: return "xmark.octagon"
        case .fatal: return "xmark.shield"
        }
    }
}

private func tintColor(_ name: String) -> Color {
    switch name {
    case "blue": return .blue
    case "purple": return .purple
    case "yellow": return .yellow
    case "green": return .green
    case "red": return .red
    case "orange": return .orange
    default: return .grokMuted
    }
}

extension LogTimelineMode {
    var label: String {
        switch self {
        case .sources: return "Sources"
        case .unified: return "Timeline"
        }
    }
}

// MARK: - Main view

struct LogsTabView: View {
    @State private var sources: [LogSource] = []
    @State private var selectedSourceID: String?
    @State private var isLoading = false
    @State private var lastRefresh: Date?
    @State private var searchText = ""
    @State private var lastExportPath: String?
    @State private var minLevel: LogLevel = .info
    @State private var deduplicate = true
    @State private var suppressNoise = true
    @State private var hiddenSourceIDs: Set<String> = []
    @State private var isLive = false
    @State private var liveTask: Task<Void, Never>?
    @State private var liveTick: UInt = 0
    @State private var isFollowPaused = false
    @State private var savedSearches: [LogSavedSearch] = []
    @State private var showingSaveSearchAlert = false
    @State private var newSearchLabel = ""
    @State private var recentSearches: [LogRecentSearch] = []
    @State private var showingClearHistoryAlert = false
    @State private var recordTask: Task<Void, Never>?
    @State private var timelineMode: LogTimelineMode = .sources
    @State private var noiseProfile = LogNoiseProfile()
    @State private var showingNoiseProfileSheet = false
    @State private var pendingRulePreview: LogNoiseRule?
    @State private var rulePreviewCount: Int = 0
    @State private var showArtifactLogs: Bool = UserDefaults.standard.bool(forKey: "trios_logs_show_artifact_logs")

    private let maxLinesPerSource = 500
    private let liveInterval: UInt64 = 5_000_000_000
    private let recentSearchRecordDebounce: UInt64 = 3_000_000_000
    private let noiseProfileStore = LogNoiseProfileStore()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                header
                insightsBar
                sourceFilterBar
                sourceCards
                timelineModePicker
                quickFiltersBar
                recentSearchesBar
                filterBar
                detailSection
            }
            .frame(maxWidth: 980, alignment: .leading)
            .padding(20)
            .frame(maxWidth: .infinity)
        }
        .background(Color.grokBackground.ignoresSafeArea())
        .onAppear {
            showArtifactLogs = UserDefaults.standard.bool(forKey: "trios_logs_show_artifact_logs")
            loadAll()
            loadSavedSearches()
            loadRecentSearches()
            loadNoiseProfile()
        }
        .onChange(of: showArtifactLogs) { _, isOn in
            UserDefaults.standard.set(isOn, forKey: "trios_logs_show_artifact_logs")
            loadAll()
        }
        .onDisappear {
            stopLive()
            recordTask?.cancel()
        }
        .alert("Save quick filter", isPresented: $showingSaveSearchAlert) {
            TextField("Label", text: $newSearchLabel)
            Button("Save") {
                addSavedSearch(label: newSearchLabel)
            }
            Button("Cancel", role: .cancel) { }
        } message: {
            Text("Save current query as a quick filter.")
        }
        .alert("Clear recent searches", isPresented: $showingClearHistoryAlert) {
            Button("Clear", role: .destructive) {
                clearRecentSearches()
            }
            Button("Cancel", role: .cancel) { }
        } message: {
            Text("Remove all recent search history? This cannot be undone.")
        }
        .sheet(isPresented: $showingNoiseProfileSheet) {
            NoiseProfileSheet(
                profile: $noiseProfile,
                availableSources: sources,
                previewCount: rulePreviewCount,
                pendingRule: pendingRulePreview,
                onSave: { updated, acceptedPending in
                    Task {
                        await noiseProfileStore.updateRules(updated.customRules)
                        if acceptedPending, let rule = pendingRulePreview {
                            await noiseProfileStore.addRule(rule)
                        }
                        let reloaded = await noiseProfileStore.load()
                        await MainActor.run {
                            noiseProfile = reloaded
                            pendingRulePreview = nil
                            rulePreviewCount = 0
                        }
                    }
                }
            )
        }
        .onChange(of: isLive) { _, isOn in
            if isOn {
                startLive()
            } else {
                stopLive()
                isFollowPaused = false
            }
        }
        .onChange(of: searchText) { _, newValue in
            scheduleRecordRecentSearch(query: newValue)
        }
    }

    // MARK: - Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text("LOGS")
                    .font(.system(size: 22, weight: .bold))
                    .foregroundColor(.grokText)
                Spacer()
                liveToggle
                Toggle("Show build/test logs", isOn: $showArtifactLogs)
                    .toggleStyle(.switch)
                    .font(.system(size: 11))
                    .foregroundColor(.grokMuted)
                    .frame(width: 160)
                Button(action: loadAll) {
                    Image(systemName: "arrow.clockwise")
                        .font(.system(size: 12, weight: .semibold))
                }
                .buttonStyle(.borderless)
                .disabled(isLoading)
            }
            HStack(spacing: 6) {
                Text("Runtime logs from .trinity and app services.")
                    .font(.system(size: 12))
                    .foregroundColor(.grokMuted)
                if let lastRefresh {
                    Text("Updated \(timeAgo(lastRefresh))")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundColor(isLive ? .green : .grokDim)
                }
            }
        }
    }

    private var liveToggle: some View {
        HStack(spacing: 5) {
            Circle()
                .fill(isLive ? (isFollowPaused ? Color.orange : Color.green) : Color.grokDim)
                .frame(width: 6, height: 6)
            Toggle("Live", isOn: $isLive)
                .toggleStyle(.switch)
                .font(.system(size: 11))
                .foregroundColor(.grokMuted)
                .frame(width: 70)
            if isLive && isFollowPaused {
                Text("paused")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundColor(.orange)
            }
        }
    }

    // MARK: - Insights bar

    private var insightsBar: some View {
        HStack(spacing: 10) {
            insightChip(
                icon: "doc.text",
                value: "\(visibleSources.count)",
                label: "sources",
                tint: .grokMuted
            )
            insightChip(
                icon: "xmark.octagon",
                value: "\(totalErrorsAndFatals)",
                label: "errors",
                tint: .red
            )
            insightChip(
                icon: "exclamationmark.triangle",
                value: "\(totalWarnings)",
                label: "warnings",
                tint: .orange
            )
            insightChip(
                icon: "square.3.layers.3d.down.right",
                value: "\(totalCollapsedDuplicates)",
                label: "dup groups",
                tint: .grokDim
            )
            if cappedSourceCount > 0 {
                insightChip(
                    icon: "ellipsis",
                    value: "\(cappedSourceCount)",
                    label: "capped",
                    tint: .yellow
                )
            }
            Spacer()
        }
    }

    private func insightChip(icon: String, value: String, label: String, tint: Color) -> some View {
        HStack(spacing: 5) {
            Image(systemName: icon)
                .font(.system(size: 10))
                .foregroundColor(tint)
            Text(value)
                .font(.system(size: 12, weight: .bold))
                .foregroundColor(.grokText)
            Text(label)
                .font(.system(size: 10))
                .foregroundColor(.grokMuted)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(Color.grokSurface)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(Color.grokBorder)
        }
    }

    // MARK: - Source filter bar

    private var sourceFilterBar: some View {
        LogsFlowLayout(spacing: 8) {
            ForEach(sources) { source in
                let isHidden = hiddenSourceIDs.contains(source.id)
                let tint = tintColor(source.tintName)
                Button {
                    if isHidden {
                        hiddenSourceIDs.remove(source.id)
                    } else {
                        hiddenSourceIDs.insert(source.id)
                    }
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: source.icon)
                            .font(.system(size: 10))
                            .foregroundColor(isHidden ? .grokDim : tint)
                        Text(source.displayName)
                            .font(.system(size: 11, weight: .medium))
                            .foregroundColor(isHidden ? .grokDim : .grokText)
                        if source.errorCount > 0 {
                            Text("\(source.errorCount)")
                                .font(.system(size: 9, weight: .bold))
                                .foregroundColor(.white)
                                .padding(.horizontal, 5)
                                .padding(.vertical, 1)
                                .background(Color.red)
                                .clipShape(Capsule())
                        }
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(isHidden ? Color.clear : Color.grokSurface)
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .stroke(isHidden ? Color.grokBorder.opacity(0.5) : tint.opacity(0.5))
                    }
                }
                .buttonStyle(.plain)
            }
        }
    }

    // MARK: - Source cards

    private var sourceCards: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Log sources")
                .font(.system(size: 14, weight: .semibold))
                .foregroundColor(.grokText)

            if visibleSources.isEmpty && !isLoading {
                Text("No log sources found.")
                    .font(.system(size: 12))
                    .foregroundColor(.grokMuted)
            }

            LazyVGrid(columns: [GridItem(.adaptive(minimum: 180), spacing: 10)], spacing: 10) {
                ForEach(visibleSources) { source in
                    let tint = tintColor(source.tintName)
                    Button {
                        selectedSourceID = source.id
                    } label: {
                        VStack(alignment: .leading, spacing: 6) {
                            HStack(spacing: 5) {
                                Image(systemName: source.icon)
                                    .foregroundColor(tint)
                                    .font(.system(size: 12))
                                Text(source.displayName)
                                    .font(.system(size: 12, weight: .semibold))
                                    .foregroundColor(.grokText)
                                    .lineLimit(1)
                                Spacer(minLength: 0)
                            }
                            Text(source.name)
                                .font(.system(size: 10))
                                .foregroundColor(.grokMuted)
                                .lineLimit(1)
                            HStack(spacing: 6) {
                                badge("\(source.errorCount) errors", tint: .red, show: source.errorCount > 0)
                                badge("\(source.warningCount) warnings", tint: .orange, show: source.warningCount > 0)
                                badge("\(source.lines.count) rows", tint: .grokMuted, show: true)
                                if source.wasCapped {
                                    badge("+", tint: .yellow, show: true)
                                }
                            }
                        }
                        .padding(10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(selectedSourceID == source.id ? Color.grokElevated : Color.grokSurface)
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                        .overlay {
                            RoundedRectangle(cornerRadius: 10, style: .continuous)
                                .stroke(selectedSourceID == source.id ? Color.grokAccent : Color.grokBorder)
                        }
                    }
                    .buttonStyle(.plain)
                }
            }
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

    // MARK: - Timeline mode picker

    private var timelineModePicker: some View {
        Picker("View", selection: $timelineMode) {
            ForEach(LogTimelineMode.allCases, id: \.self) { mode in
                Text(mode.label).tag(mode)
            }
        }
        .pickerStyle(.segmented)
        .frame(maxWidth: 220)
    }

    // MARK: - Detail section

    private var detailSection: some View {
        Group {
            switch timelineMode {
            case .sources:
                selectedLogDetail
            case .unified:
                unifiedTimelineView
            }
        }
    }

    // MARK: - Unified timeline

    private var unifiedTimelineView: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "timeline.selection")
                    .foregroundColor(.grokAccent)
                Text("Correlated timeline")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundColor(.grokText)
                Spacer()
                Text("\(visibleSources.count) sources | \(unifiedLines.count) rows")
                    .font(.system(size: 11))
                    .foregroundColor(.grokDim)
                Toggle("Dedup", isOn: $deduplicate)
                    .toggleStyle(.switch)
                    .font(.system(size: 11))
                    .foregroundColor(.grokMuted)
                    .frame(width: 80)
                Button("Copy") {
                    copyUnifiedLines()
                }
                .buttonStyle(.borderless)
                .font(.system(size: 11))
                Button("Export") {
                    exportUnifiedLines()
                }
                .buttonStyle(.borderless)
                .font(.system(size: 11))
            }
            if let lastExportPath {
                HStack(spacing: 5) {
                    Image(systemName: "arrow.down.circle")
                        .font(.system(size: 10))
                        .foregroundColor(.green)
                    Text("Exported to \(lastExportPath)")
                        .font(.system(size: 10))
                        .foregroundColor(.green.opacity(0.9))
                        .lineLimit(1)
                }
            }
            unifiedLogLinesView
        }
        .padding(12)
        .background(Color.grokSurface)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(Color.grokBorder)
        }
    }

    private var unifiedLines: [ParsedLogLine] {
        LogParser.unifiedLines(
            sources: visibleSources,
            minLevel: minLevel,
            searchText: searchText,
            deduplicate: deduplicate,
            suppressNoise: suppressNoise,
            profile: noiseProfile,
            maxRows: maxLinesPerSource
        )
    }

    private var unifiedLogLinesView: some View {
        let lines = unifiedLines
        return ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 2) {
                    ForEach(lines) { line in
                        unifiedLogRow(line)
                    }
                    Color.clear
                        .frame(height: 1)
                        .id("log-bottom")
                }
                .padding(8)
                .background(Color.black.opacity(0.18))
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                .onChange(of: liveTick) { _, _ in
                    withAnimation(nil) {
                        proxy.scrollTo("log-bottom", anchor: .bottom)
                    }
                }
            }
            .simultaneousGesture(
                DragGesture(minimumDistance: 5)
                    .onChanged { _ in
                        if isLive && !isFollowPaused {
                            isFollowPaused = true
                        }
                    }
            )
            .overlay(alignment: .bottomTrailing) {
                if isLive && isFollowPaused {
                    Button(action: resumeLiveFollow) {
                        HStack(spacing: 4) {
                            Image(systemName: "arrow.down.circle")
                                .font(.system(size: 10))
                            Text("Resume live")
                                .font(.system(size: 11, weight: .semibold))
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(Color.grokAccent)
                        .foregroundColor(.white)
                        .clipShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .padding(12)
                }
            }
            .frame(minHeight: 240, maxHeight: 520)
        }
    }

    private func unifiedLogRow(_ line: ParsedLogLine) -> some View {
        let source = sources.first { $0.id == line.sourceID }
        let sourceTint = source.map { tintColor($0.tintName) } ?? .grokMuted
        return HStack(alignment: .top, spacing: 6) {
            HStack(spacing: 2) {
                Image(systemName: source?.icon ?? "doc.text")
                    .font(.system(size: 8))
                    .foregroundColor(sourceTint)
                Text(source?.displayName ?? line.sourceID)
                    .font(.system(size: 8, weight: .semibold))
                    .foregroundColor(sourceTint)
                    .lineLimit(1)
            }
            .padding(.horizontal, 4)
            .padding(.vertical, 1)
            .background(sourceTint.opacity(0.12))
            .clipShape(Capsule())

            Image(systemName: line.level.icon)
                .font(.system(size: 9))
                .foregroundColor(line.level.color)
                .frame(width: 14)
            if let timestamp = line.timestamp {
                Text(timestamp)
                    .font(.system(size: 9, design: .monospaced))
                    .foregroundColor(.grokDim)
                    .frame(minWidth: 70, alignment: .leading)
            } else {
                Image(systemName: "clock.badge.questionmark")
                    .font(.system(size: 9))
                    .foregroundColor(.grokDim)
                    .frame(width: 14)
            }
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 5) {
                    Text(line.level.label)
                        .font(.system(size: 8, weight: .bold, design: .monospaced))
                        .foregroundColor(line.level.color)
                    if line.isDuplicateGroup {
                        Text("x\(line.duplicateCount)")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundColor(.white)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .background(Color.grokDim)
                            .clipShape(Capsule())
                    }
                    if let event = line.event, !event.isEmpty {
                        Text(event)
                            .font(.system(size: 9, weight: .semibold, design: .monospaced))
                            .foregroundColor(.blue.opacity(0.8))
                    }
                }
                Text(line.message)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundColor(line.level.color)
                    .textSelection(.enabled)
                    .lineLimit(line.isDuplicateGroup ? 2 : 4)
                if let details = line.details, !details.isEmpty, !line.isDuplicateGroup {
                    Text(details)
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundColor(.grokMuted)
                        .lineLimit(2)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 2)
        .id(line.id)
        .contentShape(Rectangle())
        .onTapGesture {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(line.rawLine, forType: .string)
        }
        .contextMenu {
            logRowContextMenu(line: line, source: source)
        }
    }

    private func copyUnifiedLines() {
        let text = unifiedLines.map { $0.rawLine }.joined(separator: "\n")
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }

    private func exportUnifiedLines() {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone.current
        let timestamp = formatter.string(from: Date())
        let filename = "trios-logs-unified-\(timestamp).log"

        let directories: [URL] = [
            FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first,
            FileManager.default.temporaryDirectory,
            URL(fileURLWithPath: ProjectPaths.trinity)
        ].compactMap { $0 }

        let targetURL: URL = {
            for dir in directories {
                var isDir: ObjCBool = false
                let exists = FileManager.default.fileExists(atPath: dir.path, isDirectory: &isDir)
                if exists && isDir.boolValue {
                    return dir.appendingPathComponent(filename)
                }
            }
            return FileManager.default.temporaryDirectory.appendingPathComponent(filename)
        }()

        let lines = unifiedLines
        if LogParser.exportLines(lines, to: targetURL.path) {
            lastExportPath = targetURL.path
        }
    }

    // MARK: - Filter bar

    private var queryChips: some View {
        let tokens = LogParser.parseQuery(searchText)
        let structured = tokens.filter {
            if case .text = $0 { return false }
            return true
        }
        return Group {
            if !structured.isEmpty {
                HStack(spacing: 6) {
                    ForEach(0..<structured.count, id: \.self) { index in
                        let token = structured[index]
                        Text(queryTokenLabel(token))
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundColor(.grokText)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 3)
                            .background(Color.grokAccent.opacity(0.15))
                            .clipShape(Capsule())
                            .overlay {
                                Capsule()
                                    .stroke(Color.grokAccent.opacity(0.4))
                            }
                    }
                    Spacer()
                }
                .padding(.top, -6)
            }
        }
    }

    private func queryTokenLabel(_ token: LogQueryToken) -> String {
        switch token {
        case .level(let level): return "level:\(level.label.lowercased())+"
        case .source(let value): return "source:\(value)"
        case .event(let value): return "event:\(value)"
        case .text(let value): return "\"\(value)\""
        }
    }

    private var quickFiltersBar: some View {
        HStack(spacing: 8) {
            Text("Quick filters")
                .font(.system(size: 11, weight: .medium))
                .foregroundColor(.grokMuted)

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(savedSearches) { search in
                        let isActive = searchText == search.query
                        Button {
                            applySavedSearch(search)
                        } label: {
                            Text(search.label)
                                .font(.system(size: 10, weight: .semibold))
                                .foregroundColor(isActive ? Color.black : .grokText)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 4)
                                .background(isActive ? Color.grokAccent : Color.grokSurface)
                                .clipShape(Capsule())
                                .overlay {
                                    Capsule()
                                        .stroke(isActive ? Color.clear : Color.grokBorder)
                                }
                        }
                        .buttonStyle(.plain)
                        .contextMenu {
                            Button("Delete") {
                                deleteSavedSearch(search)
                            }
                        }
                    }

                    Button {
                        newSearchLabel = ""
                        showingSaveSearchAlert = true
                    } label: {
                        HStack(spacing: 2) {
                            Image(systemName: "plus")
                                .font(.system(size: 9, weight: .bold))
                            Text("Save")
                                .font(.system(size: 10, weight: .semibold))
                        }
                        .foregroundColor(.grokText)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(Color.grokSurface)
                        .clipShape(Capsule())
                        .overlay {
                            Capsule()
                                .stroke(Color.grokBorder)
                        }
                    }
                    .buttonStyle(.plain)
                    .disabled(searchText.isEmpty)

                    Button {
                        resetSavedSearches()
                    } label: {
                        Text("Reset")
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundColor(.grokMuted)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private var recentSearchesBar: some View {
        Group {
            if !recentSearches.isEmpty {
                HStack(spacing: 8) {
                    Text("Recent")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundColor(.grokMuted)

                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 6) {
                            ForEach(recentSearches) { recent in
                                let isActive = searchText == recent.query
                                Button {
                                    searchText = recent.query
                                } label: {
                                    HStack(spacing: 3) {
                                        Image(systemName: "clock")
                                            .font(.system(size: 9))
                                        Text(recent.query)
                                            .font(.system(size: 10, weight: .semibold))
                                            .lineLimit(1)
                                    }
                                    .foregroundColor(isActive ? Color.black : .grokText)
                                    .padding(.horizontal, 8)
                                    .padding(.vertical, 4)
                                    .frame(maxWidth: 180)
                                    .background(isActive ? Color.grokAccent : Color.grokSurface)
                                    .clipShape(Capsule())
                                    .overlay {
                                        Capsule()
                                            .stroke(isActive ? Color.clear : Color.grokBorder)
                                    }
                                }
                                .buttonStyle(.plain)
                                .contextMenu {
                                    Button("Apply") {
                                        searchText = recent.query
                                    }
                                    Button("Remove from history") {
                                        removeRecentSearch(recent)
                                    }
                                    Button("Save to quick filters") {
                                        saveRecentSearchToQuickFilters(recent)
                                    }
                                }
                            }

                            Button {
                                showingClearHistoryAlert = true
                            } label: {
                                Text("Clear")
                                    .font(.system(size: 10, weight: .semibold))
                                    .foregroundColor(.grokMuted)
                                    .padding(.horizontal, 8)
                                    .padding(.vertical, 4)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
        }
    }

    private var filterBar: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                HStack(spacing: 5) {
                    Image(systemName: "magnifyingglass")
                        .font(.system(size: 11))
                        .foregroundColor(.grokDim)
                    TextField("Search messages, events, details", text: $searchText)
                        .font(.system(size: 12))
                        .textFieldStyle(.plain)
                        .foregroundColor(.grokText)
                        .onSubmit {
                            Task {
                                await LogRecentSearchStore().record(query: searchText)
                                loadRecentSearches()
                            }
                        }
                    if !searchText.isEmpty {
                        Button {
                            searchText = ""
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .font(.system(size: 11))
                                .foregroundColor(.grokDim)
                        }
                        .buttonStyle(.borderless)
                    }
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 5)
                .background(Color.grokSurface)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .stroke(Color.grokBorder)
                }

                HStack(spacing: 4) {
                    ForEach(LogLevel.allCases.filter { $0.rawValue >= LogLevel.info.rawValue }, id: \.self) { level in
                        levelChip(level)
                    }
                }

                Toggle("Dedup", isOn: $deduplicate)
                    .toggleStyle(.switch)
                    .font(.system(size: 11))
                    .foregroundColor(.grokMuted)
                    .frame(width: 80)

                Toggle("Quiet", isOn: $suppressNoise)
                    .toggleStyle(.switch)
                    .font(.system(size: 11))
                    .foregroundColor(.grokMuted)
                    .frame(width: 80)

                Button {
                    pendingRulePreview = nil
                    rulePreviewCount = 0
                    showingNoiseProfileSheet = true
                } label: {
                    HStack(spacing: 3) {
                        Image(systemName: "speaker.slash.fill")
                            .font(.system(size: 9))
                        Text("Rules")
                            .font(.system(size: 11, weight: .semibold))
                    }
                    .foregroundColor(.grokText)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(Color.grokSurface)
                    .clipShape(Capsule())
                    .overlay {
                        Capsule()
                            .stroke(Color.grokBorder)
                    }
                }
                .buttonStyle(.plain)
            }
            queryChips
        }
    }

    private func levelChip(_ level: LogLevel) -> some View {
        let isSelected = minLevel == level
        return Button {
            minLevel = level
        } label: {
            Text(level.label)
                .font(.system(size: 10, weight: .semibold))
                .foregroundColor(isSelected ? Color.black : level.color)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(isSelected ? level.color : level.color.opacity(0.12))
                .clipShape(Capsule())
        }
        .buttonStyle(.plain)
    }

    // MARK: - Selected log detail

    private var selectedLogDetail: some View {
        Group {
            if let source = visibleSources.first(where: { $0.id == selectedSourceID }) {
                let tint = tintColor(source.tintName)
                VStack(alignment: .leading, spacing: 10) {
                    HStack(spacing: 8) {
                        Image(systemName: source.icon)
                            .foregroundColor(tint)
                        Text(source.displayName)
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundColor(.grokText)
                        Spacer()
                        let rowBase = deduplicate ? source.lines.count : source.rawLines.count
                        Text("\(filteredLines(for: source).count) / \(rowBase) rows")
                            .font(.system(size: 11))
                            .foregroundColor(.grokDim)
                        Button("Jump to latest") {
                            resumeLiveFollow()
                        }
                        .buttonStyle(.borderless)
                        .font(.system(size: 11))
                        Button("Copy") {
                            copyFilteredLines(source)
                        }
                        .buttonStyle(.borderless)
                        .font(.system(size: 11))
                        Button("Export") {
                            exportFilteredLines(source)
                        }
                        .buttonStyle(.borderless)
                        .font(.system(size: 11))
                    }
                    if source.wasCapped {
                        HStack(spacing: 5) {
                            Image(systemName: "ellipsis")
                                .font(.system(size: 10))
                                .foregroundColor(.yellow)
                            Text("Showing last \(maxLinesPerSource) of \(source.originalLineCount) lines. Older lines are available in the file.")
                                .font(.system(size: 10))
                                .foregroundColor(.yellow.opacity(0.9))
                        }
                    }
                    if let lastExportPath {
                        HStack(spacing: 5) {
                            Image(systemName: "arrow.down.circle")
                                .font(.system(size: 10))
                                .foregroundColor(.green)
                            Text("Exported to \(lastExportPath)")
                                .font(.system(size: 10))
                                .foregroundColor(.green.opacity(0.9))
                                .lineLimit(1)
                        }
                    }
                    logLinesView(source: source)
                }
                .padding(12)
                .background(Color.grokSurface)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .stroke(Color.grokBorder)
                }
            } else {
                Text("Select a log source to view its entries.")
                    .font(.system(size: 12))
                    .foregroundColor(.grokMuted)
                    .padding(.top, 20)
            }
        }
    }

    private func logLinesView(source: LogSource) -> some View {
        let lines = filteredLines(for: source)
        return ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 2) {
                    ForEach(lines) { line in
                        logRow(line)
                    }
                    Color.clear
                        .frame(height: 1)
                        .id("log-bottom")
                }
                .padding(8)
                .background(Color.black.opacity(0.18))
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                .onChange(of: liveTick) { _, _ in
                    withAnimation(nil) {
                        proxy.scrollTo("log-bottom", anchor: .bottom)
                    }
                }
            }
            .simultaneousGesture(
                DragGesture(minimumDistance: 5)
                    .onChanged { _ in
                        if isLive && !isFollowPaused {
                            isFollowPaused = true
                        }
                    }
            )
            .overlay(alignment: .bottomTrailing) {
                if isLive && isFollowPaused {
                    Button(action: resumeLiveFollow) {
                        HStack(spacing: 4) {
                            Image(systemName: "arrow.down.circle")
                                .font(.system(size: 10))
                            Text("Resume live")
                                .font(.system(size: 11, weight: .semibold))
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(Color.grokAccent)
                        .foregroundColor(.white)
                        .clipShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .padding(12)
                }
            }
            .frame(minHeight: 240, maxHeight: 520)
        }
    }

    private func logRow(_ line: ParsedLogLine) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Image(systemName: line.level.icon)
                .font(.system(size: 9))
                .foregroundColor(line.level.color)
                .frame(width: 14)
            if let timestamp = line.timestamp {
                Text(timestamp)
                    .font(.system(size: 9, design: .monospaced))
                    .foregroundColor(.grokDim)
                    .frame(minWidth: 70, alignment: .leading)
            }
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 5) {
                    Text(line.level.label)
                        .font(.system(size: 8, weight: .bold, design: .monospaced))
                        .foregroundColor(line.level.color)
                    if line.isDuplicateGroup {
                        Text("x\(line.duplicateCount)")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundColor(.white)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .background(Color.grokDim)
                            .clipShape(Capsule())
                    }
                    if let event = line.event, !event.isEmpty {
                        Text(event)
                            .font(.system(size: 9, weight: .semibold, design: .monospaced))
                            .foregroundColor(.blue.opacity(0.8))
                    }
                }
                Text(line.message)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundColor(line.level.color)
                    .textSelection(.enabled)
                    .lineLimit(line.isDuplicateGroup ? 2 : 4)
                if let details = line.details, !details.isEmpty, !line.isDuplicateGroup {
                    Text(details)
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundColor(.grokMuted)
                        .lineLimit(2)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 2)
        .id(line.id)
        .contentShape(Rectangle())
        .contextMenu {
            logRowContextMenu(line: line, source: nil)
        }
    }

    // MARK: - Context menu

    private func logRowContextMenu(line: ParsedLogLine, source: LogSource?) -> some View {
        Group {
            Button {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(line.rawLine, forType: .string)
            } label: {
                Label("Copy raw line", systemImage: "doc.on.doc")
            }
            Button {
                if let rule = LogNoisePatternProposer.propose(from: line, sourceID: line.sourceID) {
                    pendingRulePreview = rule
                    rulePreviewCount = countLinesMatching(rule)
                    showingNoiseProfileSheet = true
                }
            } label: {
                Label("Hide events like this", systemImage: "eye.slash")
            }
            .disabled(LogNoisePatternProposer.propose(from: line, sourceID: line.sourceID) == nil)
        }
    }

    private func countLinesMatching(_ rule: LogNoiseRule) -> Int {
        let filter = LogNoiseFilter(profile: LogNoiseProfile(customRules: [rule]))
        let allLines = sources.flatMap { $0.rawLines }
        return allLines.filter { filter.isNoise($0) }.count
    }

    private func loadNoiseProfile() {
        Task {
            let loaded = await noiseProfileStore.load()
            await MainActor.run {
                noiseProfile = loaded
            }
        }
    }

    private func filteredLines(for source: LogSource) -> [ParsedLogLine] {
        let base = deduplicate ? source.lines : source.rawLines
        let levelFiltered = base.filter { $0.level.rawValue >= minLevel.rawValue }
        let noiseFiltered = LogParser.filterNoise(levelFiltered, isOn: suppressNoise, profile: noiseProfile)
        guard !searchText.isEmpty else { return noiseFiltered }
        let tokens = LogParser.parseQuery(searchText)
        return noiseFiltered.filter { LogParser.matchesQuery($0, tokens: tokens, source: source) }
    }

    private func copyFilteredLines(_ source: LogSource) {
        let text = filteredLines(for: source).map { $0.rawLine }.joined(separator: "\n")
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }

    private func exportFilteredLines(_ source: LogSource) {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone.current
        let timestamp = formatter.string(from: Date())
        let filename = "trios-logs-\(source.id)-\(timestamp).log"

        let directories: [URL] = [
            FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first,
            FileManager.default.temporaryDirectory,
            URL(fileURLWithPath: ProjectPaths.trinity)
        ].compactMap { $0 }

        let targetURL: URL = {
            for dir in directories {
                var isDir: ObjCBool = false
                let exists = FileManager.default.fileExists(atPath: dir.path, isDirectory: &isDir)
                if exists && isDir.boolValue {
                    return dir.appendingPathComponent(filename)
                }
            }
            return FileManager.default.temporaryDirectory.appendingPathComponent(filename)
        }()

        let lines = filteredLines(for: source)
        if LogParser.exportLines(lines, to: targetURL.path) {
            lastExportPath = targetURL.path
        }
    }

    // MARK: - Loading / live tail

    private func loadSavedSearches() {
        Task {
            let store = LogSavedSearchStore()
            let loaded = await store.load()
            await MainActor.run {
                savedSearches = loaded
            }
        }
    }

    private func applySavedSearch(_ search: LogSavedSearch) {
        if searchText == search.query {
            searchText = ""
        } else {
            searchText = search.query
            Task {
                await LogRecentSearchStore().record(query: search.query)
                loadRecentSearches()
            }
        }
    }

    private func addSavedSearch(label: String) {
        let trimmed = label.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty, !searchText.isEmpty else { return }
        let search = LogSavedSearch(
            id: UUID().uuidString,
            label: trimmed,
            query: searchText
        )
        savedSearches.append(search)
        Task {
            await LogSavedSearchStore().save(savedSearches)
        }
    }

    private func deleteSavedSearch(_ search: LogSavedSearch) {
        savedSearches.removeAll { $0.id == search.id }
        Task {
            await LogSavedSearchStore().save(savedSearches)
        }
    }

    private func resetSavedSearches() {
        savedSearches = LogSavedSearchStore.defaultSavedSearches()
        Task {
            await LogSavedSearchStore().save(savedSearches)
        }
    }

    private func loadRecentSearches() {
        Task {
            let store = LogRecentSearchStore()
            let loaded = await store.load()
            await MainActor.run {
                recentSearches = loaded
            }
        }
    }

    private func scheduleRecordRecentSearch(query: String) {
        recordTask?.cancel()
        let trimmed = query.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return }
        recordTask = Task {
            try? await Task.sleep(nanoseconds: recentSearchRecordDebounce)
            guard !Task.isCancelled else { return }
            await LogRecentSearchStore().record(query: trimmed)
            loadRecentSearches()
        }
    }

    private func removeRecentSearch(_ recent: LogRecentSearch) {
        recentSearches.removeAll { $0.id == recent.id }
        Task {
            await LogRecentSearchStore().remove(id: recent.id)
        }
    }

    private func clearRecentSearches() {
        recentSearches.removeAll()
        Task {
            await LogRecentSearchStore().clear()
        }
    }

    private func saveRecentSearchToQuickFilters(_ recent: LogRecentSearch) {
        let trimmed = recent.query
        guard !trimmed.isEmpty else { return }
        let label = String(trimmed.prefix(30))
        let search = LogSavedSearch(
            id: UUID().uuidString,
            label: label,
            query: trimmed
        )
        savedSearches.append(search)
        Task {
            await LogSavedSearchStore().save(savedSearches)
        }
    }

    private func loadAll() {
        guard !isLoading else { return }
        isLoading = true
        isFollowPaused = false
        DispatchQueue.global(qos: .userInitiated).async {
            let loaded = LogParser.loadLogSources(includeArtifacts: showArtifactLogs, maxLinesPerSource: maxLinesPerSource)
            DispatchQueue.main.async {
                sources = loaded
                if selectedSourceID == nil, let first = sources.first {
                    selectedSourceID = first.id
                }
                lastRefresh = Date()
                isLoading = false
                if LogsTabScrollPolicy.shouldAutoScroll(isLive: isLive, isFollowPaused: isFollowPaused) {
                    liveTick += 1
                }
            }
        }
    }

    private func tickLive() {
        DispatchQueue.global(qos: .userInitiated).async {
            let refreshed = LogParser.incrementalRefresh(sources: sources, maxLinesPerSource: maxLinesPerSource)
            DispatchQueue.main.async {
                sources = refreshed
                if selectedSourceID == nil, let first = sources.first {
                    selectedSourceID = first.id
                }
                if LogsTabScrollPolicy.shouldAutoScroll(isLive: isLive, isFollowPaused: isFollowPaused) {
                    liveTick += 1
                }
            }
        }
    }

    private func resumeLiveFollow() {
        isFollowPaused = false
        liveTick += 1
    }

    private func startLive() {
        stopLive()
        isFollowPaused = false
        liveTask = Task {
            while !Task.isCancelled {
                await MainActor.run { tickLive() }
                try? await Task.sleep(nanoseconds: liveInterval)
            }
        }
    }

    private func stopLive() {
        liveTask?.cancel()
        liveTask = nil
    }

    // MARK: - Derived values

    private var visibleSources: [LogSource] {
        sources.filter { !hiddenSourceIDs.contains($0.id) }
    }

    private var totalErrorsAndFatals: Int {
        sources.reduce(0) { $0 + $1.errorCount }
    }

    private var totalWarnings: Int {
        sources.reduce(0) { $0 + $1.warningCount }
    }

    private var totalCollapsedDuplicates: Int {
        sources.reduce(0) { $0 + $1.totalDuplicates }
    }

    private var cappedSourceCount: Int {
        sources.filter(\.wasCapped).count
    }

    private func timeAgo(_ date: Date) -> String {
        let interval = Date().timeIntervalSince(date)
        if interval < 5 { return "just now" }
        if interval < 60 { return "\(Int(interval))s ago" }
        if interval < 3600 { return "\(Int(interval / 60))m ago" }
        return "\(Int(interval / 3600))h ago"
    }
}

// MARK: - Noise profile sheet

struct NoiseProfileSheet: View {
    @Binding var profile: LogNoiseProfile
    let availableSources: [LogSource]
    let previewCount: Int
    let pendingRule: LogNoiseRule?
    let onSave: (LogNoiseProfile, Bool) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var localRules: [LogNoiseRule] = []
    @State private var importExportStatus: String = ""
    @State private var newLabel = ""
    @State private var newEvent = ""
    @State private var newMessage = ""
    @State private var newRaw = ""
    @State private var suggestions: [LogNoiseSuggestion] = []

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text("Noise rules")
                    .font(.system(size: 16, weight: .bold))
                    .foregroundColor(.grokText)
                Spacer()
                Button("Import") {
                    showImportPanel()
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                Button("Export") {
                    exportRules()
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                Button("Done") {
                    var updated = profile
                    updated.customRules = localRules.filter { $0.isValid }
                    onSave(updated, false)
                    dismiss()
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
            }

            if !importExportStatus.isEmpty {
                Text(importExportStatus)
                    .font(.system(size: 11))
                    .foregroundColor(.grokMuted)
            }

            if let pendingRule {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Image(systemName: "eye.slash")
                            .foregroundColor(.grokAccent)
                        Text("Preview: \"\(pendingRule.label)\"")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundColor(.grokText)
                        Spacer()
                        Text("matches \(previewCount) line\(previewCount == 1 ? "" : "s")")
                            .font(.system(size: 11))
                            .foregroundColor(previewCount > 0 ? .orange : .grokDim)
                    }
                    Text("Event: \(pendingRule.event ?? "-") | Message: \(pendingRule.message ?? "-") | Raw: \(pendingRule.raw ?? "-")")
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundColor(.grokMuted)
                        .lineLimit(2)
                    sourceScopeChips(for: pendingRule.sourceIDs, fontSize: 10)
                    HStack {
                        Spacer()
                        Button {
                            var updated = profile
                            updated.customRules.removeAll { $0.id == pendingRule.id }
                            updated.customRules.insert(pendingRule, at: 0)
                            localRules = updated.customRules
                            onSave(updated, true)
                            dismiss()
                        } label: {
                            Text("Add rule")
                                .font(.system(size: 11, weight: .semibold))
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                        .disabled(!pendingRule.isValid)
                    }
                }
                .padding(10)
                .background(Color.grokSurface)
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .stroke(Color.grokAccent.opacity(0.4))
                }
            }

            suggestionsSection

            Text("Built-in rules are always applied when Quiet is on. Custom rules are saved to \(ProjectPaths.trinity)/state/logs_noise_profile.json.")
                .font(.system(size: 11))
                .foregroundColor(.grokMuted)

            Text("Custom rules")
                .font(.system(size: 13, weight: .semibold))
                .foregroundColor(.grokText)

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 6) {
                    ForEach($localRules) { $rule in
                        ruleEditor(rule: $rule)
                    }
                }
            }
            .frame(maxHeight: 260)

            VStack(alignment: .leading, spacing: 6) {
                Text("Add rule")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(.grokText)
                HStack(spacing: 6) {
                    TextField("Label", text: $newLabel)
                        .textFieldStyle(.roundedBorder)
                        .frame(width: 120)
                    TextField("Event", text: $newEvent)
                        .textFieldStyle(.roundedBorder)
                        .frame(width: 100)
                    TextField("Message", text: $newMessage)
                        .textFieldStyle(.roundedBorder)
                        .frame(minWidth: 100)
                    TextField("Raw", text: $newRaw)
                        .textFieldStyle(.roundedBorder)
                        .frame(minWidth: 100)
                    Button {
                        let rule = LogNoiseRule(
                            label: newLabel.isEmpty ? "Custom rule" : newLabel,
                            event: newEvent.isEmpty ? nil : newEvent,
                            message: newMessage.isEmpty ? nil : newMessage,
                            raw: newRaw.isEmpty ? nil : newRaw,
                            enabled: true
                        )
                        guard rule.isValid else { return }
                        localRules.insert(rule, at: 0)
                        newLabel = ""
                        newEvent = ""
                        newMessage = ""
                        newRaw = ""
                    } label: {
                        Image(systemName: "plus")
                    }
                    .disabled(newEvent.isEmpty && newMessage.isEmpty && newRaw.isEmpty)
                }
            }
            .padding(10)
            .background(Color.grokSurface)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(Color.grokBorder)
            }
        }
        .padding(16)
        .frame(minWidth: 520, idealWidth: 620, maxWidth: .infinity)
        .background(Color.grokBackground.ignoresSafeArea())
        .onAppear {
            localRules = profile.customRules
            recomputeSuggestions()
        }
        .onChange(of: localRules) { _, _ in
            recomputeSuggestions()
        }
    }

    private func recomputeSuggestions() {
        let currentProfile = LogNoiseProfile(customRules: localRules)
        suggestions = LogNoiseSuggester.suggest(
            from: availableSources,
            profile: currentProfile,
            minOccurrences: 5,
            topN: 10
        )
    }

    private func applySuggestion(_ suggestion: LogNoiseSuggestion) {
        localRules.insert(suggestion.rule, at: 0)
        var updated = profile
        updated.customRules = localRules.filter { $0.isValid }
        onSave(updated, true)
        suggestions.removeAll { $0.id == suggestion.id }
    }

    private var suggestionsSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Suggested rules")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(.grokText)
                Spacer()
                if suggestions.isEmpty {
                    Text("No repetitive patterns detected in current logs.")
                        .font(.system(size: 11))
                        .foregroundColor(.grokMuted)
                }
            }

            if !suggestions.isEmpty {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 6) {
                        ForEach(suggestions) { suggestion in
                            suggestionRow(suggestion)
                        }
                    }
                }
                .frame(maxHeight: 160)
            }
        }
    }

    private func suggestionRow(_ suggestion: LogNoiseSuggestion) -> some View {
        HStack(spacing: 8) {
            let sourceName = availableSources.first { $0.id == suggestion.sourceID }?.displayName ?? suggestion.sourceID
            Text(sourceName)
                .font(.system(size: 10, weight: .semibold))
                .foregroundColor(.grokText)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(Color.grokAccent.opacity(0.15))
                .clipShape(Capsule())
                .overlay {
                    Capsule()
                        .stroke(Color.grokAccent.opacity(0.4))
                }

            Text(suggestion.rule.label)
                .font(.system(size: 11, design: .monospaced))
                .foregroundColor(.grokText)
                .lineLimit(1)

            Spacer()

            Text("Suppresses \(suggestion.matchedCount) line\(suggestion.matchedCount == 1 ? "" : "s")")
                .font(.system(size: 10))
                .foregroundColor(.grokMuted)

            Button("Add") {
                applySuggestion(suggestion)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.small)
            .font(.system(size: 11, weight: .semibold))
        }
        .padding(8)
        .background(Color.grokSurface)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(Color.grokBorder)
        }
    }

    private func ruleEditor(rule: Binding<LogNoiseRule>) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Toggle("", isOn: rule.enabled)
                    .toggleStyle(.switch)
                    .frame(width: 40)
                TextField("Label", text: rule.label)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 120)
                TextField("Event", text: Binding(
                    get: { rule.event.wrappedValue ?? "" },
                    set: { rule.event.wrappedValue = $0.isEmpty ? nil : $0 }
                ))
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 100)
                TextField("Message", text: Binding(
                    get: { rule.message.wrappedValue ?? "" },
                    set: { rule.message.wrappedValue = $0.isEmpty ? nil : $0 }
                ))
                    .textFieldStyle(.roundedBorder)
                    .frame(minWidth: 100)
                TextField("Raw", text: Binding(
                    get: { rule.raw.wrappedValue ?? "" },
                    set: { rule.raw.wrappedValue = $0.isEmpty ? nil : $0 }
                ))
                    .textFieldStyle(.roundedBorder)
                    .frame(minWidth: 100)
                Button {
                    localRules.removeAll { $0.id == rule.id }
                } label: {
                    Image(systemName: "trash")
                        .foregroundColor(.red)
                }
                .buttonStyle(.borderless)
            }
            HStack(spacing: 6) {
                sourceScopeChips(for: rule.sourceIDs.wrappedValue, fontSize: 10)
                sourceScopeMenu(rule: rule)
                Spacer(minLength: 0)
            }
        }
        .padding(8)
        .background(Color.grokSurface)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(Color.grokBorder)
        }
    }

    /// Renders the scope of a rule as chips.
    @ViewBuilder
    private func sourceScopeChips(for sourceIDs: [String]?, fontSize: CGFloat) -> some View {
        if let ids = sourceIDs, !ids.isEmpty {
            ForEach(ids, id: \.self) { id in
                let sourceName = availableSources.first { $0.id == id }?.displayName ?? id
                Text(sourceName)
                    .font(.system(size: fontSize, weight: .semibold))
                    .foregroundColor(.grokText)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Color.grokAccent.opacity(0.15))
                    .clipShape(Capsule())
                    .overlay {
                        Capsule()
                            .stroke(Color.grokAccent.opacity(0.4))
                    }
            }
        } else {
            Text("All sources")
                .font(.system(size: fontSize, weight: .semibold))
                .foregroundColor(.grokMuted)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(Color.grokSurface)
                .clipShape(Capsule())
                .overlay {
                    Capsule()
                        .stroke(Color.grokBorder)
                }
        }
    }

    /// Menu to toggle a rule's source scope between global and selected sources.
    private func sourceScopeMenu(rule: Binding<LogNoiseRule>) -> some View {
        let selected = Set(rule.sourceIDs.wrappedValue ?? [])
        return Menu {
            Button {
                rule.sourceIDs.wrappedValue = nil
            } label: {
                Label("All sources", systemImage: selected.isEmpty ? "checkmark" : "")
            }
            Divider()
            ForEach(availableSources) { source in
                Button {
                    var current = rule.sourceIDs.wrappedValue ?? []
                    if current.contains(source.id) {
                        current.removeAll { $0 == source.id }
                    } else {
                        current.append(source.id)
                    }
                    rule.sourceIDs.wrappedValue = current.isEmpty ? nil : current
                } label: {
                    Label(source.displayName, systemImage: selected.contains(source.id) ? "checkmark" : "")
                }
            }
        } label: {
            Image(systemName: "ellipsis.circle")
                .font(.system(size: 12))
                .foregroundColor(.grokMuted)
        }
        .menuStyle(.borderlessButton)
        .frame(width: 24)
    }
    private func exportRules() {
        let validRules = localRules.filter { $0.isValid }
        Task {
            guard let url = await LogNoiseProfileStore().exportRules(validRules) else {
                await MainActor.run {
                    importExportStatus = "Export failed."
                }
                return
            }
            await MainActor.run {
                importExportStatus = "Exported to \(url.lastPathComponent)"
            }
        }
    }

    private func showImportPanel() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.json]
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.begin { result in
            guard result == .OK, let url = panel.url else { return }
            Task {
                let importResult = await LogNoiseProfileStore().importRules(from: url)
                await MainActor.run {
                    if importResult.skippedUnsupportedSchema {
                        importExportStatus = "Unsupported profile version."
                        return
                    }
                    var merged = localRules
                    for rule in importResult.imported {
                        merged.removeAll { $0.id == rule.id }
                    }
                    merged.insert(contentsOf: importResult.imported, at: 0)
                    localRules = merged
                    var updated = profile
                    updated.customRules = localRules.filter { $0.isValid }
                    onSave(updated, false)
                    importExportStatus = "Imported \(importResult.imported.count) rules, skipped \(importResult.skippedInvalid) invalid."
                }
            }
        }
    }

}

// MARK: - Flow layout for source chips

struct LogsFlowLayout: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let result = FlowResult(in: proposal.width ?? 0, subviews: subviews, spacing: spacing)
        return result.size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let result = FlowResult(in: bounds.width, subviews: subviews, spacing: spacing)
        for (index, subview) in subviews.enumerated() {
            subview.place(at: CGPoint(x: bounds.minX + result.positions[index].x, y: bounds.minY + result.positions[index].y), proposal: .unspecified)
        }
    }

    struct FlowResult {
        var size: CGSize = .zero
        var positions: [CGPoint] = []

        init(in maxWidth: CGFloat, subviews: Subviews, spacing: CGFloat) {
            var x: CGFloat = 0
            var y: CGFloat = 0
            var lineHeight: CGFloat = 0
            for subview in subviews {
                let size = subview.sizeThatFits(.unspecified)
                if x + size.width > maxWidth && x > 0 {
                    x = 0
                    y += lineHeight + spacing
                    lineHeight = 0
                }
                positions.append(CGPoint(x: x, y: y))
                x += size.width + spacing
                lineHeight = max(lineHeight, size.height)
            }
            self.size = CGSize(width: maxWidth, height: y + lineHeight)
        }
    }
}
