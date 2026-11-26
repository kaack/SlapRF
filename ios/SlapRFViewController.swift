import AVFoundation
import Foundation
import UIKit
import UniformTypeIdentifiers
import WebKit
import os.lock

private final class WeakScriptMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) {
        self.target = target
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(userContentController, didReceive: message)
    }
}

/// Low-latency polyphonic triangle-wave crossing beep synthesizer (`48 kHz` `AVAudioEngine` source node)
/// + background silent audio keep-alive so PoE Bridge TCP `:5480` and Pocket LAN `:8090` stay active when the screen locks.
final class SlapRFAudioController: NSObject {
    static let shared = SlapRFAudioController()

    private struct BeepVoice {
        var phaseInc: Double
        var totalSamples: Int
        var attackSamples: Int
        var sustainEnd: Int
        var releaseSamples: Int
        var peakAmp: Float
        var cursor: Int = 0
    }

    private let sampleRate: Double = 48_000.0
    private var voicesLock = os_unfair_lock_s()
    private var activeVoices: [BeepVoice] = []

    private let engine = AVAudioEngine()
    private var sourceNode: AVAudioSourceNode?
    private let synthesizer = AVSpeechSynthesizer()
    private var audioConfigured = false

    private override init() {
        super.init()
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleAudioInterruption(_:)),
            name: AVAudioSession.interruptionNotification,
            object: AVAudioSession.sharedInstance()
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleRouteChange(_:)),
            name: AVAudioSession.routeChangeNotification,
            object: AVAudioSession.sharedInstance()
        )
    }

    func ensureStarted() {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
            try session.setPreferredIOBufferDuration(0.010)
            try session.setActive(true)
        } catch {
            // Non-fatal on headless CI simulator without audio hardware.
        }

        if !audioConfigured {
            audioConfigured = true
            activeVoices.reserveCapacity(8)
            if let fmt = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 1) {
                let node = AVAudioSourceNode(format: fmt) { [weak self] _, _, frameCount, audioBufferList -> OSStatus in
                    guard let self = self else { return noErr }
                    self.renderAudio(frameCount: Int(frameCount), audioBufferList: audioBufferList)
                    return noErr
                }
                sourceNode = node
                engine.attach(node)
                engine.connect(node, to: engine.mainMixerNode, format: fmt)
            }
        }

        if !engine.isRunning {
            do {
                try engine.start()
            } catch {
                // Non-fatal on headless CI simulator.
            }
        }
    }

    @objc private func handleAudioInterruption(_ notification: Notification) {
        guard let info = notification.userInfo,
              let rawType = info[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: rawType) else {
            return
        }
        if type == .ended {
            ensureStarted()
        }
    }

    @objc private func handleRouteChange(_: Notification) {
        if !engine.isRunning {
            ensureStarted()
        }
    }

    private func renderAudio(frameCount: Int, audioBufferList: UnsafeMutablePointer<AudioBufferList>) {
        let abl = UnsafeMutableAudioBufferListPointer(audioBufferList)
        guard let firstBuf = abl.first,
              let rawOut = firstBuf.mData?.assumingMemoryBound(to: Float.self),
              frameCount > 0 else {
            return
        }

        os_unfair_lock_lock(&voicesLock)
        if activeVoices.isEmpty {
            os_unfair_lock_unlock(&voicesLock)
            memset(rawOut, 0, frameCount * MemoryLayout<Float>.size)
            return
        }

        for i in 0..<frameCount {
            var sum: Float = 0.0
            for vIdx in 0..<activeVoices.count {
                let pos = activeVoices[vIdx].cursor
                let total = activeVoices[vIdx].totalSamples
                if pos >= total { continue }
                activeVoices[vIdx].cursor = pos + 1

                let phase = (Double(pos) * activeVoices[vIdx].phaseInc).truncatingRemainder(dividingBy: 1.0)
                let tri = phase < 0.5 ? (4.0 * phase - 1.0) : (3.0 - 4.0 * phase)
                let env: Double
                let attack = activeVoices[vIdx].attackSamples
                let sustainEnd = activeVoices[vIdx].sustainEnd
                if pos < attack {
                    env = Double(pos) / Double(attack)
                } else if pos < sustainEnd {
                    env = 1.0
                } else {
                    let relFrac = min(1.0, Double(pos - sustainEnd) / Double(activeVoices[vIdx].releaseSamples))
                    env = 0.5 * (1.0 + cos(Double.pi * relFrac))
                }
                sum += Float(tri * env) * activeVoices[vIdx].peakAmp
            }
            rawOut[i] = max(-1.0, min(1.0, sum))
        }

        activeVoices.removeAll { $0.cursor >= $0.totalSamples }
        os_unfair_lock_unlock(&voicesLock)

        if abl.count > 1 {
            for ch in 1..<abl.count {
                if let chOut = abl[ch].mData {
                    memcpy(chOut, rawOut, frameCount * MemoryLayout<Float>.size)
                }
            }
        }
    }

    func playBeep(freqHz: Double, durationMs: Int, volume: Float) {
        ensureStarted()
        let safeFreq = max(220.0, min(8000.0, freqHz))
        let safeDurMs = max(80, min(500, durationMs))
        let safeVol = max(0.08, min(1.0, volume))
        let sr = Int(sampleRate)
        let total = max(960, (sr * safeDurMs) / 1000)
        let attack = max(1, (sr * 6) / 1000)
        let release = max(1, (sr * 30) / 1000)
        let sustainEnd = max(attack, total - release)

        let voice = BeepVoice(
            phaseInc: safeFreq / sampleRate,
            totalSamples: total,
            attackSamples: attack,
            sustainEnd: sustainEnd,
            releaseSamples: release,
            peakAmp: 0.55 * safeVol
        )

        os_unfair_lock_lock(&voicesLock)
        if activeVoices.count >= 8 {
            activeVoices.removeFirst()
        }
        activeVoices.append(voice)
        os_unfair_lock_unlock(&voicesLock)
    }

    func speak(text: String, rate: Float, volume: Float, flush: Bool) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        ensureStarted()

        let clampedRate = max(0.5, min(2.5, rate))
        let iosRate: Float
        if clampedRate <= 1.0 {
            iosRate = 0.25 + (clampedRate - 0.5) * 0.50 // 0.5 -> 0.25, 1.0 -> 0.50 (AVSpeechUtteranceDefaultSpeechRate)
        } else {
            iosRate = 0.50 + (clampedRate - 1.0) * (0.22 / 1.5) // 1.0 -> 0.50, 2.5 -> 0.72
        }

        let utt = AVSpeechUtterance(string: trimmed)
        utt.voice = AVSpeechSynthesisVoice(language: "en-US")
        utt.rate = max(AVSpeechUtteranceMinimumSpeechRate, min(AVSpeechUtteranceMaximumSpeechRate, iosRate))
        utt.volume = max(0.0, min(1.0, volume))

        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            if flush && self.synthesizer.isSpeaking {
                self.synthesizer.stopSpeaking(at: .immediate)
            }
            self.synthesizer.speak(utt)
        }
    }

    func stopSpeech() {
        DispatchQueue.main.async { [weak self] in
            self?.synthesizer.stopSpeaking(at: .immediate)
        }
    }

    func isSpeaking() -> Bool {
        if Thread.isMainThread {
            return synthesizer.isSpeaking
        }
        var speaking = false
        DispatchQueue.main.sync {
            speaking = synthesizer.isSpeaking
        }
        return speaking
    }
}

/// Full-screen `WKWebView` controller hosting the embedded SlapRF SPA and bridging native TTS,
/// crossing beeps, Keep-Screen-Awake, status-bar theme sync, LAN Pocket Server, and file export.
final class SlapRFViewController: UIViewController, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
    static let prefLanEnabledKey = "slaprf.ios.lan_enabled"
    private static let syncPromptPrefix = "__slaprf_sync__:"

    private static let darkBg = UIColor(red: 0x0B / 255.0, green: 0x0C / 255.0, blue: 0x0F / 255.0, alpha: 1.0)
    private static let lightBg = UIColor(red: 0xF3 / 255.0, green: 0xF5 / 255.0, blue: 0xF8 / 255.0, alpha: 1.0)

    private let serverURL: String
    private var webView: WKWebView!
    private var isDarkTheme = true
    private var lastPushedKbCssPx: CGFloat = -1.0

    init(serverURL: String) {
        self.serverURL = serverURL
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder _: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override var preferredStatusBarStyle: UIStatusBarStyle {
        return isDarkTheme ? .lightContent : .darkContent
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Self.darkBg

        let userController = WKUserContentController()
        userController.add(WeakScriptMessageHandler(self), name: "slaprf")
        let bridgeScript = WKUserScript(
            source: Self.injectedBridgeJavaScript,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        userController.addUserScript(bridgeScript)

        let cfg = WKWebViewConfiguration()
        cfg.userContentController = userController
        cfg.allowsInlineMediaPlayback = true
        cfg.mediaTypesRequiringUserActionForPlayback = []

        let wv = WKWebView(frame: .zero, configuration: cfg)
        wv.translatesAutoresizingMaskIntoConstraints = false
        wv.isOpaque = false
        wv.backgroundColor = Self.darkBg
        wv.scrollView.backgroundColor = Self.darkBg
        wv.scrollView.contentInsetAdjustmentBehavior = .never
        wv.scrollView.bounces = false
        wv.navigationDelegate = self
        wv.uiDelegate = self
        if #available(iOS 16.4, *) {
            wv.isInspectable = true
        }
        self.webView = wv

        view.addSubview(wv)
        NSLayoutConstraint.activate([
            wv.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            wv.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            wv.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            wv.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
        ])

        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleKeyboardWillChangeFrame(_:)),
            name: UIResponder.keyboardWillChangeFrameNotification,
            object: nil
        )

        if let url = URL(string: serverURL) {
            let req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15.0)
            wv.load(req)
        }
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    private func applyTheme(dark: Bool) {
        isDarkTheme = dark
        let bg = dark ? Self.darkBg : Self.lightBg
        view.backgroundColor = bg
        view.window?.backgroundColor = bg
        webView?.backgroundColor = bg
        webView?.scrollView.backgroundColor = bg
        setNeedsStatusBarAppearanceUpdate()
    }

    @objc private func handleKeyboardWillChangeFrame(_ notification: Notification) {
        guard let info = notification.userInfo,
              let endFrameVal = info[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue else {
            return
        }
        let endFrameInView = view.convert(endFrameVal.cgRectValue, from: nil)
        let overlap = max(0.0, view.bounds.maxY - endFrameInView.minY - view.safeAreaInsets.bottom)
        let durationSec = (info[UIResponder.keyboardAnimationDurationUserInfoKey] as? NSNumber)?.doubleValue ?? 0.25
        let durationMs = max(0, Int((durationSec * 1000.0).rounded()))
        let showing = overlap > 1.0

        if durationMs == 0 && abs(overlap - lastPushedKbCssPx) < 0.25 {
            return
        }
        lastPushedKbCssPx = overlap
        let js = String(
            format: "if(window.__slaprfSetKbOffset)window.__slaprfSetKbOffset(%.2f,%d,%@);",
            overlap,
            durationMs,
            showing ? "true" : "false"
        )
        webView?.evaluateJavaScript(js, completionHandler: nil)
    }

    // MARK: - Native Go C String Helpers

    static func callGoString(_ ptr: UnsafeMutablePointer<CChar>?) -> String {
        guard let ptr = ptr else { return "" }
        defer { SlapRFFreeString(ptr) }
        return String(cString: ptr)
    }

    static func getLanStatusJson() -> String {
        return callGoString(SlapRFGetLanStatusJson())
    }

    static func setLanEnabled(_ enabled: Bool) -> String {
        UserDefaults.standard.set(enabled, forKey: prefLanEnabledKey)
        return callGoString(SlapRFSetLanEnabled(enabled ? 1 : 0))
    }

    // MARK: - WKScriptMessageHandler (Async Fire-and-Forget Bridge)

    func userContentController(_: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "slaprf",
              let body = message.body as? [String: Any],
              let op = body["op"] as? String else {
            return
        }

        switch op {
        case "speak":
            let text = (body["text"] as? String) ?? ""
            let rate = (body["rate"] as? NSNumber)?.floatValue ?? 1.0
            let volume = (body["volume"] as? NSNumber)?.floatValue ?? 1.0
            let flush = (body["flush"] as? Bool) ?? false
            SlapRFAudioController.shared.speak(text: text, rate: rate, volume: volume, flush: flush)

        case "stopSpeech":
            SlapRFAudioController.shared.stopSpeech()

        case "playBeep":
            let freq = (body["freqHz"] as? NSNumber)?.doubleValue ?? 880.0
            let dur = (body["durationMs"] as? NSNumber)?.intValue ?? 140
            let vol = (body["volume"] as? NSNumber)?.floatValue ?? 0.8
            SlapRFAudioController.shared.playBeep(freqHz: freq, durationMs: dur, volume: vol)

        case "setKeepScreenOn":
            let enabled = (body["enabled"] as? Bool) ?? false
            UIApplication.shared.isIdleTimerDisabled = enabled

        case "setThemeMode":
            let mode = (body["mode"] as? String) ?? "dark"
            applyTheme(dark: mode.lowercased() != "light")

        case "setStringPref":
            if let key = body["key"] as? String {
                let clean = key.trimmingCharacters(in: .whitespacesAndNewlines)
                if !clean.isEmpty {
                    let val = (body["value"] as? String) ?? ""
                    UserDefaults.standard.set(val, forKey: "slaprf.web." + clean)
                }
            }

        case "saveBase64File":
            let filename = (body["filename"] as? String) ?? "slaprf-export.json"
            let base64 = (body["base64Data"] as? String) ?? ""
            exportBase64File(filename: filename, base64Data: base64)

        default:
            break
        }
    }

    private func exportBase64File(filename: String, base64Data: String) {
        guard !base64Data.isEmpty,
              let data = Data(base64Encoded: base64Data, options: [.ignoreUnknownCharacters]) else {
            return
        }
        let rawName = (filename as NSString).lastPathComponent.trimmingCharacters(in: .whitespacesAndNewlines)
        let safeName = rawName.isEmpty ? "slaprf-export.json" : rawName
        let exportDir = FileManager.default.temporaryDirectory.appendingPathComponent("slaprf-exports", isDirectory: true)
        try? FileManager.default.createDirectory(at: exportDir, withIntermediateDirectories: true)
        let fileURL = exportDir.appendingPathComponent(safeName)
        do {
            try data.write(to: fileURL, options: .atomic)
        } catch {
            return
        }

        let picker = UIDocumentPickerViewController(forExporting: [fileURL], asCopy: true)
        if let pop = picker.popoverPresentationController {
            pop.sourceView = view
            pop.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1)
            pop.permittedArrowDirections = []
        }
        present(picker, animated: true)
    }

    // MARK: - WKUIDelegate (Sync Prompt Bridge + Standard Dialogs + target="_blank")

    func webView(
        _: WKWebView,
        runJavaScriptTextInputPanelWithPrompt prompt: String,
        defaultText: String?,
        initiatedByFrame _: WKFrameInfo,
        completionHandler: @escaping (String?) -> Void
    ) {
        if prompt.hasPrefix(Self.syncPromptPrefix) {
            let jsonStr = String(prompt.dropFirst(Self.syncPromptPrefix.count))
            guard let data = jsonStr.data(using: .utf8),
                  let payload = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  let op = payload["op"] as? String else {
                completionHandler("")
                return
            }
            switch op {
            case "getLanStatusJson":
                completionHandler(Self.getLanStatusJson())
            case "setLanEnabled":
                let enabled = (payload["enabled"] as? Bool) ?? false
                completionHandler(Self.setLanEnabled(enabled))
            case "getStringPref":
                let key = ((payload["key"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                if key.isEmpty {
                    completionHandler("")
                } else {
                    completionHandler(UserDefaults.standard.string(forKey: "slaprf.web." + key) ?? "")
                }
            case "isSpeaking":
                completionHandler(SlapRFAudioController.shared.isSpeaking() ? "1" : "0")
            default:
                completionHandler("")
            }
            return
        }

        let alert = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
        alert.addTextField { tf in tf.text = defaultText }
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(nil) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in
            completionHandler(alert.textFields?.first?.text ?? "")
        })
        present(alert, animated: true)
    }

    func webView(
        _: WKWebView,
        runJavaScriptAlertPanelWithMessage message: String,
        initiatedByFrame _: WKFrameInfo,
        completionHandler: @escaping () -> Void
    ) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        present(alert, animated: true)
    }

    func webView(
        _: WKWebView,
        runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame _: WKFrameInfo,
        completionHandler: @escaping (Bool) -> Void
    ) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        present(alert, animated: true)
    }

    func webView(
        _: WKWebView,
        createWebViewWith _: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures _: WKWindowFeatures
    ) -> WKWebView? {
        if let url = navigationAction.request.url {
            UIApplication.shared.open(url, options: [:], completionHandler: nil)
        }
        return nil
    }

    // MARK: - WKNavigationDelegate

    func webView(
        _: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.allow)
            return
        }
        let scheme = (url.scheme ?? "").lowercased()
        if scheme != "http" && scheme != "https" {
            if scheme == "about" || scheme == "blob" || scheme == "data" {
                decisionHandler(.allow)
            } else {
                UIApplication.shared.open(url, options: [:], completionHandler: nil)
                decisionHandler(.cancel)
            }
            return
        }
        let host = (url.host ?? "").lowercased()
        if host == "127.0.0.1" || host == "localhost" {
            decisionHandler(.allow)
            return
        }
        UIApplication.shared.open(url, options: [:], completionHandler: nil)
        decisionHandler(.cancel)
    }

    private static let injectedBridgeJavaScript: String = """
    (function() {
      if (window.SlapRFNative) return;
      function post(msg) {
        try {
          if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.slaprf) {
            window.webkit.messageHandlers.slaprf.postMessage(msg);
          }
        } catch (e) {}
      }
      function syncCall(msg) {
        try {
          var res = window.prompt("__slaprf_sync__:" + JSON.stringify(msg), "");
          return typeof res === "string" ? res : "";
        } catch (e) {
          return "";
        }
      }
      var bridge = {
        platform: "ios",
        isAndroidApp: function() { return true; },
        isIosApp: function() { return true; },
        speak: function(text, rate, volume, flush) {
          post({ op: "speak", text: String(text || ""), rate: Number(rate || 1), volume: Number(volume ?? 1), flush: Boolean(flush) });
        },
        stopSpeech: function() { post({ op: "stopSpeech" }); },
        isSpeaking: function() { return syncCall({ op: "isSpeaking" }) === "1"; },
        playBeep: function(freqHz, durationMs, volume) {
          post({ op: "playBeep", freqHz: Number(freqHz || 880), durationMs: Number(durationMs || 140), volume: Number(volume ?? 0.8) });
        },
        setKeepScreenOn: function(enabled) { post({ op: "setKeepScreenOn", enabled: Boolean(enabled) }); },
        setThemeMode: function(mode) { post({ op: "setThemeMode", mode: String(mode || "dark") }); },
        getLanStatusJson: function() { return syncCall({ op: "getLanStatusJson" }); },
        setLanEnabled: function(enabled) { return syncCall({ op: "setLanEnabled", enabled: Boolean(enabled) }); },
        getStringPref: function(key) { return syncCall({ op: "getStringPref", key: String(key || "") }); },
        setStringPref: function(key, value) { post({ op: "setStringPref", key: String(key || ""), value: String(value ?? "") }); },
        saveBase64File: function(filename, mimeType, base64Data) {
          post({ op: "saveBase64File", filename: String(filename || ""), mimeType: String(mimeType || ""), base64Data: String(base64Data || "") });
        }
      };
      window.SlapRFNative = bridge;
      window.SlapRFAndroid = bridge;
    })();
    """
}
