import SwiftUI

struct ToolCallCardView: View {
    let toolCall: ToolCall
    @State private var isExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button(action: { withAnimation(.easeInOut(duration: 0.16)) { isExpanded.toggle() } }) {
                HStack(spacing: 8) {
                    Image(systemName: toolCall.isComplete ? "checkmark.circle.fill" : "hammer.fill")
                        .foregroundColor(toolCall.isComplete ? .secondary : .gray)
                    Text(toolCall.name)
                        .font(.caption.weight(.semibold))
                        .foregroundColor(.primary)
                        .lineLimit(1)
                    Spacer(minLength: 8)
                    Text(detailSummary)
                        .font(.caption2)
                        .foregroundColor(.secondary)
                    Image(systemName: "chevron.right")
                        .font(.caption2.weight(.semibold))
                        .foregroundColor(.secondary)
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if isExpanded {
                VStack(alignment: .leading, spacing: 8) {
                    if !toolCall.arguments.isEmpty {
                        StructuredDetailSection(title: "Arguments", rawValue: toolCall.arguments)
                    }
                    if let output = toolCall.output, !output.isEmpty {
                        StructuredDetailSection(title: "Output", rawValue: output)
                    }
                }
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(Color(NSColor.controlBackgroundColor).opacity(0.8))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay {
            RoundedRectangle(cornerRadius: 8)
                .stroke(Color.gray.opacity(0.3), lineWidth: 1)
        }
    }

    private var detailSummary: String {
        let parts = [
            toolCall.arguments.isEmpty ? nil : "request",
            toolCall.output?.isEmpty == false ? "result" : nil
        ].compactMap { $0 }
        return parts.joined(separator: " + ")
    }
}

private struct StructuredDetailSection: View {
    let title: String
    let node: StructuredDetailNode
    let diffDocuments: [CodeDiffDocument]
    @State private var isExpanded = true
    @State private var showsRawDetails = false

    init(title: String, rawValue: String) {
        self.title = title
        let parsedNode = StructuredDetailParser.parse(rawValue)
        self.node = parsedNode
        self.diffDocuments = StructuredCodeDiffExtractor.documents(from: parsedNode)
    }

    var body: some View {
        DisclosureGroup(isExpanded: $isExpanded) {
            VStack(alignment: .leading, spacing: 8) {
                if diffDocuments.isEmpty {
                    StructuredDetailTree(node: node)
                } else {
                    ForEach(Array(diffDocuments.enumerated()), id: \.offset) { _, document in
                        UnifiedDiffView(document: document)
                    }

                    DisclosureGroup("Raw details", isExpanded: $showsRawDetails) {
                        StructuredDetailTree(node: node)
                            .padding(.top, 5)
                    }
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .tint(.secondary)
                }
            }
            .padding(.top, 6)
            .padding(.leading, 5)
        } label: {
            HStack(spacing: 6) {
                Image(systemName: title == "Arguments" ? "arrow.up.doc" : "arrow.down.doc")
                    .foregroundColor(.secondary)
                Text(title)
                    .font(.caption.weight(.semibold))
                Spacer()
                DetailTypeBadge(node: node)
            }
        }
        .tint(.secondary)
        .padding(8)
        .background(Color.grokSurface)
        .clipShape(RoundedRectangle(cornerRadius: 7))
    }
}

struct UnifiedDiffView: View {
    let document: CodeDiffDocument

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            diffHeader

            Divider()
                .overlay(Color.white.opacity(0.12))

            ScrollView([.horizontal, .vertical]) {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(document.lines.enumerated()), id: \.offset) { _, line in
                        UnifiedDiffLineView(line: line)
                    }
                }
                .frame(minWidth: 560, alignment: .leading)
                .textSelection(.enabled)
            }
            .frame(height: viewportHeight)
        }
        .background(Color.triosGlassStrong)
        .clipShape(RoundedRectangle(cornerRadius: 7))
        .overlay {
            RoundedRectangle(cornerRadius: 7)
                .stroke(Color.white.opacity(0.12), lineWidth: 1)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Code changes for \(document.displayPath)")
    }

    private var diffHeader: some View {
        HStack(spacing: 8) {
            Image(systemName: "doc.text")
                .font(.caption)
                .foregroundColor(.white.opacity(0.72))

            Text(document.displayPath)
                .font(TriosType.font(11, weight: .semibold, design: .monospaced))
                .foregroundColor(.white.opacity(0.9))
                .lineLimit(1)

            Spacer(minLength: 12)

            Text("-\(document.deletionCount)")
                .foregroundColor(UnifiedDiffPalette.deletionForeground)
            Text("+\(document.additionCount)")
                .foregroundColor(UnifiedDiffPalette.additionForeground)

            Button(action: copyDiff) {
                Image(systemName: "doc.on.doc")
                    .font(.caption)
                    .foregroundColor(.white.opacity(0.68))
            }
            .buttonStyle(.plain)
            .help("Copy diff")
        }
        .font(TriosType.font(11, weight: .semibold, design: .monospaced))
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(Color.white.opacity(0.045))
    }

    private var viewportHeight: CGFloat {
        min(420, max(92, CGFloat(document.lines.count) * 20 + 8))
    }

    private func copyDiff() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(document.copyText, forType: .string)
    }
}

private struct UnifiedDiffLineView: View {
    let line: CodeDiffLine

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 0) {
            lineNumber(line.oldLineNumber)
            lineNumber(line.newLineNumber)

            Text(marker)
                .foregroundColor(foregroundColor)
                .frame(width: 22, alignment: .center)

            Text(line.text.isEmpty ? " " : line.text)
                .foregroundColor(foregroundColor)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.trailing, 12)
        }
        .font(TriosType.font(11, weight: .regular, design: .monospaced))
        .frame(minHeight: 20)
        .background(backgroundColor)
    }

    private func lineNumber(_ number: Int?) -> some View {
        Text(number.map(String.init) ?? "")
            .foregroundColor(.white.opacity(0.32))
            .frame(width: 40, alignment: .trailing)
            .padding(.trailing, 7)
            .background(Color.grokSurface)
    }

    private var marker: String {
        switch line.kind {
        case .addition: return "+"
        case .deletion: return "-"
        case .hunkHeader: return "@"
        case .fileHeader: return "F"
        case .context, .metadata: return ""
        }
    }

    private var foregroundColor: Color {
        switch line.kind.visualTone {
        case .green:
            return UnifiedDiffPalette.additionForeground
        case .red:
            return UnifiedDiffPalette.deletionForeground
        case .accent:
            return UnifiedDiffPalette.hunkForeground
        case .neutral:
            switch line.kind {
            case .fileHeader: return .white.opacity(0.78)
            case .metadata: return .white.opacity(0.46)
            default: return .white.opacity(0.82)
            }
        }
    }

    private var backgroundColor: Color {
        switch line.kind.visualTone {
        case .green:
            return UnifiedDiffPalette.additionBackground
        case .red:
            return UnifiedDiffPalette.deletionBackground
        case .accent:
            return UnifiedDiffPalette.hunkBackground
        case .neutral:
            return line.kind == .fileHeader ? Color.white.opacity(0.035) : Color.clear
        }
    }
}

private enum UnifiedDiffPalette {
    static let additionForeground = Color(red: 0.43, green: 0.88, blue: 0.58)
    static let additionBackground = Color.green.opacity(0.15)
    static let deletionForeground = Color(red: 1.0, green: 0.48, blue: 0.48)
    static let deletionBackground = Color.red.opacity(0.15)
    static let hunkForeground = Color(red: 0.55, green: 0.72, blue: 1.0)
    static let hunkBackground = Color.blue.opacity(0.11)
}

private struct StructuredDetailTree: View {
    let node: StructuredDetailNode

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            switch node {
            case .object(let fields):
                ForEach(Array(fields.enumerated()), id: \.offset) { _, field in
                    StructuredDetailRow(label: field.key, node: field.value)
                }
            case .array(let values):
                ForEach(Array(values.enumerated()), id: \.offset) { index, value in
                    StructuredDetailRow(label: "[\(index)]", node: value)
                }
            default:
                StructuredDetailRow(label: "Value", node: node)
            }
        }
    }
}

private struct StructuredDetailRow: View {
    let label: String
    let node: StructuredDetailNode
    @State private var isExpanded = false

    var body: some View {
        Group {
            if isExpandable {
                DisclosureGroup(isExpanded: $isExpanded) {
                    expandedContent
                        .padding(.top, 5)
                        .padding(.leading, 10)
                        .overlay(alignment: .leading) {
                            Rectangle()
                                .fill(Color.secondary.opacity(0.2))
                                .frame(width: 1)
                        }
                } label: {
                    rowLabel
                }
                .tint(.secondary)
            } else {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(label)
                        .font(.caption.monospaced().weight(.medium))
                        .foregroundColor(.secondary)
                    Spacer(minLength: 8)
                    scalarValue
                }
            }
        }
        .padding(.vertical, 3)
        .padding(.horizontal, 6)
        .background(Color.white.opacity(isExpanded ? 0.045 : 0.018))
        .clipShape(RoundedRectangle(cornerRadius: 5))
    }

    private var rowLabel: some View {
        HStack(spacing: 6) {
            Image(systemName: nodeIcon)
                .font(.caption2)
                .foregroundColor(.secondary)
            Text(label)
                .font(.caption.monospaced().weight(.medium))
                .foregroundColor(.primary)
                .lineLimit(1)
            Spacer(minLength: 8)
            DetailTypeBadge(node: node)
        }
    }

    @ViewBuilder
    private var expandedContent: some View {
        switch node {
        case .object, .array:
            StructuredDetailTree(node: node)
        case .string(let value):
            ScrollView([.horizontal, .vertical]) {
                Text(value)
                    .font(.caption.monospaced())
                    .foregroundColor(.primary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: true, vertical: true)
                    .padding(8)
            }
            .frame(height: textViewportHeight(value))
            .background(Color(NSColor.textBackgroundColor).opacity(0.55))
            .clipShape(RoundedRectangle(cornerRadius: 5))
        default:
            scalarValue
        }
    }

    @ViewBuilder
    private var scalarValue: some View {
        switch node {
        case .string(let value):
            Text(value)
                .lineLimit(2)
                .textSelection(.enabled)
        case .number(let value):
            Text(value).foregroundColor(.blue)
        case .boolean(let value):
            Text(value ? "true" : "false").foregroundColor(.purple)
        case .null:
            Text("null").foregroundColor(.secondary)
        case .object, .array:
            EmptyView()
        }
    }

    private var isExpandable: Bool {
        switch node {
        case .object, .array:
            return true
        case .string(let value):
            return value.count > 120 || value.contains("\n")
        default:
            return false
        }
    }

    private var nodeIcon: String {
        switch node {
        case .object: return "curlybraces"
        case .array: return "list.number"
        case .string: return "text.alignleft"
        case .number: return "number"
        case .boolean: return "switch.2"
        case .null: return "minus.circle"
        }
    }

    private func textViewportHeight(_ value: String) -> CGFloat {
        let lineCount = max(1, value.components(separatedBy: .newlines).count)
        return min(320, max(54, CGFloat(lineCount) * 17 + 18))
    }
}

private struct DetailTypeBadge: View {
    let node: StructuredDetailNode

    var body: some View {
        Text(summary)
            .font(TriosType.font(10, weight: .medium, design: .monospaced))
            .foregroundColor(.secondary)
            .padding(.horizontal, 5)
            .padding(.vertical, 2)
            .background(Color.secondary.opacity(0.1))
            .clipShape(Capsule())
    }

    private var summary: String {
        switch node {
        case .object(let fields): return "Object \(fields.count)"
        case .array(let values): return "Array \(values.count)"
        case .string(let value):
            let lines = value.components(separatedBy: .newlines).count
            return lines > 1 ? "Text \(lines) lines" : "Text"
        case .number: return "Number"
        case .boolean: return "Boolean"
        case .null: return "Null"
        }
    }
}
