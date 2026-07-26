import SwiftUI

// MARK: - CommunityMacro Model

struct CommunityMacro: Codable, Identifiable {
    let id: UUID
    let name: String
    let description: String
    let author: String
    let authorAvatar: String?
    let category: String
    let tags: [String]
    let steps: [MacroStep]
    let downloads: Int
    let rating: Double
    let reviews: Int
    let version: String
    let createdAt: Date
    let updatedAt: Date
    let license: String
    let sourceURL: String?
    let isVerified: Bool
    
    struct MacroStep: Codable {
        let action: String
        let parameters: [String: String]
        let delay: Double
    }
    
    static let examples: [CommunityMacro] = [
        CommunityMacro(
            id: UUID(),
            name: "Morning Standup",
            description: "Automated morning routine: open Slack, GitHub, Linear, post standup message",
            author: "gHashTag",
            authorAvatar: "https://github.com/gHashTag.png",
            category: "Productivity",
            tags: ["standup", "morning", "slack", "github"],
            steps: [
                MacroStep(action: "openApp", parameters: ["bundleId": "com.tinyspeck.slackmacgap"], delay: 0),
                MacroStep(action: "typeText", parameters: ["text": "Standup: Yesterday I worked on Wave 4 Zeta. Today: Open Intelligence."], delay: 1),
                MacroStep(action: "openURL", parameters: ["url": "https://github.com"], delay: 0.5),
                MacroStep(action: "openURL", parameters: ["url": "https://linear.app"], delay: 0.5)
            ],
            downloads: 1247,
            rating: 4.8,
            reviews: 89,
            version: "1.2.0",
            createdAt: Date().addingTimeInterval(-86400 * 30),
            updatedAt: Date().addingTimeInterval(-86400 * 2),
            license: "MIT",
            sourceURL: "https://huggingface.co/trios-macros/morning-standup",
            isVerified: true
        ),
        CommunityMacro(
            id: UUID(),
            name: "Code Review Assistant",
            description: "Open PR, run tests, check coverage, post summary to Slack",
            author: "trinity-community",
            authorAvatar: nil,
            category: "Development",
            tags: ["code-review", "github", "ci", "slack"],
            steps: [
                MacroStep(action: "openURL", parameters: ["url": "https://github.com/pulls"], delay: 0),
                MacroStep(action: "clickElement", parameters: ["selector": ".js-issue-row"], delay: 1),
                MacroStep(action: "runCommand", parameters: ["command": "npm test"], delay: 5),
                MacroStep(action: "typeText", parameters: ["text": "Tests passed! ✅"], delay: 0.5)
            ],
            downloads: 892,
            rating: 4.6,
            reviews: 54,
            version: "2.0.1",
            createdAt: Date().addingTimeInterval(-86400 * 60),
            updatedAt: Date().addingTimeInterval(-86400 * 7),
            license: "Apache-2.0",
            sourceURL: "https://huggingface.co/trios-macros/code-review-assistant",
            isVerified: true
        ),
        CommunityMacro(
            id: UUID(),
            name: "Research Paper Digest",
            description: "Download arXiv papers, extract abstracts, summarize with AI",
            author: "research-lab",
            authorAvatar: nil,
            category: "Research",
            tags: ["arxiv", "research", "ai", "summarization"],
            steps: [
                MacroStep(action: "openURL", parameters: ["url": "https://arxiv.org/list/cs.AI/recent"], delay: 0),
                MacroStep(action: "scrapePage", parameters: ["selector": ".list-title"], delay: 2),
                MacroStep(action: "callAI", parameters: ["prompt": "Summarize these papers"], delay: 10),
                MacroStep(action: "saveFile", parameters: ["path": "~/Research/digest.md"], delay: 1)
            ],
            downloads: 445,
            rating: 4.9,
            reviews: 32,
            version: "1.0.0",
            createdAt: Date().addingTimeInterval(-86400 * 14),
            updatedAt: Date().addingTimeInterval(-86400 * 1),
            license: "MIT",
            sourceURL: "https://huggingface.co/trios-macros/research-digest",
            isVerified: false
        )
    ]
}

// MARK: - MarketplaceViewModel

@MainActor
class MarketplaceViewModel: ObservableObject {
    @Published var macros: [CommunityMacro] = .init()
    @Published var featuredMacros: [CommunityMacro] = .init()
    @Published var isLoading = false
    @Published var searchQuery = ""
    @Published var selectedCategory = "All"
    @Published var categories: [String] = ["All", "Productivity", "Development", "Research", "Communication", "Design"]
    @Published var downloadedMacros: [CommunityMacro] = .init()
    @Published var userRating: [UUID: Double] = [:]
    
    private let apiBaseURL = "https://huggingface.co/api/trios-macros"
    private let localMacrosPath: URL
    
    init() {
        let docsPath = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
        self.localMacrosPath = docsPath.appendingPathComponent("Trios/Macros", isDirectory: true)
        try? FileManager.default.createDirectory(at: localMacrosPath, withIntermediateDirectories: true)
        
        loadMacros()
    }
    
    func loadMacros() {
        isLoading = true
        
        // Load from Hugging Face API (simulated for now)
        Task {
            try? await Task.sleep(nanoseconds: 1_000_000_000) // 1s
            
            macros = CommunityMacro.examples
            featuredMacros = Array(macros.prefix(3))
            
            // Load downloaded macros from disk
            loadDownloadedMacros()
            
            isLoading = false
        }
    }
    
    func searchMacros(query: String) {
        searchQuery = query
        
        if query.isEmpty {
            loadMacros()
            return
        }
        
        let lowercasedQuery = query.lowercased()
        macros = CommunityMacro.examples.filter { macro in
            macro.name.lowercased().contains(lowercasedQuery) ||
            macro.description.lowercased().contains(lowercasedQuery) ||
            macro.tags.contains { $0.lowercased().contains(lowercasedQuery) }
        }
    }
    
    func filterByCategory(_ category: String) {
        selectedCategory = category
        
        if category == "All" {
            macros = CommunityMacro.examples
        } else {
            macros = CommunityMacro.examples.filter { $0.category == category }
        }
    }
    
    func downloadMacro(_ macro: CommunityMacro) async {
        // Download from Hugging Face
        guard let sourceURL = macro.sourceURL else { return }
        
        do {
            let (tempURL, _) = try await URLSession.shared.download(from: URL(string: sourceURL)!)
            
            // Move to local macros directory
            let destinationURL = localMacrosPath.appendingPathComponent("\(macro.id).json")
            try FileManager.default.moveItem(at: tempURL, to: destinationURL)
            
            // Add to downloaded list
            downloadedMacros.append(macro)
            
            NSLog("[Marketplace] Downloaded: \(macro.name)")
        } catch {
            NSLog("[Marketplace] Download error: \(error)")
        }
    }
    
    func rateMacro(_ macro: CommunityMacro, rating: Double) {
        userRating[macro.id] = rating
        
        // Submit rating to Hugging Face API (in production)
        NSLog("[Marketplace] Rated \(macro.name): \(rating)")
    }
    
    private func loadDownloadedMacros() {
        let enumerator = FileManager.default.enumerator(at: localMacrosPath, includingPropertiesForKeys: [.contentAccessDateKey])
        
        while let fileURL = enumerator?.nextObject() as? URL {
            guard fileURL.pathExtension == "json" else { continue }
            
            do {
                let data = try Data(contentsOf: fileURL)
                let macro = try JSONDecoder().decode(CommunityMacro.self, from: data)
                downloadedMacros.append(macro)
            } catch {
                NSLog("[Marketplace] Failed to load macro: \(error)")
            }
        }
    }
}

// MARK: - CommunityMacroMarketplaceView

struct CommunityMacroMarketplaceView: View {
    @StateObject private var viewModel = MarketplaceViewModel()
    @Environment(\.dismiss) private var dismiss
    
    var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack {
                Text("Community Macro Marketplace")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundColor(.grokText)
                
                Spacer()
                
                Button(action: { dismiss() }) {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 20))
                        .foregroundColor(.grokDim)
                }
                .buttonStyle(.plain)
            }
            .padding(20)
            
            Divider().overlay(Color.grokDivider)
            
            // Search and filter
            searchAndFilterSection
            
            // Content
            if viewModel.isLoading {
                loadingView
            } else {
                contentSection
            }
        }
        .frame(width: 900, height: 700)
        .background(Color.grokBackground)
        .cornerRadius(16)
    }
    
    private var searchAndFilterSection: some View {
        HStack(spacing: 12) {
            // Search field
            HStack {
                Image(systemName: "magnifyingglass")
                    .foregroundColor(.grokDim)
                
                TextField("Search macros...", text: $viewModel.searchQuery)
                    .textFieldStyle(.plain)
                    .onChange(of: viewModel.searchQuery) { newValue in
                        viewModel.searchMacros(query: newValue)
                    }
            }
            .padding(10)
            .background(Color.grokElevated)
            .cornerRadius(8)
            .frame(width: 300)
            
            // Category filter
            Picker("Category", selection: $viewModel.selectedCategory) {
                ForEach(viewModel.categories, id: \.self) { category in
                    Text(category).tag(category)
                }
            }
            .pickerStyle(.segmented)
            .onChange(of: viewModel.selectedCategory) { newValue in
                viewModel.filterByCategory(newValue)
            }
            
            Spacer()
            
            // Downloaded count
            Label("\(viewModel.downloadedMacros.count) downloaded", systemImage: "arrow.down.circle.fill")
                .font(.system(size: 12))
                .foregroundColor(.grokDim)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
    }
    
    private var loadingView: some View {
        VStack {
            ProgressView()
                .scaleEffect(1.5)
                .tint(.purple)
            
            Text("Loading macros from Hugging Face...")
                .font(.system(size: 13))
                .foregroundColor(.grokDim)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    
    private var contentSection: some View {
        ScrollView {
            VStack(spacing: 16) {
                // Featured macros
                if !viewModel.featuredMacros.isEmpty {
                    featuredSection
                }
                
                // All macros
                macrosGrid
            }
            .padding(20)
        }
    }
    
    private var featuredSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Featured Macros")
                .font(.system(size: 16, weight: .semibold))
                .foregroundColor(.grokText)
            
            HStack(spacing: 16) {
                ForEach(viewModel.featuredMacros) { macro in
                    FeaturedMacroCard(macro: macro, onDownload: {
                        Task {
                            await viewModel.downloadMacro(macro)
                        }
                    })
                }
            }
        }
    }
    
    private var macrosGrid: some View {
        LazyVGrid(columns: [
            GridItem(.flexible()),
            GridItem(.flexible()),
            GridItem(.flexible())
        ], spacing: 16) {
            ForEach(viewModel.macros) { macro in
                MacroCard(
                    macro: macro,
                    isDownloaded: viewModel.downloadedMacros.contains { $0.id == macro.id },
                    onDownload: {
                        Task {
                            await viewModel.downloadMacro(macro)
                        }
                    },
                    onRate: { rating in
                        viewModel.rateMacro(macro, rating: rating)
                    }
                )
            }
        }
    }
}

// MARK: - FeaturedMacroCard

struct FeaturedMacroCard: View {
    let macro: CommunityMacro
    let onDownload: () -> Void
    
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(macro.category)
                    .font(.system(size: 10, weight: .medium))
                    .foregroundColor(.white)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 3)
                    .background(Color.purple)
                    .cornerRadius(4)
                
                Spacer()
                
                if macro.isVerified {
                    Image(systemName: "checkmark.seal.fill")
                        .foregroundColor(.blue)
                }
            }
            
            Text(macro.name)
                .font(.system(size: 16, weight: .bold))
                .foregroundColor(.grokText)
                .lineLimit(2)
            
            Text(macro.description)
                .font(.system(size: 12))
                .foregroundColor(.grokDim)
                .lineLimit(3)
            
            HStack {
                Label("\(macro.downloads)", systemImage: "arrow.down.circle")
                    .font(.system(size: 11))
                    .foregroundColor(.grokDim)
                
                Label(String(format: "%.1f", macro.rating), systemImage: "star.fill")
                    .font(.system(size: 11))
                    .foregroundColor(.yellow)
            }
            
            Button(action: onDownload) {
                HStack {
                    Image(systemName: "arrow.down.circle")
                    Text("Download")
                }
                .frame(maxWidth: .infinity)
                .padding(8)
                .background(Color.blue)
                .foregroundColor(.white)
                .cornerRadius(6)
            }
            .buttonStyle(.plain)
        }
        .padding(16)
        .background(Color.grokElevated)
        .cornerRadius(12)
        .frame(width: 270)
    }
}

// MARK: - MacroCard

struct MacroCard: View {
    let macro: CommunityMacro
    let isDownloaded: Bool
    let onDownload: () -> Void
    let onRate: (Double) -> Void
    
    @State private var showingRating = false
    @State private var userRating: Double = 0
    
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(macro.category)
                    .font(.system(size: 9, weight: .medium))
                    .foregroundColor(.white)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 2)
                    .background(Color.purple.opacity(0.8))
                    .cornerRadius(3)
                
                Spacer()
                
                if macro.isVerified {
                    Image(systemName: "checkmark.seal.fill")
                        .font(.system(size: 10))
                        .foregroundColor(.blue)
                }
            }
            
            Text(macro.name)
                .font(.system(size: 14, weight: .semibold))
                .foregroundColor(.grokText)
                .lineLimit(2)
            
            Text(macro.author)
                .font(.system(size: 11))
                .foregroundColor(.grokDim)
            
            HStack(spacing: 8) {
                Label("\(macro.downloads)", systemImage: "arrow.down.circle")
                    .font(.system(size: 10))
                    .foregroundColor(.grokDim)
                
                Label(String(format: "%.1f", macro.rating), systemImage: "star.fill")
                    .font(.system(size: 10))
                    .foregroundColor(.yellow)
                
                Label("\(macro.reviews)", systemImage: "bubble.left.and.bubble.right")
                    .font(.system(size: 10))
                    .foregroundColor(.grokDim)
            }
            
            if isDownloaded {
                Label("Downloaded", systemImage: "checkmark.circle.fill")
                    .font(.system(size: 11))
                    .foregroundColor(.green)
                    .frame(maxWidth: .infinity)
                    .padding(6)
                    .background(Color.green.opacity(0.1))
                    .cornerRadius(5)
            } else {
                Button(action: onDownload) {
                    HStack {
                        Image(systemName: "arrow.down.circle")
                        Text("Download")
                    }
                    .frame(maxWidth: .infinity)
                    .padding(6)
                    .background(Color.blue)
                    .foregroundColor(.white)
                    .cornerRadius(5)
                }
                .buttonStyle(.plain)
            }
            
            // Rating stars
            HStack(spacing: 4) {
                ForEach(1...5, id: \.self) { star in
                    Image(systemName: star <= Int(userRating) ? "star.fill" : "star")
                        .font(.system(size: 12))
                        .foregroundColor(star <= Int(userRating) ? .yellow : .grokDivider)
                        .onTapGesture {
                            userRating = Double(star)
                            onRate(Double(star))
                        }
                }
            }
        }
        .padding(12)
        .background(Color.grokElevated)
        .cornerRadius(10)
    }
}

// MARK: - Preview

#if DEBUG
struct CommunityMacroMarketplaceViewPreview: PreviewProvider {
    static var previews: some View { CommunityMacroMarketplaceView() }
}
#endif
