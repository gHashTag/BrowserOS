// FIXTURE - deliberately broken. Not compiled, not linked, only grepped.
//
// main.swift's boot sequence with the single-instance guard deleted. The
// run loop still starts, so nothing fails to compile; two trios processes
// then fight over the same lock files, ports and menu-bar item.
//
// The AppDelegate copy of the guard is left in place on purpose. The check
// must read the boot site, not merely ask whether the string occurs
// somewhere in the file - a guard in the wrong function is not a guard.
//
// `make guard-shapes` must reject this file.

    func applicationDidFinishLaunching(_ notification: Notification) {
        // SAFETY: Prevent recursive self-launch - enforce single instance
        guard RecursionGuard.shared.ensureSingleInstance() else {
            NSLog("applicationDidFinishLaunching: another instance is running")
            NSApplication.shared.terminate(nil)
            return
        }
        NSLog("applicationDidFinishLaunching called")
        NSApplication.shared.setActivationPolicy(.regular)
        NSApplication.shared.activate(ignoringOtherApps: true)
        ApplicationMenuInstaller.install(delegate: self)
        setupStatusItem()
        LogRotationPolicy.rotateAuditLogs()
        AuditRotationScheduler.shared.start()
    }

    func applicationWillTerminate(_ notification: Notification) {
        RecursionGuard.shared.cleanup()
    }
}

// MARK: - Boot Sequence

MainActor.assumeIsolated {
    let delegate = AppDelegate()
    NSApplication.shared.delegate = delegate
    NSApplication.shared.run()
}
