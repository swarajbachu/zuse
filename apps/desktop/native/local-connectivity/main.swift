import AppKit
import Foundation
import Network
import Security

private let queue = DispatchQueue(label: "com.zuse.local-connectivity.helper")
private let sharedKeychainGroup = "HMCST4VV42.com.zuse.shared-connectivity"

private func base64URL(_ data: Data) -> String {
  data.base64EncodedString()
    .replacingOccurrences(of: "+", with: "-")
    .replacingOccurrences(of: "/", with: "_")
    .replacingOccurrences(of: "=", with: "")
}

private func ensureTrustRecord(_ recordId: String) throws -> Data {
  let baseQuery: [CFString: Any] = [
    kSecClass: kSecClassGenericPassword,
    kSecAttrService: "com.zuse.local-trust",
    kSecAttrAccount: recordId,
    kSecAttrAccessGroup: sharedKeychainGroup,
    kSecAttrSynchronizable: kCFBooleanTrue as Any,
    kSecUseDataProtectionKeychain: kCFBooleanTrue as Any,
  ]
  var readQuery = baseQuery
  readQuery[kSecReturnData] = kCFBooleanTrue
  readQuery[kSecMatchLimit] = kSecMatchLimitOne
  var existing: CFTypeRef?
  let readStatus = SecItemCopyMatching(readQuery as CFDictionary, &existing)
  if readStatus == errSecSuccess, let secret = existing as? Data { return secret }
  guard readStatus == errSecItemNotFound else {
    throw NSError(domain: NSOSStatusErrorDomain, code: Int(readStatus))
  }

  var bytes = [UInt8](repeating: 0, count: 32)
  guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
    throw NSError(domain: "ZuseLocalConnectivity", code: 2)
  }
  let secret = Data(bytes)
  var addQuery = baseQuery
  addQuery[kSecValueData] = secret
  addQuery[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlock
  let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
  guard addStatus == errSecSuccess else {
    throw NSError(domain: NSOSStatusErrorDomain, code: Int(addStatus))
  }
  return secret
}

private func emit(_ event: String, _ fields: [String: Any] = [:]) {
  var payload = fields
  payload["event"] = event
  guard
    let data = try? JSONSerialization.data(withJSONObject: payload),
    let line = String(data: data, encoding: .utf8)
  else { return }
  FileHandle.standardOutput.write(Data("\(line)\n".utf8))
}

private final class ConnectionBridge {
  let id: UUID
  private let inbound: NWConnection
  private let outbound: NWConnection
  private let onClose: (UUID) -> Void
  private var closed = false

  init(
    id: UUID,
    inbound: NWConnection,
    targetPort: NWEndpoint.Port,
    onClose: @escaping (UUID) -> Void
  ) {
    self.id = id
    self.inbound = inbound
    self.onClose = onClose
    self.outbound = NWConnection(
      host: "127.0.0.1",
      port: targetPort,
      using: .tcp
    )
  }

  func start() {
    inbound.start(queue: queue)
    outbound.stateUpdateHandler = { [weak self] state in
      guard let self else { return }
      switch state {
      case .ready:
        self.pump(from: self.inbound, to: self.outbound)
        self.pump(from: self.outbound, to: self.inbound)
      case .failed(let error):
        emit("bridge.failed", ["error": error.localizedDescription])
        self.cancel()
      case .cancelled:
        self.cancel()
      default:
        break
      }
    }
    outbound.start(queue: queue)
  }

  func stop() {
    cancel()
  }

  private func pump(from source: NWConnection, to destination: NWConnection) {
    source.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) {
      [weak self] data, _, complete, error in
      guard let self else { return }
      if let data, !data.isEmpty {
        destination.send(content: data, completion: .contentProcessed { sendError in
          if sendError != nil {
            self.cancel()
          } else if complete {
            destination.send(content: nil, isComplete: true, completion: .contentProcessed { _ in
              self.cancel()
            })
          } else {
            self.pump(from: source, to: destination)
          }
        })
      } else if complete || error != nil {
        destination.send(content: nil, isComplete: true, completion: .contentProcessed { _ in
          self.cancel()
        })
      } else {
        self.pump(from: source, to: destination)
      }
    }
  }

  private func cancel() {
    guard !closed else { return }
    closed = true
    inbound.cancel()
    outbound.cancel()
    onClose(id)
  }
}

private final class NearbyListener {
  private let targetPort: NWEndpoint.Port
  private let serviceName: String
  private var listener: NWListener?
  private var bridges: [UUID: ConnectionBridge] = [:]
  private var retryWork: DispatchWorkItem?
  private var retryAttempt = 0

  private let trustRecordId: String?
  private let tlsCertificatePin: String

  init(
    targetPort: NWEndpoint.Port,
    serviceName: String,
    trustRecordId: String?,
    tlsCertificatePin: String
  ) {
    self.targetPort = targetPort
    self.serviceName = serviceName
    self.trustRecordId = trustRecordId
    self.tlsCertificatePin = tlsCertificatePin
  }

  func start() {
    retryWork?.cancel()
    listener?.cancel()
    listener = nil
    let parameters = NWParameters.tcp
    // No peer-to-peer: advertising over AWDL keeps the Mac's Wi-Fi radio
    // time-slicing and degrades the network for everything else. The phone
    // browses infrastructure Wi-Fi only, so the AWDL publication was unused.
    parameters.allowLocalEndpointReuse = true
    do {
      let listener = try NWListener(using: parameters, on: .any)
      var txtEntries = ["tls": Data(tlsCertificatePin.utf8)]
      if let trustRecordId { txtEntries["trust"] = Data(trustRecordId.utf8) }
      let txtRecord = NetService.data(fromTXTRecord: txtEntries)
      listener.service = NWListener.Service(
        name: serviceName,
        type: "_zuse._tcp",
        txtRecord: txtRecord
      )
      listener.newConnectionHandler = { [weak self] connection in
        guard let self else { return }
        let id = UUID()
        let bridge = ConnectionBridge(
          id: id,
          inbound: connection,
          targetPort: self.targetPort,
          onClose: { [weak self] id in self?.bridges.removeValue(forKey: id) }
        )
        self.bridges[id] = bridge
        bridge.start()
      }
      listener.stateUpdateHandler = { [weak self] state in
        guard let self else { return }
        switch state {
        case .ready:
          self.retryAttempt = 0
          emit("listener.ready", ["port": listener.port?.rawValue ?? 0])
        case .failed(let error):
          emit("listener.failed", ["error": error.localizedDescription])
          self.listener?.cancel()
          self.listener = nil
          self.scheduleRestart()
        case .cancelled:
          emit("listener.cancelled")
        default:
          break
        }
      }
      self.listener = listener
      listener.start(queue: queue)
    } catch {
      emit("listener.failed", ["error": error.localizedDescription])
      scheduleRestart()
    }
  }

  func stop() {
    retryWork?.cancel()
    listener?.cancel()
    listener = nil
    Array(bridges.values).forEach { $0.stop() }
    bridges.removeAll()
  }

  func refreshInterfaces() {
    start()
  }

  private func scheduleRestart() {
    retryAttempt += 1
    let delay = min(16.0, pow(2.0, Double(max(0, retryAttempt - 1))))
    let work = DispatchWorkItem { [weak self] in self?.start() }
    retryWork = work
    queue.asyncAfter(deadline: .now() + delay, execute: work)
  }
}

if CommandLine.arguments.count >= 3, CommandLine.arguments[1] == "--ensure-trust" {
  do {
    let recordId = String(CommandLine.arguments[2].prefix(128))
    let secret = try ensureTrustRecord(recordId)
    let output = ["recordId": recordId, "secret": base64URL(secret)]
    let data = try JSONSerialization.data(withJSONObject: output)
    FileHandle.standardOutput.write(data)
    exit(0)
  } catch {
    FileHandle.standardError.write(Data("trust record unavailable: \(error.localizedDescription)\n".utf8))
    exit(1)
  }
}

guard
  CommandLine.arguments.count >= 2,
  let portValue = UInt16(CommandLine.arguments[1]),
  let targetPort = NWEndpoint.Port(rawValue: portValue)
else {
  FileHandle.standardError.write(Data("usage: zuse-local-connectivity <loopback-port>\n".utf8))
  exit(64)
}

private let serviceName = CommandLine.arguments.count >= 3
  ? String(CommandLine.arguments[2].prefix(48))
  : "Zuse Mac"
private let trustRecordId = CommandLine.arguments.count >= 4
  ? (CommandLine.arguments[3] == "-" ? nil : String(CommandLine.arguments[3].prefix(128)))
  : nil
private let tlsCertificatePin = CommandLine.arguments.count >= 5
  ? String(CommandLine.arguments[4].prefix(128))
  : ""
guard tlsCertificatePin.count == 43 else {
  FileHandle.standardError.write(Data("missing TLS certificate pin\n".utf8))
  exit(64)
}
private let nearby = NearbyListener(
  targetPort: targetPort,
  serviceName: serviceName,
  trustRecordId: trustRecordId,
  tlsCertificatePin: tlsCertificatePin
)
private let monitor = NWPathMonitor()
monitor.pathUpdateHandler = { path in
  let status: String
  switch path.status {
  case .satisfied: status = "satisfied"
  case .requiresConnection: status = "requiresConnection"
  default: status = "unsatisfied"
  }
  emit("path.changed", [
    "status": status,
    "wifi": path.usesInterfaceType(.wifi),
    "ethernet": path.usesInterfaceType(.wiredEthernet),
  ])
  nearby.refreshInterfaces()
}
monitor.start(queue: queue)
nearby.start()

signal(SIGTERM, SIG_IGN)
private let termination = DispatchSource.makeSignalSource(signal: SIGTERM, queue: queue)
termination.setEventHandler {
  nearby.stop()
  monitor.cancel()
  exit(0)
}
termination.resume()
private let wakeObserver = NSWorkspace.shared.notificationCenter.addObserver(
  forName: NSWorkspace.didWakeNotification,
  object: nil,
  queue: nil
) { _ in
  queue.async {
    emit("system.wake")
    nearby.refreshInterfaces()
  }
}
dispatchMain()
