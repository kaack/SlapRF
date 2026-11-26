import Darwin
import Foundation
import UIKit

@main
final class SlapRFAppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    private static func resolveStorageDirectory() -> String {
        let fm = FileManager.default
        let appSupport = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? fm.urls(for: .documentDirectory, in: .userDomainMask).first!
        let dir = appSupport.appendingPathComponent("SlapRF", isDirectory: true)
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        var rv = URLResourceValues()
        rv.isExcludedFromBackup = false
        var mutableDir = dir
        try? mutableDir.setResourceValues(rv)
        return dir.path
    }

    private static func resolveVersionString() -> String {
        if let ver = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String,
           !ver.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            let clean = ver.trimmingCharacters(in: .whitespacesAndNewlines)
            return clean.hasPrefix("v") ? clean : "v" + clean
        }
        return "v0.0.19"
    }

    private static func startEmbeddedGoServer() -> String {
        let dirPath = resolveStorageDirectory()
        let version = resolveVersionString()
        let lanEnabled = UserDefaults.standard.bool(forKey: SlapRFViewController.prefLanEnabledKey)

        let cDir = strdup(dirPath)
        let cVer = strdup(version)
        defer {
            if let cDir = cDir { free(cDir) }
            if let cVer = cVer { free(cVer) }
        }
        return SlapRFViewController.callGoString(
            SlapRFStartServer(cDir, cVer, lanEnabled ? 1 : 0)
        )
    }

    func application(
        _: UIApplication,
        didFinishLaunchingWithOptions _: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        SlapRFBleShim.registerWithGoBridge()
        SlapRFAudioController.shared.ensureStarted()

        let serverURL = Self.startEmbeddedGoServer()
        let win = UIWindow(frame: UIScreen.main.bounds)
        win.backgroundColor = UIColor(red: 0x0B / 255.0, green: 0x0C / 255.0, blue: 0x0F / 255.0, alpha: 1.0)
        win.rootViewController = SlapRFViewController(serverURL: serverURL)
        win.makeKeyAndVisible()
        self.window = win
        return true
    }

    func applicationDidBecomeActive(_: UIApplication) {
        SlapRFAudioController.shared.ensureStarted()
        _ = Self.startEmbeddedGoServer()
    }

    func applicationWillTerminate(_: UIApplication) {
        SlapRFStopServer()
    }
}
