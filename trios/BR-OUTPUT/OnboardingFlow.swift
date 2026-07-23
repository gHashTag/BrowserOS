//
//  OnboardingFlow.swift
//  TriOS — Interactive First-Run Experience
//
//  Guides new users through key features
//

import Foundation
import SwiftUI

/// OnboardingFlow — Interactive tutorial for new users
@MainActor
class OnboardingViewModel: ObservableObject {
    
    @Published var isOnboardingComplete: Bool = false
    @Published var currentStep: Int = 0
    @Published var isShowingOnboarding: Bool = false
    
    private let steps: [OnboardingStep]
    
    init() {
        self.steps = [
            OnboardingStep(
                title: "👑 Meet Your Queen",
                description: "TriOS Queen is your AI assistant that orchestrates your entire digital workflow.",
                image: "crown.fill",
                action: .none
            ),
            OnboardingStep(
                title: "⚡ Lightning Fast",
                description: "Hotkeys respond in <10ms. Press ⌘K to search, ⌘/ for help.",
                image: "bolt.fill",
                action: .tryHotkey(command: "K")
            ),
            OnboardingStep(
                title: "🧠 AI Planning",
                description: "Queen automatically plans and delegates tasks across multiple chats.",
                image: "brain.head.profile",
                action: .none
            ),
            OnboardingStep(
                title: "👥 Team Collaboration",
                description: "Invite team members, set permissions, and track everything with audit logs.",
                image: "person.2.fill",
                action: .none
            ),
            OnboardingStep(
                title: "🌐 Integrations",
                description: "Connect Slack, Email, Calendar — Queen orchestrates all your tools.",
                image: "link.circle.fill",
                action: .showIntegrations
            ),
            OnboardingStep(
                title: "🎯 Ready to Go!",
                description: "You're all set. Start chatting with Queen!",
                image: "checkmark.circle.fill",
                action: .complete
            )
        ]
        checkOnboardingStatus()
    }
    
    var currentStepModel: OnboardingStep {
        steps[currentStep]
    }
    
    var totalSteps: Int {
        steps.count
    }
    
    var progress: Double {
        Double(currentStep + 1) / Double(totalSteps)
    }
    
    func nextStep() {
        guard currentStep < steps.count - 1 else {
            completeOnboarding()
            return
        }
        currentStep += 1
        executeStepAction(steps[currentStep].action)
    }
    
    func previousStep() {
        guard currentStep > 0 else { return }
        currentStep -= 1
    }
    
    func skipOnboarding() {
        completeOnboarding()
    }
    
    func startOnboarding() {
        isShowingOnboarding = true
        currentStep = 0
    }
    
    // MARK: - Private Methods
    
    private func checkOnboardingStatus() {
        isOnboardingComplete = UserDefaults.standard.bool(forKey: "trios_onboarding_complete")
        if !isOnboardingComplete {
            isShowingOnboarding = true
        }
    }
    
    private func completeOnboarding() {
        isOnboardingComplete = true
        isShowingOnboarding = false
        UserDefaults.standard.set(true, forKey: "trios_onboarding_complete")
        AnalyticsService.shared.track("onboarding_complete", properties: [
            "steps_completed": currentStep + 1,
            "total_steps": totalSteps
        ])
    }
    
    private func executeStepAction(_ action: OnboardingAction) {
        switch action {
        case .none:
            break
        case .tryHotkey(let command):
            // Show hotkey overlay
            break
        case .showIntegrations:
            // Open integrations panel
            break
        case .complete:
            completeOnboarding()
        }
    }
}

// MARK: - Models

struct OnboardingStep {
    let title: String
    let description: String
    let image: String
    let action: OnboardingAction
}

enum OnboardingAction {
    case none
    case tryHotkey(command: String)
    case showIntegrations
    case complete
}

// MARK: - Onboarding View

struct OnboardingView: View {
    @StateObject private var viewModel = OnboardingViewModel()
    
    var body: some View {
        VStack(spacing: 0) {
            // Progress bar
            GeometryReader { geometry in
                Rectangle()
                    .fill(Color.purple)
                    .frame(width: geometry.size.width * viewModel.progress)
                    .animation(.easeInOut, value: viewModel.progress)
            }
            .frame(height: 4)
            .background(Color.gray.opacity(0.2))
            
            // Content
            VStack(spacing: 40) {
                Spacer()
                
                // Icon
                Image(systemName: viewModel.currentStepModel.image)
                    .font(.system(size: 80))
                    .foregroundColor(.purple)
                    .transition(.scale.combined(with: .opacity))
                
                // Title
                Text(viewModel.currentStepModel.title)
                    .font(.title)
                    .fontWeight(.bold)
                    .transition(.opacity)
                
                // Description
                Text(viewModel.currentStepModel.description)
                    .font(.body)
                    .foregroundColor(.gray)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 40)
                    .transition(.opacity)
                
                Spacer()
                
                // Buttons
                HStack(spacing: 20) {
                    Button("Skip") {
                        viewModel.skipOnboarding()
                    }
                    .buttonStyle(.bordered)
                    
                    if viewModel.currentStep > 0 {
                        Button("Back") {
                            viewModel.previousStep()
                        }
                        .buttonStyle(.bordered)
                    }
                    
                    Button(viewModel.currentStep == viewModel.totalSteps - 1 ? "Get Started" : "Next") {
                        viewModel.nextStep()
                    }
                    .buttonStyle(.borderedProminent)
                }
                
                Spacer()
            }
            .padding()
        }
        .frame(width: 500, height: 600)
        .background(Color(.windowBackgroundColor))
    }
}
