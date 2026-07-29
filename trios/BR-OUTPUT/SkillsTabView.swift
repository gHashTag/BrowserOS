import SwiftUI

/// Where the Queen's skills are managed.
///
/// The repository carries two dozen `SKILL.md` files and, until now, the Queen
/// could invoke exactly four of them because those four names were hardcoded in
/// Swift. This tab makes the files the source of truth and gives each one a
/// switch, so "what can she actually do" is a question with a visible answer.
struct SkillsTabView: View {
    @ObservedObject private var store = SkillStore.shared
    @State private var query = ""
    @State private var selectedID: String?
    @State private var runOutput: String?
    @State private var sourceFilter: SkillSource?
    @State private var isEditing = false
    @State private var draft = ""
    @State private var saveError: String?

    var body: some View {
        HSplitView {
            list
                .frame(minWidth: 300, idealWidth: 360)
            detail
                .frame(minWidth: 320, maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(Color.grokBackground)
    }

    // MARK: - List

    private var visibleSkills: [SkillDescriptor] {
        store.skills.filter { skill in
            let matchesSource = sourceFilter == nil || skill.source == sourceFilter
            guard matchesSource else { return false }
            guard !query.isEmpty else { return true }
            let needle = query.lowercased()
            return skill.name.lowercased().contains(needle)
                || skill.description.lowercased().contains(needle)
        }
    }

    private var list: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider().overlay(Color.grokBorder.opacity(0.6))
            if visibleSkills.isEmpty {
                emptyState
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(visibleSkills) { skill in
                            row(skill)
                            Divider().overlay(Color.grokBorder.opacity(0.25))
                        }
                    }
                }
            }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text("SKILLS")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(.grokMuted)
                    .tracking(1.1)
                Text("\(store.enabled.count) of \(store.skills.count) available to the Queen")
                    .font(.system(size: 10))
                    .foregroundColor(.grokDim)
                Spacer()
                Button {
                    store.reload()
                } label: {
                    Image(systemName: "arrow.clockwise")
                        .font(.system(size: 11))
                        .foregroundColor(.grokMuted)
                }
                .buttonStyle(.plain)
                .help("Re-read SKILL.md files from disk")
            }

            TextField("Search skills", text: $query)
                .textFieldStyle(.plain)
                .font(.system(size: 12))
                .padding(.horizontal, 8)
                .padding(.vertical, 5)
                .background(Color.grokElevated.opacity(0.4))
                .cornerRadius(6)

            HStack(spacing: 6) {
                sourceChip(nil, label: "All")
                ForEach(SkillSource.allCases, id: \.self) { source in
                    sourceChip(source, label: source.displayName)
                }
                Spacer()
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
    }

    private func sourceChip(_ source: SkillSource?, label: String) -> some View {
        let isSelected = sourceFilter == source
        return Button {
            sourceFilter = source
        } label: {
            Text(label)
                .font(.system(size: 10, weight: isSelected ? .semibold : .regular))
                .foregroundColor(isSelected ? .grokText : .grokMuted)
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background((isSelected ? Color.grokAccent : Color.grokElevated).opacity(isSelected ? 0.25 : 0.35))
                .clipShape(Capsule())
        }
        .buttonStyle(.plain)
    }

    private var emptyState: some View {
        VStack(spacing: 6) {
            Spacer()
            Image(systemName: "wand.and.stars")
                .font(.system(size: 22))
                .foregroundColor(.grokDim)
            Text(query.isEmpty ? "No SKILL.md files found." : "Nothing matches \"\(query)\".")
                .font(.system(size: 12))
                .foregroundColor(.grokMuted)
            Text("Skills live in .claude/skills/<name>/SKILL.md")
                .font(.system(size: 10))
                .foregroundColor(.grokDim)
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func row(_ skill: SkillDescriptor) -> some View {
        let isEnabled = store.isEnabled(skill)
        return Button {
            selectedID = skill.id
            runOutput = store.lastRuns[skill.id]?.output
            isEditing = false
            saveError = nil
        } label: {
            HStack(alignment: .top, spacing: 8) {
                Toggle("", isOn: Binding(
                    get: { isEnabled },
                    set: { store.setEnabled($0, for: skill) }
                ))
                .labelsHidden()
                .toggleStyle(.switch)
                .controlSize(.mini)

                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(skill.id)
                            .font(.system(size: 12, weight: .medium, design: .monospaced))
                            .foregroundColor(isEnabled ? .grokText : .grokDim)
                        if store.runningIDs.contains(skill.id) {
                            ProgressView().controlSize(.mini)
                        }
                        Spacer(minLength: 4)
                        Text(skill.source.displayName)
                            .font(.system(size: 9))
                            .foregroundColor(.grokDim)
                    }
                    Text(skill.description)
                        .font(.system(size: 10))
                        .foregroundColor(.grokMuted)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(selectedID == skill.id ? Color.grokElevated.opacity(0.35) : .clear)
            .opacity(isEnabled ? 1 : 0.55)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // MARK: - Detail

    @ViewBuilder
    private var detail: some View {
        if let id = selectedID, let skill = store.skills.first(where: { $0.id == id }) {
            VStack(alignment: .leading, spacing: 10) {
                detailHeader(skill)
                Divider().overlay(Color.grokBorder.opacity(0.5))
                if isEditing {
                    editor(skill)
                } else {
                    ScrollView {
                        Text(runOutput ?? "No output yet. Run it to see what it does.")
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundColor(runOutput == nil ? .grokDim : .grokText)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(12)
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        } else {
            VStack(spacing: 6) {
                Image(systemName: "sparkles")
                    .font(.system(size: 22))
                    .foregroundColor(.grokDim)
                Text("Pick a skill to read it or run it.")
                    .font(.system(size: 12))
                    .foregroundColor(.grokMuted)
                Text("Switching one off removes it from the Queen's vocabulary.")
                    .font(.system(size: 10))
                    .foregroundColor(.grokDim)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func detailHeader(_ skill: SkillDescriptor) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text(skill.id)
                    .font(.system(size: 14, weight: .semibold, design: .monospaced))
                    .foregroundColor(.grokText)
                Spacer()
                Button {
                    NSWorkspace.shared.selectFile(skill.path, inFileViewerRootedAtPath: "")
                } label: {
                    Text("Reveal")
                        .font(.system(size: 10, weight: .medium))
                        .foregroundColor(.grokMuted)
                }
                .buttonStyle(.plain)
                .help(skill.path)

                Button {
                    if isEditing {
                        isEditing = false
                        saveError = nil
                    } else {
                        draft = store.body(of: skill) ?? ""
                        isEditing = true
                    }
                } label: {
                    Text(isEditing ? "Cancel" : "Edit")
                        .font(.system(size: 10, weight: .medium))
                        .foregroundColor(.grokMuted)
                }
                .buttonStyle(.plain)

                if isEditing {
                    Button {
                        saveError = store.save(skill, body: draft)
                        if saveError == nil { isEditing = false }
                    } label: {
                        Text("Save")
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundColor(.green)
                    }
                    .buttonStyle(.plain)
                } else {
                    Button {
                        Task {
                            runOutput = "Running \(skill.id)..."
                            runOutput = await store.run(skill.id)
                        }
                    } label: {
                        Text("Run")
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundColor(store.isEnabled(skill) ? .green : .grokDim)
                    }
                    .buttonStyle(.plain)
                    .disabled(!store.isEnabled(skill) || store.runningIDs.contains(skill.id))
                }
            }

            Text(skill.description)
                .font(.system(size: 11))
                .foregroundColor(.grokMuted)
                .textSelection(.enabled)

            HStack(spacing: 12) {
                metric("source", skill.source.displayName)
                // A skill's body is loaded into the agent's context when it runs,
                // so its size is a cost the user should be able to see.
                metric("size", "\(skill.bodyCharacters / 1000)k chars")
                if isEditing {
                    // The body is loaded into the agent's context when the skill
                    // runs, so its size is a cost worth watching while editing
                    // rather than discovering afterwards.
                    metric("draft", "\(draft.count / 1000)k chars")
                }
                if let record = store.lastRuns[skill.id] {
                    metric(
                        "last run",
                        record.succeeded ? "produced output" : "produced nothing"
                    )
                }
                Spacer()
            }
        }
        .padding(.horizontal, 14)
        .padding(.top, 12)
    }

    /// Plain text editing of the SKILL.md itself.
    ///
    /// No markdown preview and no form over the frontmatter: the file is the
    /// contract with the Claude CLI, and any editor that hides part of it will
    /// eventually write something the CLI reads differently to what was shown.
    private func editor(_ skill: SkillDescriptor) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if let saveError {
                Text(saveError)
                    .font(.system(size: 11))
                    .foregroundColor(.red)
                    .textSelection(.enabled)
                    .padding(.horizontal, 12)
            }
            TextEditor(text: $draft)
                .font(.system(size: 11, design: .monospaced))
                .scrollContentBackground(.hidden)
                .background(Color.grokElevated.opacity(0.25))
                .padding(.horizontal, 8)
                .padding(.bottom, 8)
            Text("Saving validates the frontmatter. A skill that no longer parses "
                + "would vanish from the catalog, so it is refused rather than written.")
                .font(.system(size: 9))
                .foregroundColor(.grokDim)
                .padding(.horizontal, 12)
                .padding(.bottom, 8)
        }
    }

    private func metric(_ name: String, _ value: String) -> some View {
        HStack(spacing: 4) {
            Text(name)
                .font(.system(size: 9))
                .foregroundColor(.grokDim)
            Text(value)
                .font(.system(size: 9, design: .monospaced))
                .foregroundColor(.grokMuted)
        }
    }
}
