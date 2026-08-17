import SwiftUI

struct RichMessageView: View {
    let text: String
    let isUser: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(blocks) { block in
                blockView(block)
            }
        }
    }

    private var blocks: [MarkdownBlock] {
        MarkdownBlockParser.parse(text)
    }

    @ViewBuilder
    private func blockView(_ block: MarkdownBlock) -> some View {
        switch block.kind {
        case .heading(let level, let content):
            HeadingBlockView(level: level, content: content)
        case .list(let ordered, let items):
            ListBlockView(ordered: ordered, items: items)
        case .code(let language, let code):
            CodeBlockView(language: language, code: code)
        case .paragraph(let markdown):
            InlineMarkdownText(text: markdown, isUser: isUser)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        case .table(let table):
            MarkdownTableView(table: table)
        case .thematicBreak:
            Divider()
                .overlay(Color.grokBorder.opacity(0.7))
                .padding(.vertical, 4)
        case .quote(let content):
            MarkdownQuoteView(content: content)
        }
    }
}

struct InlineMarkdownText: View {
    let text: String
    let isUser: Bool

    var body: some View {
        Text(renderedText)
    }

    /// Primary path: Foundation's markdown parser. Fallback: `manualMarkdown()`,
    /// which builds the string by hand with `styledText(_:)` instead of the
    /// `Text` concatenations removed in #1272.
    private var renderedText: AttributedString {
        renderAttributed() ?? manualMarkdown()
    }

    private func renderAttributed() -> AttributedString? {
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace,
            failurePolicy: .returnPartiallyParsedIfPossible
        )
        return try? AttributedString(markdown: text, options: options)
    }

    /// Fallback for when `AttributedString(markdown:)` fails. Built entirely on
    /// `AttributedString` (#1272): the deprecated `Text` `+` concatenations are
    /// gone, and every segment becomes a run carrying its styling as
    /// `inlinePresentationIntent` -- the same representation the primary path
    /// above produces, so both paths render through one `Text(attributed)`.
    private func manualMarkdown() -> AttributedString {
        var result = AttributedString()
        for segment in parseInline(text) {
            result += styledText(for: segment)
        }
        return result
    }

    /// One parsed segment as attributed text. `plain` carries no attributes;
    /// `bold`, `italic` and `code` carry the intents `Text` renders as bold,
    /// italic and monospaced respectively.
    private func styledText(for segment: InlineSegment) -> AttributedString {
        var styled = AttributedString(segment.text)
        switch segment {
        case .plain:
            break
        case .bold:
            styled.inlinePresentationIntent = .stronglyEmphasized
        case .italic:
            styled.inlinePresentationIntent = .emphasized
        case .code:
            styled.inlinePresentationIntent = .code
        }
        return styled
    }
}

private enum InlineSegment {
    case plain(String)
    case bold(String)
    case italic(String)
    case code(String)

    var text: String {
        switch self {
        case .plain(let s), .bold(let s), .italic(let s), .code(let s):
            return s
        }
    }
}

private func parseInline(_ text: String) -> [InlineSegment] {
    var segments: [InlineSegment] = []
    let pattern = "(\\*\\*(.+?)\\*\\*|_(.+?)_|`(.+?)`)"
    guard let regex = try? NSRegularExpression(pattern: pattern, options: []) else {
        return [.plain(text)]
    }
    let nsRange = NSRange(text.startIndex..., in: text)
    let matches = regex.matches(in: text, options: [], range: nsRange)
    var last = text.startIndex
    for match in matches {
        let range = Range(match.range, in: text)!
        if last < range.lowerBound {
            segments.append(.plain(String(text[last..<range.lowerBound])))
        }
        let full = String(text[range])
        if full.hasPrefix("**"), let inner = Range(match.range(at: 2), in: text) {
            segments.append(.bold(String(text[inner])))
        } else if full.hasPrefix("_"), let inner = Range(match.range(at: 3), in: text) {
            segments.append(.italic(String(text[inner])))
        } else if full.hasPrefix("`"), let inner = Range(match.range(at: 4), in: text) {
            segments.append(.code(String(text[inner])))
        } else {
            segments.append(.plain(full))
        }
        last = range.upperBound
    }
    if last < text.endIndex {
        segments.append(.plain(String(text[last...])))
    }
    return segments.isEmpty ? [.plain(text)] : segments
}

// MARK: - Block Views

struct HeadingBlockView: View {
    let level: Int
    let content: String

    private var fontSize: CGFloat {
        switch level {
        case 1: return 20
        case 2: return 18
        case 3: return 16
        default: return 14
        }
    }

    private var fontWeight: Font.Weight {
        switch level {
        case 1: return .bold
        case 2: return .semibold
        default: return .medium
        }
    }

    var body: some View {
        InlineMarkdownText(text: content, isUser: false)
            .font(.system(size: fontSize, weight: fontWeight))
            .padding(.top, level == 1 ? 4 : 2)
    }
}

struct ListBlockView: View {
    let ordered: Bool
    let items: [String]

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                HStack(alignment: .top, spacing: 6) {
                    Text(ordered ? "\(index + 1)." : "-")
                        .font(.body)
                        .foregroundColor(.grokMuted)
                        .frame(minWidth: ordered ? 20 : 8, alignment: .trailing)
                    InlineMarkdownText(text: item, isUser: false)
                        .font(.body)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }
}

struct MarkdownTableView: View {
    let table: MarkdownTable

    var body: some View {
        ScrollView(.horizontal, showsIndicators: table.columnCount > 2) {
            Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
                GridRow {
                    ForEach(Array(table.headers.enumerated()), id: \.offset) { index, header in
                        tableCell(header, column: index, isHeader: true)
                    }
                }

                Divider()
                    .overlay(Color.grokBorder.opacity(0.8))
                    .gridCellColumns(table.columnCount)

                ForEach(Array(table.rows.enumerated()), id: \.offset) { rowIndex, row in
                    GridRow {
                        ForEach(Array(row.enumerated()), id: \.offset) { column, content in
                            tableCell(content, column: column, isHeader: false)
                        }
                    }
                    .background(
                        rowIndex.isMultiple(of: 2)
                            ? Color.grokElevated.opacity(0.16)
                            : Color.clear
                    )
                }
            }
            .background(Color.grokElevated.opacity(0.24))
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .stroke(Color.grokBorder.opacity(0.45), lineWidth: 1)
            )
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func alignment(for column: Int) -> Alignment {
        guard table.alignments.indices.contains(column) else { return .leading }
        switch table.alignments[column] {
        case .leading: return .leading
        case .center: return .center
        case .trailing: return .trailing
        }
    }

    private func tableCell(_ content: String, column: Int, isHeader: Bool) -> some View {
        InlineMarkdownText(text: content, isUser: false)
            .font(.system(size: 13, weight: isHeader ? .semibold : .regular))
            .lineLimit(nil)
            .fixedSize(horizontal: false, vertical: true)
            .frame(
                minWidth: 96,
                idealWidth: 150,
                maxWidth: 260,
                alignment: alignment(for: column)
            )
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(isHeader ? Color.grokElevated.opacity(0.5) : Color.clear)
    }
}

struct MarkdownQuoteView: View {
    let content: String

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            RoundedRectangle(cornerRadius: 1)
                .fill(Color.grokMuted.opacity(0.8))
                .frame(width: 3)

            InlineMarkdownText(text: content, isUser: false)
                .foregroundColor(.grokMuted)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, 6)
        .padding(.trailing, 10)
        .background(Color.grokElevated.opacity(0.18))
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }
}

struct CodeBlockView: View {
    let language: String?
    let code: String
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                HStack(spacing: 4) {
                    Image(systemName: "chevron.left.forwardslash.chevron.right")
                        .font(.caption)
                    Text(language?.uppercased() ?? "CODE")
                        .font(.caption2)
                        .fontWeight(.semibold)
                }
                .foregroundColor(.grokMuted)

                Spacer()

                Button(action: {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(code, forType: .string)
                    copied = true
                    DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                        copied = false
                    }
                }) {
                    HStack(spacing: 4) {
                        Image(systemName: copied ? "checkmark" : "doc.on.doc")
                            .font(.caption)
                        Text(copied ? "Copied" : "Copy")
                            .font(.caption2)
                    }
                    .foregroundColor(.grokMuted)
                }
                .buttonStyle(PlainButtonStyle())
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(Color.grokElevated.opacity(0.5))

            ScrollView(.horizontal, showsIndicators: true) {
                Text(code)
                    .font(.system(.body, design: .monospaced))
                    .foregroundColor(.grokText)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
            }
        }
        .background(Color.grokElevated.opacity(0.4))
        .cornerRadius(8)
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(Color.grokBorder.opacity(0.3), lineWidth: 1)
        )
    }
}

struct ReasoningCollapsibleView: View {
    let content: String
    @State private var isExpanded = false

    private var lineCount: Int {
        content.components(separatedBy: .newlines).filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }.count
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "brain.head.profile")
                    .font(.system(size: 11))
                    .foregroundColor(.grokMuted)
                Text(isExpanded ? "Thought process" : "Thinking...")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(.grokMuted)

                if !isExpanded {
                    Text("\(lineCount) steps")
                        .font(.system(size: 10))
                        .foregroundColor(.grokDim)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Color.grokElevated.opacity(0.6))
                        .cornerRadius(6)
                }

                Spacer()

                Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                    .font(.system(size: 10))
                    .foregroundColor(.grokDim)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .contentShape(Rectangle())
            .onTapGesture {
                withAnimation(.spring(response: 0.25, dampingFraction: 0.8)) {
                    isExpanded.toggle()
                }
            }

            if isExpanded {
                Divider()
                    .overlay(Color.grokBorder.opacity(0.5))
                    .padding(.horizontal, 12)

                Text(content)
                    .font(.system(size: 11))
                    .foregroundColor(.grokDim)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .background(Color.grokElevated.opacity(0.4))
        .cornerRadius(8)
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(Color.grokBorder.opacity(0.3), lineWidth: 1)
        )
    }
}
