import AppKit
import AuthenticationServices
import Foundation
import Security

private func emit(_ payload: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: payload) else { exit(70) }
  FileHandle.standardOutput.write(data)
}

if CommandLine.arguments.contains("--probe") {
  var code: SecCode?
  let copyStatus = SecCodeCopySelf([], &code)
  let validityStatus = code.map { SecCodeCheckValidity($0, [], nil) } ?? errSecParam
  emit(["supported": copyStatus == errSecSuccess && validityStatus == errSecSuccess])
  exit(copyStatus == errSecSuccess && validityStatus == errSecSuccess ? 0 : 1)
}

guard
  CommandLine.arguments.count == 2,
  let requestedURL = URL(string: CommandLine.arguments[1]),
  let requestedHost = requestedURL.host,
  ["http", "https"].contains(requestedURL.scheme?.lowercased() ?? "")
else {
  emit(["ok": false, "error": "A valid website origin is required."])
  exit(64)
}

private final class PasswordAuthorization: NSObject,
  ASAuthorizationControllerDelegate,
  ASAuthorizationControllerPresentationContextProviding {
  private let window: NSWindow
  private let requestedHost: String

  init(requestedHost: String) {
    self.requestedHost = requestedHost
    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1, height: 1),
      styleMask: [.borderless],
      backing: .buffered,
      defer: false
    )
    window.level = .floating
    window.isOpaque = false
    window.backgroundColor = .clear
    super.init()
  }

  func start() {
    NSApp.setActivationPolicy(.accessory)
    NSApp.activate(ignoringOtherApps: true)
    window.center()
    window.makeKeyAndOrderFront(nil)
    let request = ASAuthorizationPasswordProvider().createRequest()
    let controller = ASAuthorizationController(authorizationRequests: [request])
    controller.delegate = self
    controller.presentationContextProvider = self
    controller.performRequests()
  }

  func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
    window
  }

  func authorizationController(
    controller: ASAuthorizationController,
    didCompleteWithAuthorization authorization: ASAuthorization
  ) {
    guard let credential = authorization.credential as? ASPasswordCredential else {
      emit(["ok": false, "error": "The system did not return a password credential."])
      NSApp.terminate(nil)
      return
    }
    let confirmation = NSAlert()
    confirmation.messageText = "Fill password for \(requestedHost)?"
    confirmation.informativeText =
      "The selected account is \(credential.user). Continue only if it belongs to this website."
    confirmation.alertStyle = .informational
    confirmation.addButton(withTitle: "Fill Password")
    confirmation.addButton(withTitle: "Cancel")
    guard confirmation.runModal() == .alertFirstButtonReturn else {
      emit(["ok": false, "cancelled": true, "error": "Password filling was cancelled."])
      NSApp.terminate(nil)
      return
    }
    emit(["ok": true, "username": credential.user, "password": credential.password])
    NSApp.terminate(nil)
  }

  func authorizationController(
    controller: ASAuthorizationController,
    didCompleteWithError error: Error
  ) {
    let authorizationError = error as? ASAuthorizationError
    let cancelled = authorizationError?.code == .canceled
    emit([
      "ok": false,
      "cancelled": cancelled,
      "error": cancelled ? "Password selection was cancelled." : error.localizedDescription,
    ])
    NSApp.terminate(nil)
  }
}

private let app = NSApplication.shared
private let authorization = PasswordAuthorization(requestedHost: requestedHost)
app.delegate = nil
DispatchQueue.main.async { authorization.start() }
app.run()
