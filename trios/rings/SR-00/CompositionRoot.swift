import Foundation
import SwiftUI

// MARK: - Composition Root (Dependency Injection)

struct CompositionRoot {
    @MainActor
    func makeChatViewModel() -> ChatViewModel {
        NSLog("CompositionRoot: creating ChatViewModel...")
        let healthCheck = HealthCheckTransport()
        let parser = UIMessageStreamParser()
        let persister = ConversationPersister()
        let stateMachine = ConversationStateMachine()
        let modelStore = ModelConfigurationStore.shared
        let memoryStore: any AgentMemoryStoreProtocol
        do {
            memoryStore = try MemoryStore()
        } catch {
            NSLog(
                "CompositionRoot: durable memory unavailable, using volatile fallback: %@",
                error.localizedDescription
            )
            memoryStore = VolatileMemoryStore()
        }
        let fingerprintKey = MemoryFingerprintKeyProvider.loadOrCreate()
        if fingerprintKey == nil {
            NSLog(
                "CompositionRoot: Keychain recall key unavailable; long-term memory disabled"
            )
        }
        let memoryService = AgentMemoryService(
            store: memoryStore,
            fingerprintKey: fingerprintKey
        )
        let todoPlanner = TODOPlanner(
            store: memoryStore,
            preferences: .standard
        )

        let serverURL = URL(string: ProjectPaths.mcpBaseURL) ?? URL(fileURLWithPath: "/dev/null")
        let localAuthProvider = LocalAuthProvider(baseURL: serverURL)
        LocalAuthUIManager.shared.configure(provider: localAuthProvider)
        // One decision about who serves bytes, asked twice: once for the chat
        // panel, once per worker. It used to be asked only for the workers, so
        // a cassette run still built a live SSETransport for the chat - and
        // ChatViewModel's "is the API key present" precondition keys off
        // `type(of: transport) is SSETransport.Type`. Under a replay that
        // precondition therefore fired on a credential the run would never use,
        // and refused to dispatch. The suite passed anyway on any machine that
        // happened to have a key, and failed on one that did not, blaming the
        // Keychain. A recorded run must not depend on a secret; that is the
        // entire reason to record it.
        //
        // A fresh instance each call: workers must not share a transport with
        // the chat, because switching conversation cancels it.
        // The timeout is a parameter rather than a constant because the two
        // callers genuinely differ: the chat keeps SSETransport's own default,
        // a worker gets an hour. Folding them together here would have changed
        // the chat's patience as a side effect of a transport fix.
        // `@Sendable` closure rather than a local func: the worker runner calls
        // it from a nonisolated context, and a local function here inherits the
        // enclosing main-actor isolation.
        let makeTransport: @Sendable (TimeInterval?) -> ChatTransportProtocol = { resourceTimeout in
            if let cassette = ProcessInfo.processInfo.environment["TRIOS_REPLAY_CASSETTE"],
               !cassette.isEmpty {
                return ReplayTransport(path: cassette)
            }
            if let resourceTimeout {
                return SSETransport(
                    localAuthProvider: localAuthProvider,
                    resourceTimeout: resourceTimeout
                )
            }
            return SSETransport(localAuthProvider: localAuthProvider)
        }

        let transport = makeTransport(nil)
        NSLog("CompositionRoot: chat transport created (\(type(of: transport)))")

        let agentCard = AgentCard(
            id: AgentId("trios-agent"),
            name: "TRIOS AGENT",
            description: "Commanding General of BrowserOS Agents. Native macOS A2A participant with browser control and chat capabilities.",
            capabilities: [.browserControl, .chat, .orchestrator],
            version: "1.0.0",
            endpoint: URL(string: "\(ProjectPaths.mcpBaseURL)/a2a")
        )
        let a2aClient = A2ARegistryClient(
            serverURL: serverURL,
            agentCard: agentCard,
            localAuthProvider: localAuthProvider
        )
        NSLog("CompositionRoot: A2ARegistryClient created")

        QueenBackgroundService.shared.configure(
            memoryService: memoryService,
            persister: persister,
            a2aClient: a2aClient
        )

        // Each worker gets its own transport. Sharing the chat's transport would
        // mean a conversation switch (which cancels it) also killed every bee.
        let workerRunner = QueenWorkerRunner(
            persister: persister,
            modelStore: modelStore,
            // A cassette replaces the provider entirely when one is named, so a
            // swarm run is deterministic: same bytes, same order, every time.
            // Without it a one-in-three failure costs a session to characterise,
            // because each attempt is a different conversation with a different
            // model on a different day.
            //
            // An hour for a real worker: nobody is watching a bee tick, and
            // being cut off mid-task wastes every tool call it already made.
            makeTransport: { makeTransport(3600) }
        )
        NSLog("CompositionRoot: QueenWorkerRunner created")

        let vm = ChatViewModel(
            transport: transport,
            healthCheck: healthCheck,
            parser: parser,
            persister: persister,
            stateMachine: stateMachine,
            a2aClient: a2aClient,
            modelStore: modelStore,
            memoryService: memoryService,
            todoPlanner: todoPlanner,
            workerRunner: workerRunner
        )
        NSLog("CompositionRoot: ChatViewModel created")
        return vm
    }

    @MainActor
    func makeSessionGuard(for viewModel: ChatViewModel) -> SessionGuard {
        let healthCheck = HealthCheckTransport()
        return SessionGuard(healthCheck: healthCheck, a2aClient: viewModel.a2aClient)
    }

    @MainActor
    func makeCladeGuard() -> CladeGuard {
        return CladeGuard()
    }
}
