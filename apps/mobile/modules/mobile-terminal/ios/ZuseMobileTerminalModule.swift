import ExpoModulesCore
import SwiftTerm
import UIKit

public enum ZuseTerminalSettings {
  public static func fontSize(_ value: Double?) -> Double {
    min(max(value ?? 12, 9), 24)
  }
}

public final class ZuseMobileTerminalModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ZuseMobileTerminal")

    View(ZuseMobileTerminalView.self) {
      Events("onInput", "onResize", "onOpenLink")

      Prop("feed") { (view: ZuseMobileTerminalView, value: String?) in
        view.feed(value)
      }

      Prop("fontSize") { (view: ZuseMobileTerminalView, value: Double?) in
        view.setFontSize(value)
      }

      Prop("focusNonce") { (view: ZuseMobileTerminalView, value: Int?) in
        view.focus(value)
      }

      Prop("controlNonce") { (view: ZuseMobileTerminalView, value: Int?) in
        view.armControl(value)
      }

      Prop("useMetal") { (view: ZuseMobileTerminalView, value: Bool?) in
        view.setUseMetal(value == true)
      }
    }
  }
}

public final class ZuseMobileTerminalView: ExpoView, TerminalViewDelegate {
  private let terminalView = TerminalView(frame: .zero)
  private var latestFeedSequence = -1
  private var latestFocusNonce = -1
  private var latestControlNonce = -1
  private var metalEnabled = false

  let onInput = EventDispatcher()
  let onResize = EventDispatcher()
  let onOpenLink = EventDispatcher()

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)

    backgroundColor = .black
    terminalView.translatesAutoresizingMaskIntoConstraints = false
    terminalView.terminalDelegate = self
    terminalView.nativeBackgroundColor = .black
    terminalView.nativeForegroundColor = UIColor(
      red: 0.91,
      green: 0.92,
      blue: 0.94,
      alpha: 1
    )
    terminalView.selectedTextBackgroundColor = UIColor(
      red: 0.20,
      green: 0.40,
      blue: 0.72,
      alpha: 1
    )
    terminalView.changeScrollback(10_000)
    addSubview(terminalView)

    NSLayoutConstraint.activate([
      terminalView.leadingAnchor.constraint(equalTo: leadingAnchor),
      terminalView.trailingAnchor.constraint(equalTo: trailingAnchor),
      terminalView.topAnchor.constraint(equalTo: topAnchor),
      terminalView.bottomAnchor.constraint(equalTo: bottomAnchor),
    ])
  }

  func feed(_ value: String?) {
    guard let value, let separator = value.firstIndex(of: "\u{0}") else {
      return
    }
    let sequenceText = value[..<separator]
    guard let sequence = Int(sequenceText), sequence > latestFeedSequence else {
      return
    }
    latestFeedSequence = sequence
    let dataStart = value.index(after: separator)
    terminalView.feed(text: String(value[dataStart...]))
  }

  func setFontSize(_ value: Double?) {
    let points = ZuseTerminalSettings.fontSize(value)
    terminalView.font = UIFont.monospacedSystemFont(
      ofSize: points,
      weight: .regular
    )
  }

  func focus(_ nonce: Int?) {
    guard let nonce, nonce != latestFocusNonce else {
      return
    }
    latestFocusNonce = nonce
    DispatchQueue.main.async { [weak self] in
      _ = self?.terminalView.becomeFirstResponder()
    }
  }

  func armControl(_ nonce: Int?) {
    guard let nonce, nonce != latestControlNonce else {
      return
    }
    latestControlNonce = nonce
    terminalView.controlModifier = true
    _ = terminalView.becomeFirstResponder()
  }

  func setUseMetal(_ enabled: Bool) {
    guard enabled != metalEnabled else {
      return
    }
    do {
      try terminalView.setUseMetal(enabled)
      metalEnabled = enabled
    } catch {
      metalEnabled = false
    }
  }

  public func sizeChanged(
    source: TerminalView,
    newCols: Int,
    newRows: Int
  ) {
    guard newCols > 0, newRows > 0 else {
      return
    }
    onResize(["cols": newCols, "rows": newRows])
  }

  public func send(source: TerminalView, data: ArraySlice<UInt8>) {
    onInput(["data": String(decoding: data, as: UTF8.self)])
  }

  public func requestOpenLink(
    source: TerminalView,
    link: String,
    params: [String: String]
  ) {
    onOpenLink(["url": link])
  }

  public func setTerminalTitle(source: TerminalView, title: String) {}
  public func hostCurrentDirectoryUpdate(
    source: TerminalView,
    directory: String?
  ) {}
  public func scrolled(source: TerminalView, position: Double) {}
  public func bell(source: TerminalView) {}
  public func clipboardCopy(source: TerminalView, content: Data) {
    UIPasteboard.general.string = String(data: content, encoding: .utf8)
  }
  public func clipboardRead(source: TerminalView) -> Data? {
    UIPasteboard.general.string?.data(using: .utf8)
  }
  public func iTermContent(
    source: TerminalView,
    content: ArraySlice<UInt8>
  ) {}
  public func rangeChanged(
    source: TerminalView,
    startY: Int,
    endY: Int
  ) {}
}
