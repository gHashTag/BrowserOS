import Foundation

/// Context-length-aware routing logic extracted from ModelConfigurationStore.
///
/// Decides whether to use the current model, route to a larger-context
/// healthy candidate, trim history, or refuse the request before any provider
/// call is made.
extension ModelConfigurationStore {

    // MARK: - Context routing keys

    static var contextWindowMarginKey: String { "trios.model.context-window-margin" }
    static var streamingContextWatchdogKey: String { "trios.model.streaming-context-watchdog" }
    static var requestedOutputTokensKey: String { "trios.model.requested-output-tokens" }

    // MARK: - Context routing decision

    func resolveContextRoutingDecision(
        conversationId: UUID?,
        messages: [ChatMessage],
        currentMessage: ChatMessage,
        systemPrompt: String?,
        requestedOutputTokens: Int?,
        candidates: [CrossProviderModelCandidate],
        margin: Double? = nil,
        constrainedTo constraint: ConversationModelConstraint? = nil
    ) async -> ContextRoutingDecision {
        let effectiveMargin = margin ?? contextWindowMargin
        let currentProfile = await contextService.profile(
            for: selectedModel,
            provider: selectedProvider,
            baseURL: baseURL
        )
        let currentSize = await requestSizer.size(
            messages: messages,
            currentMessage: currentMessage,
            systemPrompt: systemPrompt,
            modelProfile: currentProfile,
            requestedOutputTokens: requestedOutputTokens,
            margin: effectiveMargin
        )
        lastContextEstimatedInputTokens = currentSize.estimatedInputTokens
        lastContextRequestedOutputTokens = currentSize.requestedOutputTokens

        let current = CrossProviderModelCandidate(
            provider: selectedProvider,
            baseURL: baseURL,
            model: selectedModel
        )

        let effectiveCandidates: [CrossProviderModelCandidate] = {
            if let constraint {
                return candidates.filter { $0 == constraint.candidate }
            }
            return candidates
        }()

        if currentSize.fitsCurrentModel,
           let rawRequested = requestedOutputTokens,
           rawRequested > currentProfile.maxOutputTokens {
            let outputCandidates = await contextService.largerOutputCandidates(
                estimatedInput: currentSize.estimatedInputTokens,
                outputTokens: rawRequested,
                current: current,
                candidates: effectiveCandidates,
                margin: effectiveMargin
            )
            for candidate in outputCandidates {
                guard await isCandidateAllowed(candidate) else { continue }
                let routedProfile = await contextService.profile(
                    for: candidate.model,
                    provider: candidate.provider,
                    baseURL: candidate.baseURL
                )
                let routedSize = await requestSizer.size(
                    messages: messages,
                    currentMessage: currentMessage,
                    systemPrompt: systemPrompt,
                    modelProfile: routedProfile,
                    requestedOutputTokens: requestedOutputTokens,
                    margin: effectiveMargin
                )
                guard routedSize.fitsCurrentModel else { continue }
                lastContextEstimatedInputTokens = routedSize.estimatedInputTokens
                lastContextRequestedOutputTokens = routedSize.requestedOutputTokens
                lastContextRoutingReason = "routed to \(candidate.model) for output budget (\(routedProfile.maxOutputTokens) tokens)"
                return .routeTo(candidate)
            }
            return .useCurrent
        }

        if currentSize.fitsCurrentModel {
            return .useCurrent
        }

        let largerCandidates = await contextService.largerModelCandidates(
            estimatedInput: currentSize.estimatedInputTokens,
            outputTokens: currentSize.requestedOutputTokens,
            current: current,
            candidates: effectiveCandidates,
            margin: effectiveMargin
        )
        for candidate in largerCandidates {
            if await isCandidateAllowed(candidate) {
                let routedProfile = await contextService.profile(
                    for: candidate.model,
                    provider: candidate.provider,
                    baseURL: candidate.baseURL
                )
                let routedSize = await requestSizer.size(
                    messages: messages,
                    currentMessage: currentMessage,
                    systemPrompt: systemPrompt,
                    modelProfile: routedProfile,
                    requestedOutputTokens: requestedOutputTokens,
                    margin: effectiveMargin
                )
                lastContextEstimatedInputTokens = routedSize.estimatedInputTokens
                lastContextRequestedOutputTokens = routedSize.requestedOutputTokens
                lastContextRoutingReason = "routed to \(candidate.model) for context window (\(routedProfile.maxContextTokens) tokens)"
                return .routeTo(candidate)
            }
        }

        let trimPolicy = await requestSizer.trim(
            messages: messages,
            currentMessage: currentMessage,
            systemPrompt: systemPrompt,
            modelProfile: currentProfile,
            requestedOutputTokens: requestedOutputTokens,
            margin: effectiveMargin,
            minRetainedTurns: 2
        )
        let trimmedMessages = await requestSizer.trimmedMessages(from: messages, policy: trimPolicy)
        let trimmedSize = await requestSizer.size(
            messages: trimmedMessages,
            currentMessage: currentMessage,
            systemPrompt: systemPrompt,
            modelProfile: currentProfile,
            requestedOutputTokens: requestedOutputTokens,
            margin: effectiveMargin
        )
        if trimmedSize.fitsCurrentModel {
            lastContextEstimatedInputTokens = trimmedSize.estimatedInputTokens
            lastContextRequestedOutputTokens = trimmedSize.requestedOutputTokens
            return .trimHistory(trimPolicy)
        }

        let largestWindow = await maxAvailableWindow(
            candidates: effectiveCandidates,
            current: current,
            currentProfile: currentProfile
        )
        let largestProfile = ModelContextProfile(
            maxContextTokens: largestWindow,
            maxOutputTokens: currentProfile.maxOutputTokens
        )
        let singleMessageSize = await requestSizer.size(
            messages: [],
            currentMessage: currentMessage,
            systemPrompt: systemPrompt,
            modelProfile: largestProfile,
            requestedOutputTokens: requestedOutputTokens,
            margin: effectiveMargin
        )
        if !singleMessageSize.fitsCurrentModel {
            return .tooLargeEvenEmpty
        }

        return .trimHistory(trimPolicy)
    }

    func applyContextRoutedSelection(candidate: CrossProviderModelCandidate, reason: String) {
        applySelection(
            provider: candidate.provider,
            baseURL: candidate.baseURL,
            model: candidate.model
        )
        lastContextRoutingReason = reason
        lastContextRoutedAt = Date()
    }

    func selectLargerModelCandidate(
        estimatedInput: Int,
        outputTokens: Int = 1024,
        constrainedTo constraint: ConversationModelConstraint? = nil
    ) async -> CrossProviderModelCandidate? {
        let current = CrossProviderModelCandidate(
            provider: selectedProvider,
            baseURL: baseURL,
            model: selectedModel
        )
        let candidates = warmupCandidates(constrainedTo: constraint)
        var allowed: [CrossProviderModelCandidate] = []
        for candidate in candidates {
            if await isCandidateAllowed(candidate) {
                allowed.append(candidate)
            }
        }
        return await contextService.largerModelCandidates(
            estimatedInput: estimatedInput,
            outputTokens: outputTokens,
            current: current,
            candidates: allowed,
            margin: contextWindowMargin
        ).first
    }

    // MARK: - Context routing helpers

    func isCandidateAllowed(_ candidate: CrossProviderModelCandidate) async -> Bool {
        guard !isUnhealthy(
            provider: candidate.provider,
            baseURL: candidate.baseURL,
            model: candidate.model
        ) else { return false }
        let key = ProviderEndpointKey(provider: candidate.provider, baseURL: candidate.baseURL)
        guard await circuitBreaker.canSend(to: key) else { return false }
        let quota = await quotaService.status(for: candidate.provider, baseURL: candidate.baseURL)
        return !quota.isDepleted
    }

    func maxAvailableWindow(
        candidates: [CrossProviderModelCandidate],
        current: CrossProviderModelCandidate,
        currentProfile: ModelContextProfile
    ) async -> Int {
        var maxWindow = currentProfile.maxContextTokens
        for candidate in candidates {
            guard candidate != current else { continue }
            guard await isCandidateAllowed(candidate) else { continue }
            let profile = await contextService.profile(
                for: candidate.model,
                provider: candidate.provider,
                baseURL: candidate.baseURL
            )
            if profile.maxContextTokens > maxWindow {
                maxWindow = profile.maxContextTokens
            }
        }
        return maxWindow
    }

    // MARK: - Context window preferences

    func loadContextWindowMargin() {
        let stored = defaults.object(forKey: Self.contextWindowMarginKey) as? Double ?? 0.85
        contextWindowMargin = max(0.50, min(0.95, stored))
    }

    func setContextWindowMargin(_ margin: Double) {
        contextWindowMargin = max(0.50, min(0.95, margin))
        defaults.set(contextWindowMargin, forKey: Self.contextWindowMarginKey)
    }

    func loadStreamingContextWatchdogPreference() {
        isStreamingContextWatchdogEnabled = defaults.object(forKey: Self.streamingContextWatchdogKey) as? Bool ?? true
    }

    func setStreamingContextWatchdogEnabled(_ enabled: Bool) {
        isStreamingContextWatchdogEnabled = enabled
        defaults.set(enabled, forKey: Self.streamingContextWatchdogKey)
    }

    func loadRequestedOutputTokens() {
        let stored = defaults.object(forKey: Self.requestedOutputTokensKey) as? Int
        requestedOutputTokens = stored.map { max(0, $0) }
    }

    func setRequestedOutputTokens(_ tokens: Int?) {
        requestedOutputTokens = tokens.map { max(0, $0) }
        if let tokens {
            defaults.set(tokens, forKey: Self.requestedOutputTokensKey)
        } else {
            defaults.removeObject(forKey: Self.requestedOutputTokensKey)
        }
    }

    func clearRequestedOutputTokens() {
        setRequestedOutputTokens(nil)
    }

    func effectiveMaxOutputTokens(
        for model: String,
        provider: ModelProvider,
        baseURL: String? = nil
    ) async -> Int {
        let profile = await contextService.profile(
            for: model,
            provider: provider,
            baseURL: baseURL ?? self.baseURL
        )
        return profile.maxOutputTokens
    }

    func effectiveRequestedOutputTokens(
        for model: String,
        provider: ModelProvider,
        baseURL: String? = nil
    ) async -> Int? {
        guard let requested = requestedOutputTokens else { return nil }
        let ceiling = await effectiveMaxOutputTokens(for: model, provider: provider, baseURL: baseURL)
        return min(requested, ceiling)
    }

    func learnedLimits(
        for model: String,
        provider: ModelProvider,
        baseURL: String? = nil
    ) async -> StreamingContextLearnedLimits {
        await contextLimitLearner.learnedLimits(
            for: model,
            provider: provider,
            baseURL: baseURL ?? self.baseURL
        )
    }

    func contextWindowUtilizationPercent(
        for model: String,
        provider: ModelProvider,
        baseURL: String? = nil
    ) async -> Double? {
        guard let input = lastContextEstimatedInputTokens, input >= 0 else {
            return nil
        }
        let output = lastContextRequestedOutputTokens ?? 0
        let resolvedBaseURL = baseURL ?? self.baseURL
        let profile = await contextService.profile(
            for: model,
            provider: provider,
            baseURL: resolvedBaseURL
        )
        guard profile.maxContextTokens > 0 else { return nil }
        let usable = Double(profile.maxContextTokens) * contextWindowMargin
        guard usable > 0 else { return nil }
        return Double(input + output) / usable * 100.0
    }
}
