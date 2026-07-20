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

private final class ByteProxy {
  let id = UUID().uuidString
  private let service: NearbyServiceRecord
  private var listener: NWListener?
  private var localConnection: NWConnection?
  private var remoteConnection: NWConnection?

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
    closeSession()
    listener?.cancel()
  }

  private func closeSession() {
    localConnection?.cancel()
    remoteConnection?.cancel()
    localConnection = nil
    remoteConnection = nil
  }

  private func accept(_ local: NWConnection) {
    guard localConnection == nil else {
      local.cancel()
      return
    }
    localConnection = local
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
    parameters.includePeerToPeer = true
    let remote = NWConnection(to: endpoint, using: parameters)
    remoteConnection = remote
    local.start(queue: connectivityQueue)
    remote.stateUpdateHandler = { [weak self] state in
      switch state {
      case .ready:
        self?.pump(from: local, to: remote)
        self?.pump(from: remote, to: local)
      case .failed, .cancelled:
        self?.closeSession()
      default:
        break
      }
    }
    remote.start(queue: connectivityQueue)
  }

  private func pump(from source: NWConnection, to destination: NWConnection) {
    source.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) {
      [weak self] data, _, complete, error in
      guard let self else { return }
      if let data, !data.isEmpty {
        destination.send(content: data, completion: .contentProcessed { sendError in
          if sendError != nil {
            self.closeSession()
          } else if complete {
            destination.send(content: nil, isComplete: true, completion: .contentProcessed { _ in
              self.closeSession()
            })
          } else {
            self.pump(from: source, to: destination)
          }
        })
      } else if complete || error != nil {
        destination.send(content: nil, isComplete: true, completion: .contentProcessed { _ in
          self.closeSession()
        })
      } else {
        self.pump(from: source, to: destination)
      }
    }
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
    Events("onServicesChanged", "onPathChanged")

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
    guard browser == nil else { return }
    browserRetryWork?.cancel()
    let parameters = NWParameters.tcp
    parameters.includePeerToPeer = true
    let browser = NWBrowser(
      for: .bonjour(type: serviceType, domain: nil),
      using: parameters
    )
    browser.browseResultsChangedHandler = { [weak self] results, _ in
      guard let self else { return }
      self.browserGeneration += 1
      let generation = self.browserGeneration
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
        return [
          "id": "\(name)|\(type)|\(domain)|\(interface?.name ?? "")|\(generation)",
          "name": name,
          "type": type,
          "domain": domain,
          "interfaceName": interface?.name as Any,
          "trustRecordId": trustRecordId as Any,
          "tlsCertificatePin": tlsCertificatePin,
        ]
      }
      self.sendEvent("onServicesChanged", ["services": services])
    }
    browser.stateUpdateHandler = { [weak self] state in
      switch state {
      case .ready:
        self?.browserRetryAttempt = 0
      case .failed:
        self?.browser?.cancel()
        self?.browser = nil
        self?.scheduleBrowserRestart()
      default:
        break
      }
    }
    self.browser = browser
    browser.start(queue: connectivityQueue)

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
    }
    pathMonitor = monitor
    monitor.start(queue: connectivityQueue)
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
    let work = DispatchWorkItem { [weak self] in self?.startDiscovery() }
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
