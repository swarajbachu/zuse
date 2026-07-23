import CryptoKit
import ExpoModulesCore
import Foundation
import Network
import Security

private let serviceType = "_zuse._tcp"
private let connectivityQueue = DispatchQueue(label: "com.zuse.local-connectivity")
private let sharedKeychainGroup = "HMCST4VV42.com.zuse.shared-connectivity"

struct NearbyServiceRecord: Record {
  @Field var id: String = ""
  @Field var name: String = ""
  @Field var type: String = serviceType
  @Field var domain: String = "local."
  @Field var interfaceName: String?
  @Field var trustRecordId: String?
  @Field var tlsCertificatePin: String = ""
}

struct LocalProxyRecord: Record {
  @Field var id: String = ""
  @Field var host: String = "127.0.0.1"
  @Field var port: Int = 0
}

private final class ContinuationGate: @unchecked Sendable {
  private let lock = NSLock()
  private var finished = false

  func take() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard !finished else { return false }
    finished = true
    return true
  }
}

private final class ProxySession {
  let id = UUID()
  private let local: NWConnection
  private let remote: NWConnection
  private let onClose: (UUID) -> Void
  private var closed = false

  init(local: NWConnection, remote: NWConnection, onClose: @escaping (UUID) -> Void) {
    self.local = local
    self.remote = remote
    self.onClose = onClose
  }

  func start() {
    local.start(queue: connectivityQueue)
    remote.stateUpdateHandler = { [weak self] state in
      guard let self else { return }
      switch state {
      case .ready:
        self.pump(from: self.local, to: self.remote)
        self.pump(from: self.remote, to: self.local)
      case .failed(let error):
        print("[zuse:nearby-native] proxy.remote.failed \(error.localizedDescription)")
        self.close()
      case .cancelled:
        self.close()
      default:
        break
      }
    }
    remote.start(queue: connectivityQueue)
  }

  func stop() {
    close()
  }

  private func pump(from source: NWConnection, to destination: NWConnection) {
    source.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) {
      [weak self] data, _, complete, error in
      guard let self else { return }
      if let data, !data.isEmpty {
        destination.send(content: data, completion: .contentProcessed { sendError in
          if sendError != nil {
            self.close()
          } else if complete {
            destination.send(content: nil, isComplete: true, completion: .contentProcessed { _ in
              self.close()
            })
          } else {
            self.pump(from: source, to: destination)
          }
        })
      } else if complete || error != nil {
        destination.send(content: nil, isComplete: true, completion: .contentProcessed { _ in
          self.close()
        })
      } else {
        self.pump(from: source, to: destination)
      }
    }
  }

  private func close() {
    guard !closed else { return }
    closed = true
    local.cancel()
    remote.cancel()
    onClose(id)
  }
}

private final class ByteProxy {
  let id = UUID().uuidString
  private let service: NearbyServiceRecord
  private var listener: NWListener?
  private let sessionsLock = NSLock()
  private var sessions: [UUID: ProxySession] = [:]

  init(service: NearbyServiceRecord) {
    self.service = service
  }

  func start() async throws -> UInt16 {
    let localParameters = NWParameters.tcp
    localParameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
    let listener = try NWListener(using: localParameters, on: .any)
    self.listener = listener
    listener.newConnectionHandler = { [weak self] connection in
      self?.accept(connection)
    }
    return try await withCheckedThrowingContinuation { continuation in
      let gate = ContinuationGate()
      listener.stateUpdateHandler = { state in
        switch state {
        case .ready:
          guard let port = listener.port, gate.take() else { return }
          continuation.resume(returning: port.rawValue)
        case .failed(let error):
          guard gate.take() else { return }
          continuation.resume(throwing: error)
        case .cancelled:
          guard gate.take() else { return }
          continuation.resume(throwing: NSError(
            domain: "ZuseLocalConnectivity",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "Local proxy was cancelled"]
          ))
        default:
          break
        }
      }
      listener.start(queue: connectivityQueue)
    }
  }

  func cancel() {
    listener?.cancel()
    sessionsLock.lock()
    let activeSessions = Array(sessions.values)
    sessions.removeAll()
    sessionsLock.unlock()
    activeSessions.forEach { $0.stop() }
  }

  private func accept(_ local: NWConnection) {
    let endpoint = NWEndpoint.service(
      name: service.name,
      type: service.type,
      domain: service.domain,
      interface: nil
    )
    let tls = NWProtocolTLS.Options()
    let expectedPin = service.tlsCertificatePin
    sec_protocol_options_set_verify_block(
      tls.securityProtocolOptions,
      { _, trust, complete in
        let secTrust = sec_trust_copy_ref(trust).takeRetainedValue()
        guard let certificate = SecTrustGetCertificateAtIndex(secTrust, 0) else {
          complete(false)
          return
        }
        let digest = SHA256.hash(data: SecCertificateCopyData(certificate) as Data)
        let actualPin = Data(digest).base64EncodedString()
          .replacingOccurrences(of: "+", with: "-")
          .replacingOccurrences(of: "/", with: "_")
          .replacingOccurrences(of: "=", with: "")
        complete(actualPin == expectedPin)
      },
      connectivityQueue
    )
    let parameters = NWParameters(tls: tls, tcp: NWProtocolTCP.Options())
    // Peer-to-peer only when the service was actually discovered over AWDL;
    // enabling it unconditionally keeps the AWDL radio active for every
    // proxied connection and disrupts regular Wi-Fi.
    parameters.includePeerToPeer =
      service.interfaceName?.hasPrefix("awdl") == true
    let remote = NWConnection(to: endpoint, using: parameters)
    let session = ProxySession(local: local, remote: remote) { [weak self] id in
      guard let self else { return }
      self.sessionsLock.lock()
      self.sessions.removeValue(forKey: id)
      self.sessionsLock.unlock()
    }
    sessionsLock.lock()
    sessions[session.id] = session
    sessionsLock.unlock()
    session.start()
  }
}

public final class ZuseLocalConnectivityModule: Module {
  private var browser: NWBrowser?
  private var pathMonitor: NWPathMonitor?
  private var proxies: [String: ByteProxy] = [:]
  private var pathGeneration = 0
  private var browserGeneration = 0
  private var browserRetryAttempt = 0
  private var browserRetryWork: DispatchWorkItem?

  public func definition() -> ModuleDefinition {
    Name("ZuseLocalConnectivity")
    Events("onServicesChanged", "onPathChanged", "onDiscoveryStateChanged")

    AsyncFunction("startDiscovery") { () -> Void in
      self.startDiscovery()
    }

    AsyncFunction("stopDiscovery") { () -> Void in
      self.stopDiscovery()
    }

    AsyncFunction("openProxy") { (service: NearbyServiceRecord) async throws -> LocalProxyRecord in
      let proxy = ByteProxy(service: service)
      let port = try await proxy.start()
      self.proxies[proxy.id] = proxy
      let record = LocalProxyRecord()
      record.id = proxy.id
      record.port = Int(port)
      return record
    }

    AsyncFunction("closeProxy") { (id: String) -> Void in
      self.proxies.removeValue(forKey: id)?.cancel()
    }

    AsyncFunction("proofForTrustRecord") { (recordId: String, challenge: String) -> String? in
      guard let secret = self.readTrustRecord(recordId: recordId) else { return nil }
      let key = SymmetricKey(data: secret)
      let proof = HMAC<SHA256>.authenticationCode(
        for: Data(challenge.utf8),
        using: key
      )
      return Data(proof).base64EncodedString()
        .replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
    }

    AsyncFunction("hasTrustRecord") { (recordId: String) -> Bool in
      self.readTrustRecord(recordId: recordId) != nil
    }

    OnAppEntersForeground {
      self.startDiscovery()
    }

    OnAppEntersBackground {
      self.stopDiscovery()
    }

    OnDestroy {
      self.stopDiscovery()
    }
  }

  private func startDiscovery() {
    startBrowser()
    startPathMonitorIfNeeded()
  }

  private func startBrowser() {
    guard browser == nil else { return }
    browserRetryWork?.cancel()
    sendEvent("onDiscoveryStateChanged", ["state": "starting"])
    // One generation per browser instance (not per emit): route ids stay
    // stable while a browser lives, and change only when discovery restarts
    // — e.g. after a path change — so routes are invalidated exactly when
    // the network they were discovered on is gone.
    browserGeneration += 1
    let generation = browserGeneration
    let parameters = NWParameters.tcp
    // No peer-to-peer for browsing: includePeerToPeer engages AWDL, which
    // time-slices the Wi-Fi radio and visibly degrades the phone's Wi-Fi the
    // whole time discovery runs. Infrastructure Wi-Fi is the product's
    // primary (and pinned) path; AWDL-only discovery is not worth breaking
    // the network we actually use.
    let browser = NWBrowser(
      for: .bonjourWithTXTRecord(type: serviceType, domain: nil),
      using: parameters
    )
    browser.browseResultsChangedHandler = { [weak self] results, _ in
      guard let self else { return }
      let services = results.compactMap { result -> [String: Any]? in
        guard case let .service(name, type, domain, interface) = result.endpoint else {
          return nil
        }
        var trustRecordId: String?
        var tlsCertificatePin: String?
        if case let .bonjour(txtRecord) = result.metadata {
          if let entry = txtRecord.getEntry(for: "trust") {
            switch entry {
            case .string(let value): trustRecordId = value
            case .data(let data): trustRecordId = String(data: data, encoding: .utf8)
            default: break
            }
          }
          if let entry = txtRecord.getEntry(for: "tls") {
            switch entry {
            case .string(let value): tlsCertificatePin = value
            case .data(let data): tlsCertificatePin = String(data: data, encoding: .utf8)
            default: break
            }
          }
        }
        guard let tlsCertificatePin, tlsCertificatePin.count == 43 else { return nil }
        var service: [String: Any] = [
          "id": "\(name)|\(type)|\(domain)|\(interface?.name ?? "")|\(generation)",
          "name": name,
          "type": type,
          "domain": domain,
          "tlsCertificatePin": tlsCertificatePin,
        ]
        if let interfaceName = interface?.name {
          service["interfaceName"] = interfaceName
        }
        if let trustRecordId {
          service["trustRecordId"] = trustRecordId
        }
        return service
      }
      self.sendEvent("onServicesChanged", ["services": services])
      self.sendEvent("onDiscoveryStateChanged", [
        "state": "ready",
        "rawResultCount": results.count,
        "serviceCount": services.count,
      ])
    }
    browser.stateUpdateHandler = { [weak self, weak browser] state in
      guard let self else { return }
      // Ignore callbacks from a browser we already replaced.
      guard let browser, self.browser === browser else { return }
      switch state {
      case .ready:
        self.browserRetryAttempt = 0
        self.sendEvent("onDiscoveryStateChanged", ["state": "ready"])
      case .waiting(let error):
        self.sendEvent("onDiscoveryStateChanged", [
          "state": "waiting",
          "reason": String(describing: error),
        ])
        // A Wi-Fi switch usually parks the browser in .waiting (not .failed),
        // where it can sit forever on the dead interface. Restart with the
        // same backoff so discovery re-arms on the new network.
        self.browser?.cancel()
        self.browser = nil
        self.scheduleBrowserRestart()
      case .failed(let error):
        self.sendEvent("onDiscoveryStateChanged", [
          "state": "failed",
          "reason": String(describing: error),
        ])
        self.browser?.cancel()
        self.browser = nil
        self.scheduleBrowserRestart()
      case .cancelled:
        self.sendEvent("onDiscoveryStateChanged", ["state": "stopped"])
      default:
        break
      }
    }
    self.browser = browser
    browser.start(queue: connectivityQueue)
  }

  private func startPathMonitorIfNeeded() {
    guard pathMonitor == nil else { return }
    let monitor = NWPathMonitor()
    monitor.pathUpdateHandler = { [weak self] path in
      guard let self else { return }
      self.pathGeneration += 1
      let status: String
      switch path.status {
      case .satisfied: status = "satisfied"
      case .requiresConnection: status = "requiresConnection"
      default: status = "unsatisfied"
      }
      self.sendEvent("onPathChanged", [
        "status": status,
        "usesWifi": path.usesInterfaceType(.wifi),
        "usesCellular": path.usesInterfaceType(.cellular),
        "generation": self.pathGeneration,
      ])
      // The network the current browser is browsing on just changed; restart
      // discovery so services are re-resolved on the new path. Debounced so a
      // flapping transition coalesces into one restart.
      if path.status == .satisfied {
        self.scheduleBrowserRestartForPathChange()
      }
    }
    pathMonitor = monitor
    monitor.start(queue: connectivityQueue)
  }

  private func scheduleBrowserRestartForPathChange() {
    browserRetryWork?.cancel()
    let work = DispatchWorkItem { [weak self] in
      guard let self else { return }
      self.browser?.cancel()
      self.browser = nil
      self.browserRetryAttempt = 0
      self.startBrowser()
    }
    browserRetryWork = work
    connectivityQueue.asyncAfter(deadline: .now() + 0.5, execute: work)
  }

  private func stopDiscovery() {
    browserRetryWork?.cancel()
    browserRetryWork = nil
    browser?.cancel()
    browser = nil
    pathMonitor?.cancel()
    pathMonitor = nil
    proxies.values.forEach { $0.cancel() }
    proxies.removeAll()
  }

  private func scheduleBrowserRestart() {
    browserRetryAttempt += 1
    let delay = min(16.0, pow(2.0, Double(max(0, browserRetryAttempt - 1))))
    let work = DispatchWorkItem { [weak self] in self?.startBrowser() }
    browserRetryWork = work
    connectivityQueue.asyncAfter(deadline: .now() + delay, execute: work)
  }

  private func readTrustRecord(recordId: String) -> Data? {
    let query: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: "com.zuse.local-trust",
      kSecAttrAccount: recordId,
      kSecAttrAccessGroup: sharedKeychainGroup,
      kSecAttrSynchronizable: kCFBooleanTrue as Any,
      kSecUseDataProtectionKeychain: kCFBooleanTrue as Any,
      kSecReturnData: kCFBooleanTrue as Any,
      kSecMatchLimit: kSecMatchLimitOne,
    ]
    var result: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess else {
      return nil
    }
    return result as? Data
  }
}
