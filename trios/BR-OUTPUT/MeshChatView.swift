// AGENT-V-WAIVER: https://github.com/gHashTag/trios/issues/T27-EPIC-001
// Reason: untracked mesh-chat file on feat/zai-provider; triage before T27 seal.
// Expires: 2026-12-31
import SwiftUI

/// Container for the mesh chat experience: list + thread split.
struct MeshChatView: View {
    @StateObject private var viewModel = MeshChatViewModel()

    var body: some View {
        NavigationSplitView {
            MeshChatListView(viewModel: viewModel)
                .frame(minWidth: 220)
        } detail: {
            if let peer = viewModel.selectedPeer {
                MeshChatThreadView(viewModel: viewModel, peer: peer)
            } else {
                emptyDetail
            }
        }
        .background(Color.clear)
        .onAppear {
            viewModel.startPolling()
        }
        .onDisappear {
            viewModel.stopPolling()
        }
    }

    private var emptyDetail: some View {
        VStack(spacing: 12) {
            Image(systemName: "message.fill")
                .font(.system(size: 32))
                .foregroundColor(.grokMuted)
            Text("Select a conversation")
                .font(.system(size: 13, weight: .semibold))
                .foregroundColor(.grokText)
            Text("Or start a new mesh chat from the sidebar")
                .font(.system(size: 10))
                .foregroundColor(.grokDim)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.clear)
    }
}
