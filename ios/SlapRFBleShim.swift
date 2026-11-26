import CoreBluetooth
import Darwin
import Foundation

/// Native CoreBluetooth GATT byte-stream shim for SlapRF Bluetooth Hub (`slaprf-xiao-c5-ble.bin`).
/// Mirrors `android/java/app/slaprf/SlapRFBleShim.java` so Go treats `ble:<FP8HEX>` ports identically
/// to USB/serial streams while all framing, `STATUS?` probing, and `0xC5` decoding run in Go.
final class SlapRFBleShim: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    static let shared = SlapRFBleShim()

    private static let portPrefix = "ble:"
    private static let serviceUUID = CBUUID(string: "5d1a0001-5a7e-4c0b-9e5f-534c41505246")
    private static let rxCharUUID = CBUUID(string: "5d1a0002-5a7e-4c0b-9e5f-534c41505246")
    private static let txCharUUID = CBUUID(string: "5d1a0003-5a7e-4c0b-9e5f-534c41505246")

    private static let scanWindowSec: TimeInterval = 4.0
    private static let scanRefreshSec: TimeInterval = 8.0
    private static let seenTTLSec: TimeInterval = 30.0
    private static let firstListWaitSec: TimeInterval = 1.5
    private static let openScanTimeoutSec: TimeInterval = 8.0
    private static let connectTimeoutSec: TimeInterval = 10.0
    private static let txReadyTimeoutSec: TimeInterval = 1.5
    private static let maxBufferedRx = 65536

    private struct SeenHub {
        var fp: String
        var peripheral: CBPeripheral
        var name: String
        var role: Int
        var hasFlags: Bool
        var paired: Bool
        var hasMfgData: Bool
        var seenAt: TimeInterval
    }

    private final class Session {
        let handle: Int32
        let fp: String
        let peripheral: CBPeripheral

        var rxChar: CBCharacteristic?
        var txChar: CBCharacteristic?
        var closed = false
        var ready = false
        var failure: String?

        let openSem = DispatchSemaphore(value: 0)
        let writeLock = NSLock()
        let txReadySem = DispatchSemaphore(value: 0)

        let rxCond = NSCondition()
        var rxBuf = [UInt8](repeating: 0, count: SlapRFBleShim.maxBufferedRx)
        var rxHead = 0
        var rxLen = 0

        init(handle: Int32, fp: String, peripheral: CBPeripheral) {
            self.handle = handle
            self.fp = fp
            self.peripheral = peripheral
        }

        func fail(_ msg: String) {
            rxCond.lock()
            if failure == nil {
                failure = msg
            }
            ready = false
            rxCond.broadcast()
            rxCond.unlock()
            openSem.signal()
            txReadySem.signal()
        }

        func markReady() {
            rxCond.lock()
            ready = true
            rxCond.unlock()
            openSem.signal()
        }

        func appendRx(_ data: Data) {
            guard !data.isEmpty else { return }
            rxCond.lock()
            defer { rxCond.unlock() }
            if closed { return }

            let count = data.count
            let cap = rxBuf.count
            if count >= cap {
                data.suffix(cap).copyBytes(to: &rxBuf, count: cap)
                rxHead = 0
                rxLen = cap
                rxCond.broadcast()
                return
            }
            let need = rxLen + count
            if need > cap {
                let drop = need - cap
                rxHead = (rxHead + drop) % cap
                rxLen = max(0, rxLen - drop)
            }
            let tail = (rxHead + rxLen) % cap
            let first = min(count, cap - tail)
            data.withUnsafeBytes { rawBuf in
                guard let src = rawBuf.baseAddress?.assumingMemoryBound(to: UInt8.self) else { return }
                rxBuf.withUnsafeMutableBufferPointer { dstBuf in
                    guard let dst = dstBuf.baseAddress else { return }
                    memcpy(dst.advanced(by: tail), src, first)
                    if first < count {
                        memcpy(dst, src.advanced(by: first), count - first)
                    }
                }
            }
            rxLen += count
            rxCond.broadcast()
        }

        func read(into outPtr: UnsafeMutableRawPointer, maxLen: Int, timeoutMs: Int) -> Int32 {
            guard maxLen > 0 else { return 0 }
            let deadline = Date(timeIntervalSinceNow: Double(max(15, timeoutMs)) / 1000.0)
            rxCond.lock()
            defer { rxCond.unlock() }

            while rxLen == 0 {
                if closed || (failure != nil && !ready) {
                    return -1
                }
                if Date() >= deadline {
                    return 0
                }
                rxCond.wait(until: deadline)
            }

            let n = min(maxLen, rxLen)
            let cap = rxBuf.count
            let first = min(n, cap - rxHead)
            let dst = outPtr.assumingMemoryBound(to: UInt8.self)
            rxBuf.withUnsafeBufferPointer { srcBuf in
                guard let src = srcBuf.baseAddress else { return }
                memcpy(dst, src.advanced(by: rxHead), first)
                if first < n {
                    memcpy(dst.advanced(by: first), src, n - first)
                }
            }
            rxHead = (rxHead + n) % cap
            rxLen -= n
            return Int32(n)
        }
    }

    private let bleQueue = DispatchQueue(label: "app.slaprf.ble.central", qos: .userInteractive)
    private let stateLock = NSLock()
    private var central: CBCentralManager?
    private var centralState: CBManagerState = .unknown
    private var scanning = false
    private var lastScanStart: TimeInterval = 0
    private var scanGeneration: UInt64 = 0
    private var nextHandle: Int32 = 0x4000_0001

    private var seenByFP: [String: SeenHub] = [:]
    private var fpByPeripheralID: [UUID: String] = [:]
    private var sessionsByHandle: [Int32: Session] = [:]
    private var handleByPeripheralID: [UUID: Int32] = [:]

    private override init() {
        super.init()
    }

    static func registerWithGoBridge() {
        _ = shared
        slaprf_ios_register_ble_callbacks(
            { () -> Int32 in
                return SlapRFBleShim.shared.isBleAvailable() ? 1 : 0
            },
            { () -> UnsafeMutablePointer<CChar>? in
                let json = SlapRFBleShim.shared.listPortsJson()
                return strdup(json)
            },
            { (cPortName, baudRate, errOut) -> Int32 in
                let name = cPortName != nil ? String(cString: cPortName!) : ""
                var errMsg: String?
                let h = SlapRFBleShim.shared.openPort(portName: name, baudRate: Int(baudRate), errorOut: &errMsg)
                if h <= 0, let errOut = errOut, let msg = errMsg, !msg.isEmpty {
                    errOut.pointee = strdup(msg)
                }
                return h
            },
            { (handle, outPtr, maxLen, timeoutMs) -> Int32 in
                guard let outPtr = outPtr else { return -1 }
                return SlapRFBleShim.shared.readPort(handle: handle, outPtr: outPtr, maxLen: Int(maxLen), timeoutMs: Int(timeoutMs))
            },
            { (handle, dataPtr, len) -> Int32 in
                guard let dataPtr = dataPtr, len > 0 else { return -1 }
                return SlapRFBleShim.shared.writePort(handle: handle, dataPtr: dataPtr, length: Int(len))
            },
            { (handle) in
                SlapRFBleShim.shared.closePort(handle: handle)
            }
        )
    }

    private func nowSec() -> TimeInterval {
        return ProcessInfo.processInfo.systemUptime
    }

    private func ensureCentralInitialized() -> CBManagerState {
        stateLock.lock()
        let hadCentral = (central != nil)
        let current = centralState
        stateLock.unlock()

        if !hadCentral {
            bleQueue.sync {
                self.stateLock.lock()
                if self.central == nil {
                    let mgr = CBCentralManager(
                        delegate: self,
                        queue: self.bleQueue,
                        options: [CBCentralManagerOptionShowPowerAlertKey: true]
                    )
                    self.central = mgr
                    self.centralState = mgr.state
                }
                self.stateLock.unlock()
            }
            // Wait briefly on first lazy init for CoreBluetooth to transition from .unknown -> .poweredOn.
            let waitUntil = nowSec() + 0.6
            while nowSec() < waitUntil {
                stateLock.lock()
                let st = centralState
                stateLock.unlock()
                if st != .unknown && st != .resetting {
                    return st
                }
                Thread.sleep(forTimeInterval: 0.04)
            }
        }
        stateLock.lock()
        let finalState = centralState
        stateLock.unlock()
        return finalState
    }

    func isBleAvailable() -> Bool {
        let st = ensureCentralInitialized()
        // Return true even while `.unknown` or `.unauthorized` so Go calls `listPortsJson` / `openPort`
        // and triggers the iOS Bluetooth permission prompt on first user discovery!
        return st != .unsupported
    }

    private func hasActiveSessionLocked() -> Bool {
        for s in sessionsByHandle.values where !s.closed {
            return true
        }
        return false
    }

    private func hasFreshOrConnectedLocked(_ now: TimeInterval) -> Bool {
        if hasActiveSessionLocked() {
            return true
        }
        for s in seenByFP.values where (now - s.seenAt) <= Self.seenTTLSec {
            return true
        }
        return false
    }

    private func startScanWindow(_ windowSec: TimeInterval) -> Bool {
        let st = ensureCentralInitialized()
        guard st == .poweredOn else { return false }

        var started = false
        bleQueue.sync {
            self.stateLock.lock()
            if self.scanning {
                started = true
                self.stateLock.unlock()
                return
            }
            guard let mgr = self.central, mgr.state == .poweredOn else {
                self.stateLock.unlock()
                return
            }
            self.scanGeneration &+= 1
            let gen = self.scanGeneration
            self.scanning = true
            self.lastScanStart = self.nowSec()
            self.stateLock.unlock()

            mgr.scanForPeripherals(
                withServices: [Self.serviceUUID],
                options: [CBCentralManagerScanOptionAllowDuplicatesKey: true]
            )
            started = true

            self.bleQueue.asyncAfter(deadline: .now() + windowSec) { [weak self] in
                self?.stopScanOnQueue(matchingGeneration: gen)
            }
        }
        return started
    }

    private func stopScan() {
        bleQueue.sync {
            self.stopScanOnQueue(matchingGeneration: nil)
        }
    }

    private func stopScanOnQueue(matchingGeneration gen: UInt64?) {
        stateLock.lock()
        if !scanning {
            stateLock.unlock()
            return
        }
        if let gen = gen, gen != scanGeneration {
            stateLock.unlock()
            return
        }
        scanning = false
        let mgr = central
        stateLock.unlock()
        mgr?.stopScan()
    }

    func listPortsJson() -> String {
        let st = ensureCentralInitialized()
        guard st == .poweredOn else { return "[]" }

        let now = nowSec()
        stateLock.lock()
        let first = (lastScanStart == 0)
        let cold = !hasFreshOrConnectedLocked(now)
        let anySession = hasActiveSessionLocked()
        let sinceLastScan = now - lastScanStart
        var scanningNow = scanning
        stateLock.unlock()

        if !anySession {
            if first || cold || sinceLastScan > Self.scanRefreshSec {
                scanningNow = startScanWindow(Self.scanWindowSec) || scanningNow
            }
            if cold && scanningNow {
                let until = nowSec() + Self.firstListWaitSec
                while nowSec() < until {
                    stateLock.lock()
                    let ready = hasFreshOrConnectedLocked(nowSec())
                    stateLock.unlock()
                    if ready { break }
                    Thread.sleep(forTimeInterval: 0.08)
                }
            }
        }

        let snapNow = nowSec()
        stateLock.lock()
        var connectedFPs = Set<String>()
        for s in sessionsByHandle.values where !s.closed {
            connectedFPs.insert(s.fp)
        }
        let entries = Array(seenByFP.values)
        stateLock.unlock()

        var jsonItems: [[String: Any]] = []
        for s in entries {
            let isConnected = connectedFPs.contains(s.fp)
            if !isConnected && (snapNow - s.seenAt) > Self.seenTTLSec {
                continue
            }
            let label = s.name.isEmpty ? "SlapRF Hub" : s.name
            let product = (!isConnected && s.hasFlags && !s.paired)
                ? "\(label) (Bluetooth \u{00B7} Pairing mode)"
                : "\(label) (Bluetooth)"
            jsonItems.append([
                "name": Self.portPrefix + s.fp,
                "isUsb": false,
                "serialNumber": s.fp,
                "product": product,
                "isEspressif": true,
                "transport": "ble",
            ])
        }
        jsonItems.sort { (a, b) in
            let na = (a["name"] as? String) ?? ""
            let nb = (b["name"] as? String) ?? ""
            return na < nb
        }
        guard let data = try? JSONSerialization.data(withJSONObject: jsonItems, options: []),
              let str = String(data: data, encoding: .utf8) else {
            return "[]"
        }
        return str
    }

    private func lookupFreshSeen(_ fp: String) -> SeenHub? {
        stateLock.lock()
        defer { stateLock.unlock() }
        guard let s = seenByFP[fp], (nowSec() - s.seenAt) <= Self.seenTTLSec else {
            return nil
        }
        return s
    }

    private func lookupSingleUnresolvedSeen() -> SeenHub? {
        stateLock.lock()
        defer { stateLock.unlock() }
        let now = nowSec()
        var candidate: SeenHub?
        var count = 0
        for s in seenByFP.values {
            if s.hasMfgData || (now - s.seenAt) > Self.seenTTLSec { continue }
            if handleByPeripheralID[s.peripheral.identifier] != nil { continue }
            candidate = s
            count += 1
        }
        return count == 1 ? candidate : nil
    }

    func openPort(portName: String, baudRate _: Int, errorOut: inout String?) -> Int32 {
        let trimmed = portName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.lowercased().hasPrefix(Self.portPrefix),
              trimmed.count == Self.portPrefix.count + 8 else {
            errorOut = "Invalid Bluetooth hub port \(trimmed)"
            return -1
        }
        let fp = String(trimmed.dropFirst(Self.portPrefix.count)).uppercased()

        let st = ensureCentralInitialized()
        switch st {
        case .poweredOn:
            break
        case .unauthorized:
            errorOut = "Bluetooth permission denied in iOS Settings -> SlapRF"
            return -1
        case .poweredOff:
            errorOut = "Bluetooth is turned off on this iPhone/iPad"
            return -1
        case .unsupported:
            errorOut = "Bluetooth LE is not supported on this device/simulator"
            return -1
        default:
            errorOut = "Bluetooth controller is initializing; please retry"
            return -1
        }

        var hub = lookupFreshSeen(fp)
        if hub == nil {
            let deadline = nowSec() + Self.openScanTimeoutSec
            while hub == nil && nowSec() < deadline {
                stateLock.lock()
                let isScanning = scanning
                stateLock.unlock()
                if !isScanning {
                    _ = startScanWindow(max(0.5, deadline - nowSec()))
                }
                Thread.sleep(forTimeInterval: 0.08)
                hub = lookupFreshSeen(fp) ?? lookupSingleUnresolvedSeen()
            }
        }
        stopScan()

        guard let targetHub = hub else {
            errorOut = "Bluetooth hub \(fp) not found (is it powered and advertising?)"
            return -1
        }

        var session: Session?
        bleQueue.sync {
            self.stateLock.lock()
            let handle = self.nextHandle
            self.nextHandle &+= 1
            let s = Session(handle: handle, fp: fp, peripheral: targetHub.peripheral)
            targetHub.peripheral.delegate = self
            self.sessionsByHandle[handle] = s
            self.handleByPeripheralID[targetHub.peripheral.identifier] = handle
            let mgr = self.central
            self.stateLock.unlock()

            session = s
            mgr?.connect(targetHub.peripheral, options: nil)
        }

        guard let activeSession = session else {
            errorOut = "Failed to initialize CoreBluetooth session"
            return -1
        }

        let waitRes = activeSession.openSem.wait(timeout: .now() + Self.connectTimeoutSec)
        if waitRes == .timedOut || !activeSession.ready {
            errorOut = activeSession.failure ?? "Bluetooth connection timed out"
            closePort(handle: activeSession.handle)
            return -1
        }
        return activeSession.handle
    }

    func readPort(handle: Int32, outPtr: UnsafeMutableRawPointer, maxLen: Int, timeoutMs: Int) -> Int32 {
        stateLock.lock()
        let session = sessionsByHandle[handle]
        stateLock.unlock()
        guard let session = session else { return -1 }
        return session.read(into: outPtr, maxLen: maxLen, timeoutMs: timeoutMs)
    }

    func writePort(handle: Int32, dataPtr: UnsafeRawPointer, length: Int) -> Int32 {
        stateLock.lock()
        let session = sessionsByHandle[handle]
        stateLock.unlock()
        guard let session = session, !session.closed, session.ready, length > 0 else {
            return -1
        }

        session.writeLock.lock()
        defer { session.writeLock.unlock() }

        let bytes = dataPtr.assumingMemoryBound(to: UInt8.self)
        var offset = 0
        while offset < length {
            if session.closed || !session.ready {
                return offset > 0 ? Int32(offset) : -1
            }
            guard let rx = session.rxChar else {
                return offset > 0 ? Int32(offset) : -1
            }

            var maxChunk = 20
            var canSend = true
            bleQueue.sync {
                let mtuLen = session.peripheral.maximumWriteValueLength(for: .withoutResponse)
                maxChunk = max(20, min(244, mtuLen))
                canSend = session.peripheral.canSendWriteWithoutResponse
            }
            if !canSend {
                _ = session.txReadySem.wait(timeout: .now() + Self.txReadyTimeoutSec)
            }
            if session.closed || !session.ready {
                return offset > 0 ? Int32(offset) : -1
            }

            let chunkLen = min(maxChunk, length - offset)
            let chunkData = Data(bytes: bytes.advanced(by: offset), count: chunkLen)
            bleQueue.sync {
                if !session.closed && session.ready {
                    session.peripheral.writeValue(chunkData, for: rx, type: .withoutResponse)
                }
            }
            offset += chunkLen
        }
        return Int32(length)
    }

    func closePort(handle: Int32) {
        stateLock.lock()
        guard let session = sessionsByHandle.removeValue(forKey: handle) else {
            stateLock.unlock()
            return
        }
        if handleByPeripheralID[session.peripheral.identifier] == handle {
            handleByPeripheralID.removeValue(forKey: session.peripheral.identifier)
        }
        session.closed = true
        let mgr = central
        stateLock.unlock()

        session.fail("Bluetooth port closed")
        bleQueue.async {
            if let tx = session.txChar {
                session.peripheral.setNotifyValue(false, for: tx)
            }
            mgr?.cancelPeripheralConnection(session.peripheral)
        }
    }

    // MARK: - Manufacturer Payload & Fallback Fingerprint Helpers

    private static func fallbackFP(for uuid: UUID) -> String {
        var hash: UInt32 = 2_166_136_261
        for b in uuid.uuidString.uppercased().utf8 {
            hash ^= UInt32(b)
            hash &*= 16_777_619
        }
        if hash == 0 { hash = 1 }
        return String(format: "%08X", hash)
    }

    private static func decodeManufacturerData(_ data: Data) -> (fp: String, role: Int, hasFlags: Bool, paired: Bool)? {
        // CoreBluetooth includes the 2-byte LE Company ID (0xFFFF) at bytes [0..1],
        // followed by 'S' (0x53), 'R' (0x52), <fp u32 LE [4..7]>, <role [8]>, <maj>, <min>, <patch>, [<flags [12]>].
        let bytes = [UInt8](data)
        if bytes.count >= 9 && bytes[0] == 0xFF && bytes[1] == 0xFF && bytes[2] == 0x53 && bytes[3] == 0x52 {
            let fpVal = UInt32(bytes[4])
                | (UInt32(bytes[5]) << 8)
                | (UInt32(bytes[6]) << 16)
                | (UInt32(bytes[7]) << 24)
            let role = Int(bytes[8])
            let hasFlags = bytes.count >= 13
            let paired = hasFlags && ((bytes[12] & 0x01) != 0)
            return (String(format: "%08X", fpVal), role, hasFlags, paired)
        }
        return nil
    }

    // MARK: - CBCentralManagerDelegate & CBPeripheralDelegate

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        stateLock.lock()
        centralState = central.state
        if central.state != .poweredOn {
            scanning = false
            let active = Array(sessionsByHandle.values)
            stateLock.unlock()
            for s in active {
                s.fail("Bluetooth adapter turned off")
            }
            return
        }
        stateLock.unlock()
    }

    func centralManager(
        _: CBCentralManager,
        didDiscover peripheral: CBPeripheral,
        advertisementData: [String: Any],
        rssi _: NSNumber
    ) {
        let advName = (advertisementData[CBAdvertisementDataLocalNameKey] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let periphName = (peripheral.name ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedName = !advName.isEmpty ? advName : periphName
        let now = nowSec()

        if let mfgData = advertisementData[CBAdvertisementDataManufacturerDataKey] as? Data,
           let parsed = Self.decodeManufacturerData(mfgData) {
            stateLock.lock()
            if let oldFP = fpByPeripheralID[peripheral.identifier], oldFP != parsed.fp {
                seenByFP.removeValue(forKey: oldFP)
            }
            fpByPeripheralID[peripheral.identifier] = parsed.fp
            let prevName = seenByFP[parsed.fp]?.name ?? ""
            seenByFP[parsed.fp] = SeenHub(
                fp: parsed.fp,
                peripheral: peripheral,
                name: resolvedName.isEmpty ? prevName : resolvedName,
                role: parsed.role,
                hasFlags: parsed.hasFlags,
                paired: parsed.paired,
                hasMfgData: true,
                seenAt: now
            )
            stateLock.unlock()
            return
        }

        // Background or pre-scan-response fallback when discovered via SlapRF Service UUID filter.
        stateLock.lock()
        let fp = fpByPeripheralID[peripheral.identifier] ?? Self.fallbackFP(for: peripheral.identifier)
        fpByPeripheralID[peripheral.identifier] = fp
        if var existing = seenByFP[fp] {
            existing.peripheral = peripheral
            if !resolvedName.isEmpty {
                existing.name = resolvedName
            }
            existing.seenAt = now
            seenByFP[fp] = existing
        } else {
            seenByFP[fp] = SeenHub(
                fp: fp,
                peripheral: peripheral,
                name: resolvedName,
                role: 1,
                hasFlags: false,
                paired: false,
                hasMfgData: false,
                seenAt: now
            )
        }
        stateLock.unlock()
    }

    private func session(for peripheral: CBPeripheral) -> Session? {
        stateLock.lock()
        defer { stateLock.unlock() }
        guard let h = handleByPeripheralID[peripheral.identifier] else { return nil }
        return sessionsByHandle[h]
    }

    func centralManager(_: CBCentralManager, didConnect peripheral: CBPeripheral) {
        guard session(for: peripheral) != nil else { return }
        peripheral.delegate = self
        peripheral.discoverServices([Self.serviceUUID])
    }

    func centralManager(_: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        guard let s = session(for: peripheral) else { return }
        s.fail("Bluetooth connection failed: \(error?.localizedDescription ?? "unknown error")")
    }

    func centralManager(_: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        stateLock.lock()
        let h = handleByPeripheralID.removeValue(forKey: peripheral.identifier)
        let s = h != nil ? sessionsByHandle[h!] : nil
        stateLock.unlock()

        if let s = s {
            let reason = error?.localizedDescription ?? "Bluetooth hub disconnected"
            s.fail(reason)
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard let s = session(for: peripheral) else { return }
        if let error = error {
            s.fail("Bluetooth service discovery failed: \(error.localizedDescription)")
            return
        }
        guard let svcs = peripheral.services,
              let svc = svcs.first(where: { $0.uuid == Self.serviceUUID }) else {
            s.fail("SlapRF Hub service not found on device")
            return
        }
        peripheral.discoverCharacteristics([Self.rxCharUUID, Self.txCharUUID], for: svc)
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        guard let s = session(for: peripheral) else { return }
        if let error = error {
            s.fail("Bluetooth characteristic discovery failed: \(error.localizedDescription)")
            return
        }
        guard let chars = service.characteristics else {
            s.fail("SlapRF Hub RX/TX characteristics missing")
            return
        }
        var rx: CBCharacteristic?
        var tx: CBCharacteristic?
        for c in chars {
            if c.uuid == Self.rxCharUUID { rx = c }
            if c.uuid == Self.txCharUUID { tx = c }
        }
        guard let rxChar = rx, let txChar = tx else {
            s.fail("SlapRF Hub RX/TX characteristics missing")
            return
        }
        s.rxChar = rxChar
        s.txChar = txChar
        peripheral.setNotifyValue(true, for: txChar)
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
        guard let s = session(for: peripheral), characteristic.uuid == Self.txCharUUID else { return }
        if let error = error {
            s.fail("Enabling TX notifications failed: \(error.localizedDescription)")
            return
        }
        if characteristic.isNotifying {
            s.markReady()
        } else if !s.ready {
            s.fail("Hub declined TX notifications")
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        guard error == nil,
              characteristic.uuid == Self.txCharUUID,
              let value = characteristic.value,
              !value.isEmpty,
              let s = session(for: peripheral) else {
            return
        }
        s.appendRx(value)
    }

    func peripheralIsReady(toSendWriteWithoutResponse peripheral: CBPeripheral) {
        session(for: peripheral)?.txReadySem.signal()
    }
}
