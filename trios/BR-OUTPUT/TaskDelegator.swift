//
//  TaskDelegator.swift
//  TriOS - Queen Master Chat
//
//  Automatic task delegation to sub-chats
//

import Foundation

/// TaskDelegator - Routes tasks to appropriate sub-chats
class TaskDelegator {
    
    @Published var activeDelegations: [ChatDelegation] = []
    @Published var completedDelegations: [ChatDelegation] = []
    
    private let chatRegistry: ChatRegistry
    
    init(chatRegistry: ChatRegistry = ChatRegistry.shared) {
        self.chatRegistry = chatRegistry
    }
    
    /// Delegate plan tasks to appropriate chats
    func delegate(plan: QueenTaskPlan) async -> [ChatDelegation] {
        var delegations: [ChatDelegation] = []
        
        for task in plan.tasks {
            // Find best chat for this task
            let bestChat = await findBestChat(for: task)
            
            if let chat = bestChat {
                let delegation = ChatDelegation(
                    chatId: chat.id,
                    task: task,
                    instructions: generateInstructions(for: task, chat: chat)
                )
                delegations.append(delegation)
                activeDelegations.append(delegation)
                
                // Send task to chat
                await sendTaskToChat(delegation)
            }
        }
        
        return delegations
    }
    
    /// Monitor delegation progress
    func monitorProgress() async {
        for var delegation in activeDelegations {
            let status = await chatRegistry.getTaskStatus(
                chatId: delegation.chatId,
                taskId: delegation.task.id
            )

            if status == .completed {
                delegation.task.status = .completed
                completedDelegations.append(delegation)
                activeDelegations.removeAll { $0.chatId == delegation.chatId }
            }
        }
    }
    
    // MARK: - Private Methods
    
    private func findBestChat(for task: QueenTask) async -> ChatInfo? {
        let chats = await chatRegistry.getAllChats()
        
        // Score each chat based on:
        // - Current load
        // - Relevant expertise
        // - Historical performance
        
        var bestChat: ChatInfo?
        var bestScore: Double = 0.0
        
        for chat in chats {
            let score = await calculateChatScore(chat, for: task)
            if score > bestScore {
                bestScore = score
                bestChat = chat
            }
        }
        
        return bestChat
    }
    
    private func calculateChatScore(_ chat: ChatInfo, for task: QueenTask) async -> Double {
        var score = 0.5
        
        // Lower load = higher score
        if chat.activeTasks < 3 {
            score += 0.2
        }
        
        // Relevant expertise
        if chat.expertise.contains(task.tool) {
            score += 0.2
        }
        
        // Good historical performance
        if chat.successRate > 0.8 {
            score += 0.1
        }
        
        return score
    }
    
    private func generateInstructions(for task: QueenTask, chat: ChatInfo) -> String {
        return """
        Execute task: \(task.description)
        Tool: \(task.tool)
        Estimated duration: \(task.estimatedDuration)s
        
        Report progress every 30 seconds.
        Notify on completion or failure.
        """
    }
    
    private func sendTaskToChat(_ delegation: ChatDelegation) async {
        await chatRegistry.sendTask(
            to: delegation.chatId,
            task: delegation.task,
            instructions: delegation.instructions
        )
    }
}

// MARK: - Supporting Types

class ChatRegistry {
    static let shared = ChatRegistry()
    
    private var chats: [ChatInfo] = []
    
    func getAllChats() async -> [ChatInfo] {
        return chats
    }
    
    func getTaskStatus(chatId: UUID, taskId: UUID) async -> QueenTask.TaskStatus {
        return .inProgress
    }
    
    func sendTask(to chatId: UUID, task: QueenTask, instructions: String) async {
        // Send task to chat
    }
}

struct ChatInfo {
    let id: UUID
    let name: String
    let activeTasks: Int
    let expertise: [String]
    let successRate: Double
}
