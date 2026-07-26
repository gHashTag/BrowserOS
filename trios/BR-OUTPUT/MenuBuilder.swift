import Cocoa
import SwiftUI

extension Notification.Name {
    static let exportSessionRecoveryPackage = Notification.Name("trios.exportSessionRecoveryPackage")
    static let importSessionRecoveryPackage = Notification.Name("trios.importSessionRecoveryPackage")
}

@MainActor
enum ApplicationMenuInstaller {
    static func install(delegate: AppDelegate) {
        let mainMenu = NSMenu(title: "Main Menu")
        mainMenu.addItem(applicationMenuItem(delegate: delegate))
        mainMenu.addItem(editMenuItem())
        NSApplication.shared.mainMenu = mainMenu
    }

    private static func applicationMenuItem(delegate: AppDelegate) -> NSMenuItem {
        let rootItem = NSMenuItem()
        let menu = NSMenu(title: "TRIOS")

        let aboutItem = NSMenuItem(
            title: "About TRIOS",
            action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)),
            keyEquivalent: ""
        )
        aboutItem.target = NSApplication.shared
        menu.addItem(aboutItem)
        menu.addItem(.separator())

        let recoveryItem = NSMenuItem(
            title: "Export Session Recovery Package...",
            action: #selector(AppDelegate.exportSessionRecoveryPackage(_:)),
            keyEquivalent: "e"
        )
        recoveryItem.keyEquivalentModifierMask = [.command, .shift]
        recoveryItem.target = delegate
        menu.addItem(recoveryItem)

        let importItem = NSMenuItem(
            title: "Import Session Recovery Package...",
            action: #selector(AppDelegate.importSessionRecoveryPackage(_:)),
            keyEquivalent: "i"
        )
        importItem.keyEquivalentModifierMask = [.command, .shift]
        importItem.target = delegate
        menu.addItem(importItem)
        menu.addItem(.separator())

        let hideItem = NSMenuItem(
            title: "Hide TRIOS",
            action: #selector(NSApplication.hide(_:)),
            keyEquivalent: "h"
        )
        hideItem.target = NSApplication.shared
        menu.addItem(hideItem)

        let hideOthersItem = NSMenuItem(
            title: "Hide Others",
            action: #selector(NSApplication.hideOtherApplications(_:)),
            keyEquivalent: "h"
        )
        hideOthersItem.keyEquivalentModifierMask = [.command, .option]
        hideOthersItem.target = NSApplication.shared
        menu.addItem(hideOthersItem)

        let showAllItem = NSMenuItem(
            title: "Show All",
            action: #selector(NSApplication.unhideAllApplications(_:)),
            keyEquivalent: ""
        )
        showAllItem.target = NSApplication.shared
        menu.addItem(showAllItem)
        menu.addItem(.separator())

        let quitItem = NSMenuItem(
            title: "Quit TRIOS",
            action: #selector(NSApplication.terminate(_:)),
            keyEquivalent: "q"
        )
        quitItem.target = NSApplication.shared
        menu.addItem(quitItem)

        rootItem.submenu = menu
        return rootItem
    }

    private static func editMenuItem() -> NSMenuItem {
        let rootItem = NSMenuItem()
        let menu = NSMenu(title: "Edit")

        menu.addItem(responderItem(title: "Undo", action: Selector(("undo:")), key: "z"))
        menu.addItem(
            responderItem(
                title: "Redo",
                action: Selector(("redo:")),
                key: "z",
                modifiers: [.command, .shift]
            )
        )
        menu.addItem(.separator())
        menu.addItem(responderItem(title: "Cut", action: #selector(NSText.cut(_:)), key: "x"))
        menu.addItem(responderItem(title: "Copy", action: #selector(NSText.copy(_:)), key: "c"))
        menu.addItem(responderItem(title: "Paste", action: #selector(NSText.paste(_:)), key: "v"))
        menu.addItem(.separator())
        menu.addItem(responderItem(title: "Select All", action: #selector(NSText.selectAll(_:)), key: "a"))

        rootItem.submenu = menu
        return rootItem
    }

    private static func responderItem(
        title: String,
        action: Selector,
        key: String,
        modifiers: NSEvent.ModifierFlags = [.command]
    ) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.keyEquivalentModifierMask = modifiers
        item.target = nil
        return item
    }
}

/// Builds the status bar menu dynamically based on current state.
@MainActor
final class MenuBuilder {
    private weak var delegate: AppDelegate?
    private let screenManager: TriosScreenManager
    private let serverManager: ServerManager

    init(delegate: AppDelegate, screenManager: TriosScreenManager, serverManager: ServerManager) {
        self.delegate = delegate
        self.screenManager = screenManager
        self.serverManager = serverManager
    }

    func buildMenu() -> NSMenu {
        let menu = NSMenu()

        // Server / Funnel toggles
        let serverItem = NSMenuItem(
            title: serverManager.serverRunning ? "Stop Server" : "Start Server",
            action: #selector(AppDelegate.toggleServer),
            keyEquivalent: ""
        )
        serverItem.target = delegate
        menu.addItem(serverItem)

        let funnelItem = NSMenuItem(
            title: serverManager.funnelRunning ? "Stop Funnel" : "Start Funnel",
            action: #selector(AppDelegate.toggleFunnel),
            keyEquivalent: ""
        )
        funnelItem.target = delegate
        menu.addItem(funnelItem)

        menu.addItem(NSMenuItem.separator())

        // Status text
        let statusItemMenu = NSMenuItem(title: statusText(), action: nil, keyEquivalent: "")
        statusItemMenu.isEnabled = false
        menu.addItem(statusItemMenu)

        menu.addItem(NSMenuItem.separator())

        // Panel toggle
        let sidePanelItem = NSMenuItem(
            title: "Toggle Sidebar",
            action: #selector(AppDelegate.toggleSidePanel),
            keyEquivalent: ""
        )
        sidePanelItem.target = delegate
        menu.addItem(sidePanelItem)

        // URLs
        let openLocalItem = NSMenuItem(
            title: "Open \(ProjectPaths.mcpBaseURL)",
            action: #selector(AppDelegate.openLocal),
            keyEquivalent: ""
        )
        openLocalItem.target = delegate
        menu.addItem(openLocalItem)

        let openPublicItem = NSMenuItem(
            title: "Open Public URL",
            action: #selector(AppDelegate.openPublic),
            keyEquivalent: ""
        )
        openPublicItem.target = delegate
        menu.addItem(openPublicItem)

        menu.addItem(NSMenuItem.separator())

        // Panel Mode submenu
        let modeMenu = NSMenu(title: "Panel Mode")
        for (index, mode) in TriosPanelMode.allCases.enumerated() {
            let item = NSMenuItem(title: mode.rawValue, action: #selector(AppDelegate.setPanelMode(_:)), keyEquivalent: "")
            item.tag = index
            item.target = delegate
            item.state = (mode == screenManager.panelMode) ? .on : .off
            modeMenu.addItem(item)
        }
        let modeItem = NSMenuItem(title: "Panel Mode", action: nil, keyEquivalent: "")
        modeItem.submenu = modeMenu
        menu.addItem(modeItem)

        // Move to Screen submenu
        let screenMenu = NSMenu(title: "Move to Screen")
        for (index, screen) in NSScreen.screens.enumerated() {
            let name = screen.displayName ?? "Screen \(index + 1)"
            let item = NSMenuItem(title: name, action: #selector(AppDelegate.moveToScreen(_:)), keyEquivalent: "")
            item.tag = index
            item.target = delegate
            screenMenu.addItem(item)
        }
        let screenItem = NSMenuItem(title: "Move to Screen", action: nil, keyEquivalent: "")
        screenItem.submenu = screenMenu
        menu.addItem(screenItem)

        menu.addItem(NSMenuItem.separator())

        // MCP Connect
        let connectItem = NSMenuItem(
            title: "Connect MCP",
            action: #selector(AppDelegate.connectMCP),
            keyEquivalent: ""
        )
        connectItem.target = delegate
        menu.addItem(connectItem)

        menu.addItem(NSMenuItem.separator())

        // Clean Capture
        let cleanCaptureItem = NSMenuItem(
            title: "Clean Capture Mode",
            action: #selector(AppDelegate.toggleCleanCaptureMode),
            keyEquivalent: ""
        )
        cleanCaptureItem.target = delegate
        menu.addItem(cleanCaptureItem)

        menu.addItem(NSMenuItem.separator())

        // Quit
        let quitItem = NSMenuItem(
            title: "Quit",
            action: #selector(AppDelegate.quit),
            keyEquivalent: "q"
        )
        quitItem.target = delegate
        menu.addItem(quitItem)

        return menu
    }

    func statusText() -> String {
        var parts: [String] = []
        if serverManager.serverRunning { parts.append("Server: ON") }
        if serverManager.funnelRunning { parts.append("Funnel: ON") }
        return parts.isEmpty ? "Status: Idle" : parts.joined(separator: " | ")
    }
}
