import ExpoModulesCore
import GhosttyVt
import UIKit

public enum ZuseTerminalSettings {
  public static func fontSize(_ value: Double?) -> Double {
    min(max(value ?? 12, 9), 24)
  }
}

enum ZuseTerminalPointerDisposition: Equatable {
  case remote
  case localSelection
  case localScroll
  case ignored
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
    }
  }
}

public final class ZuseMobileTerminalView: ExpoView, UIKeyInput {
  private enum Layout {
    static let horizontalPadding: CGFloat = 4
    static let verticalPadding: CGFloat = 2
  }

  private let emulator = ZuseGhosttyEmulator()
  private var terminalFrame: ZuseTerminalFrame?
  private var latestFeedSequence = -1
  private var latestFocusNonce = -1
  private var latestControlNonce = -1
  private var reportedGrid: (cols: Int, rows: Int)?
  private var controlArmed = false
  private var controlArmedHardwareKeys = Set<Int>()
  private var suppressedHardwareKeys = Set<Int>()
  private var fontSize: CGFloat = 12
  private var cellWidth: CGFloat = 8
  private var cellHeight: CGFloat = 16
  private var blinkPhase = true
  private var blinkTimer: Timer?
  private var selectionAutoscrollTimer: Timer?
  private var selectionAutoscrollLocation: CGPoint?
  private var isApplicationInactive = false
  private var scrollTranslation: CGFloat = 0
  private var pointerScrollTranslation: CGFloat = 0
  private var activePointerDisposition: ZuseTerminalPointerDisposition?
  private var activePointerButton = GHOSTTY_MOUSE_BUTTON_UNKNOWN
  private var activePointerLocation = CGPoint.zero
  private var activePointerModifierFlags: UIKeyModifierFlags = []
  private var notificationTokens: [NSObjectProtocol] = []
  private var regularFont = UIFont.monospacedSystemFont(ofSize: 12, weight: .regular)
  private var boldFont = UIFont.monospacedSystemFont(ofSize: 12, weight: .semibold)
  private var italicFont = UIFont.monospacedSystemFont(ofSize: 12, weight: .regular)
  private var boldItalicFont = UIFont.monospacedSystemFont(ofSize: 12, weight: .semibold)

  private let foreground = UIColor(red: 0.91, green: 0.92, blue: 0.94, alpha: 1)
  private let terminalBackground = UIColor.black
  private let selection = UIColor(red: 0.20, green: 0.40, blue: 0.72, alpha: 1)
  private let selectionForeground = UIColor.white

  let onInput = EventDispatcher()
  let onResize = EventDispatcher()
  let onOpenLink = EventDispatcher()

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    isOpaque = true
    clipsToBounds = true
    contentMode = .redraw
    backgroundColor = terminalBackground
    isAccessibilityElement = true
    accessibilityLabel = "Terminal"
    accessibilityHint = "Terminal output. Swipe vertically to review scrollback."
    accessibilityTraits = [.updatesFrequently]
    rebuildFonts()
    emulator?.setPalette(
      foreground: foreground,
      background: terminalBackground,
      cursor: foreground
    )
    installGestures()
    observeApplicationLifecycle()
  }

  deinit {
    blinkTimer?.invalidate()
    selectionAutoscrollTimer?.invalidate()
    for token in notificationTokens {
      NotificationCenter.default.removeObserver(token)
    }
  }

  public override var canBecomeFirstResponder: Bool { true }
  public var hasText: Bool { true }

  public func insertText(_ text: String) {
    let normalized: String
    if text == "\n" || text == "\r\n" {
      normalized = "\r"
    } else if controlArmed,
              text.unicodeScalars.count == 1,
              let scalar = text.lowercased().unicodeScalars.first,
              scalar.value >= 97,
              scalar.value <= 122,
              let control = UnicodeScalar(scalar.value - 96)
    {
      normalized = String(control)
    } else {
      normalized = text
    }
    controlArmed = false
    emitInput(Data(normalized.utf8))
  }

  public func deleteBackward() {
    controlArmed = false
    emitInput(Data([0x7F]))
  }

  public override func pressesBegan(
    _ presses: Set<UIPress>,
    with event: UIPressesEvent?
  ) {
    let unhandled = unhandledHardwarePresses(presses, phase: .began)
    if !unhandled.isEmpty { super.pressesBegan(unhandled, with: event) }
  }

  public override func pressesEnded(
    _ presses: Set<UIPress>,
    with event: UIPressesEvent?
  ) {
    let unhandled = unhandledHardwarePresses(presses, phase: .ended)
    if !unhandled.isEmpty { super.pressesEnded(unhandled, with: event) }
  }

  public override func pressesChanged(
    _ presses: Set<UIPress>,
    with event: UIPressesEvent?
  ) {
    let unhandled = unhandledHardwarePresses(presses, phase: .changed)
    if !unhandled.isEmpty { super.pressesChanged(unhandled, with: event) }
  }

  public override func pressesCancelled(
    _ presses: Set<UIPress>,
    with event: UIPressesEvent?
  ) {
    let unhandled = unhandledHardwarePresses(presses, phase: .cancelled)
    if !unhandled.isEmpty { super.pressesCancelled(unhandled, with: event) }
  }

  public override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
    guard let pointer = touches.first(where: { $0.type == .indirectPointer }) else {
      super.touchesBegan(touches, with: event)
      return
    }
    handlePointer(
      action: GHOSTTY_MOUSE_ACTION_PRESS,
      button: pointerButton(for: event?.buttonMask ?? .primary),
      modifierFlags: event?.modifierFlags ?? [],
      location: pointer.location(in: self)
    )
  }

  public override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
    guard let pointer = touches.first(where: { $0.type == .indirectPointer }) else {
      super.touchesMoved(touches, with: event)
      return
    }
    handlePointer(
      action: GHOSTTY_MOUSE_ACTION_MOTION,
      button: activePointerButton,
      modifierFlags: event?.modifierFlags ?? activePointerModifierFlags,
      location: pointer.location(in: self)
    )
  }

  public override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
    guard let pointer = touches.first(where: { $0.type == .indirectPointer }) else {
      super.touchesEnded(touches, with: event)
      return
    }
    handlePointer(
      action: GHOSTTY_MOUSE_ACTION_RELEASE,
      button: activePointerButton,
      modifierFlags: event?.modifierFlags ?? activePointerModifierFlags,
      location: pointer.location(in: self)
    )
  }

  public override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
    guard let pointer = touches.first(where: { $0.type == .indirectPointer }) else {
      super.touchesCancelled(touches, with: event)
      return
    }
    handlePointer(
      action: GHOSTTY_MOUSE_ACTION_RELEASE,
      button: activePointerButton,
      modifierFlags: event?.modifierFlags ?? activePointerModifierFlags,
      location: pointer.location(in: self)
    )
  }

  public override func canPerformAction(
    _ action: Selector,
    withSender sender: Any?
  ) -> Bool {
    if action == #selector(copy(_:)) { return emulator?.selectionText() != nil }
    if action == #selector(paste(_:)) { return UIPasteboard.general.hasStrings }
    if action == #selector(selectAll(_:)) { return terminalFrame != nil }
    return super.canPerformAction(action, withSender: sender)
  }

  public override func copy(_ sender: Any?) {
    guard let text = emulator?.selectionText(), !text.isEmpty else { return }
    UIPasteboard.general.string = text
    UIAccessibility.post(notification: .announcement, argument: "Terminal selection copied")
  }

  public override func paste(_ sender: Any?) {
    guard let text = UIPasteboard.general.string else { return }
    emitInput(emulator?.encodePaste(text) ?? Data())
  }

  public override func selectAll(_ sender: Any?) {
    emulator?.selectAll()
    updateFrame(forceFullRedraw: false)
  }

  public override func accessibilityScroll(
    _ direction: UIAccessibilityScrollDirection
  ) -> Bool {
    let page = max(1, Int(emulator?.rows ?? 24) - 1)
    switch direction {
    case .up, .left:
      emulator?.scroll(rows: -page)
    case .down, .right:
      emulator?.scroll(rows: page)
    default:
      return false
    }
    updateFrame(forceFullRedraw: false)
    return true
  }

  public override func becomeFirstResponder() -> Bool {
    let wasFirstResponder = isFirstResponder
    let became = super.becomeFirstResponder()
    if became && !wasFirstResponder { emitInput(emulator?.encodeFocus(true) ?? Data()) }
    return became
  }

  public override func resignFirstResponder() -> Bool {
    let wasFirstResponder = isFirstResponder
    let resigned = super.resignFirstResponder()
    if resigned && wasFirstResponder {
      resetTransientInputState()
      emitInput(emulator?.encodeFocus(false) ?? Data())
    }
    return resigned
  }

  public override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil {
      resetTransientInputState()
      emulator?.cancelSelectionGesture()
      stopBlinkTimer()
      stopSelectionAutoscroll()
    } else {
      updateBlinkTimer()
    }
  }

  func feed(_ value: String?) {
    guard let value else {
      latestFeedSequence = -1
      return
    }
    guard let separator = value.firstIndex(of: "\u{0}") else { return }
    let sequenceText = value[..<separator]
    guard let sequence = Int(sequenceText), sequence > latestFeedSequence else { return }
    latestFeedSequence = sequence
    let dataStart = value.index(after: separator)
    let result = emulator?.feed(Data(value[dataStart...].utf8))
      ?? ZuseGhosttyFeedResult(replies: Data(), resetEpoch: false)
    if result.resetEpoch {
      resetTransientInputState(sendPointerRelease: false)
    }
    emitInput(result.replies)
    emitInput(emulator?.encodeFocus(isFirstResponder) ?? Data())
    updateFrame(forceFullRedraw: false)
  }

  func setFontSize(_ value: Double?) {
    let next = CGFloat(ZuseTerminalSettings.fontSize(value))
    guard next != fontSize else { return }
    fontSize = next
    rebuildFonts()
    setNeedsLayout()
    updateFrame(forceFullRedraw: true)
  }

  func focus(_ nonce: Int?) {
    guard let nonce, nonce != latestFocusNonce else { return }
    latestFocusNonce = nonce
    DispatchQueue.main.async { [weak self] in self?.requestFocus() }
  }

  func armControl(_ nonce: Int?) {
    guard let nonce, nonce != latestControlNonce else { return }
    latestControlNonce = nonce
    controlArmed = true
    requestFocus()
  }

  @discardableResult
  func handlePointer(
    action: GhosttyMouseAction,
    button: GhosttyMouseButton,
    modifierFlags: UIKeyModifierFlags,
    location: CGPoint
  ) -> ZuseTerminalPointerDisposition {
    activePointerLocation = location
    activePointerModifierFlags = modifierFlags

    if action == GHOSTTY_MOUSE_ACTION_PRESS {
      requestFocus()
      if activePointerDisposition != nil { cancelActivePointer() }
      activePointerButton = button
      activePointerLocation = location
      activePointerModifierFlags = modifierFlags
      if modifierFlags.contains(.shift) {
        if button == GHOSTTY_MOUSE_BUTTON_LEFT {
          beginLocalPointerSelection(at: location)
          activePointerDisposition = .localSelection
          return .localSelection
        }
        clearActivePointer()
        return .ignored
      }
      let encoded = encodePointer(
        action: action,
        button: button,
        modifierFlags: modifierFlags,
        location: location
      )
      if !encoded.isEmpty {
        emitInput(encoded)
        activePointerDisposition = .remote
        return .remote
      }
      if button == GHOSTTY_MOUSE_BUTTON_LEFT {
        beginLocalPointerSelection(at: location)
        activePointerDisposition = .localSelection
        return .localSelection
      }
      clearActivePointer()
      return .ignored
    }

    if action == GHOSTTY_MOUSE_ACTION_MOTION {
      if activePointerDisposition == .localSelection {
        updateLocalPointerSelection(at: location)
        return .localSelection
      }
      if activePointerDisposition == .remote {
        emitInput(
          encodePointer(
            action: action,
            button: activePointerButton,
            modifierFlags: modifierFlags,
            location: location
          )
        )
        return .remote
      }
      guard !modifierFlags.contains(.shift) else { return .ignored }
      let encoded = encodePointer(
        action: action,
        button: button,
        modifierFlags: modifierFlags,
        location: location
      )
      guard !encoded.isEmpty else { return .ignored }
      emitInput(encoded)
      return .remote
    }

    guard action == GHOSTTY_MOUSE_ACTION_RELEASE else { return .ignored }
    if activePointerDisposition == .localSelection {
      endLocalPointerSelection(at: location, hasPosition: bounds.contains(location))
      clearActivePointer()
      return .localSelection
    }
    if activePointerDisposition == .remote {
      emitInput(
        encodePointer(
          action: action,
          button: activePointerButton,
          modifierFlags: modifierFlags,
          location: location
        )
      )
      clearActivePointer()
      return .remote
    }
    return .ignored
  }

  @discardableResult
  func handlePointerScroll(
    rows: Int,
    modifierFlags: UIKeyModifierFlags,
    location: CGPoint
  ) -> ZuseTerminalPointerDisposition {
    guard rows != 0 else { return .ignored }
    requestFocus()
    if !modifierFlags.contains(.shift) {
      let button = rows < 0
        ? GHOSTTY_MOUSE_BUTTON_FOUR
        : GHOSTTY_MOUSE_BUTTON_FIVE
      let count = min(64, abs(rows))
      let first = encodePointer(
        action: GHOSTTY_MOUSE_ACTION_PRESS,
        button: button,
        modifierFlags: modifierFlags,
        location: location
      )
      if !first.isEmpty {
        emitInput(first)
        if count > 1 {
          for _ in 1..<count {
            emitInput(
              encodePointer(
                action: GHOSTTY_MOUSE_ACTION_PRESS,
                button: button,
                modifierFlags: modifierFlags,
                location: location
              )
            )
          }
        }
        return .remote
      }
    }
    emulator?.scroll(rows: rows)
    updateFrame(forceFullRedraw: false)
    return .localScroll
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    guard bounds.width > 0, bounds.height > 0 else { return }
    let measuredWidth = ceil(("M" as NSString).size(withAttributes: [.font: regularFont]).width)
    cellWidth = max(1, measuredWidth)
    cellHeight = max(1, ceil(regularFont.lineHeight * 1.15))
    let usableWidth = max(1, bounds.width - Layout.horizontalPadding * 2)
    let usableHeight = max(1, bounds.height - Layout.verticalPadding * 2)
    let cols = max(1, Int(usableWidth / cellWidth))
    let rows = max(1, Int(usableHeight / cellHeight))
    let result = emulator?.resize(
      cols: cols,
      rows: rows,
      cellWidth: cellWidth,
      cellHeight: cellHeight,
      displayScale: window?.screen.scale ?? UIScreen.main.scale
    )
    emitInput(result?.replies ?? Data())
    if result?.applied == true,
       reportedGrid?.cols != cols || reportedGrid?.rows != rows
    {
      reportedGrid = (cols, rows)
      onResize(["cols": cols, "rows": rows])
    }
    updateFrame(forceFullRedraw: result?.gridChanged == true)
  }

  public override func draw(_ rect: CGRect) {
    guard let context = UIGraphicsGetCurrentContext() else { return }
    guard let frame = terminalFrame else {
      terminalBackground.setFill()
      context.fill(rect)
      if emulator == nil {
        let attributes: [NSAttributedString.Key: Any] = [
          .font: regularFont,
          .foregroundColor: foreground.withAlphaComponent(0.65),
        ]
        ("Terminal renderer unavailable" as NSString).draw(
          at: CGPoint(x: Layout.horizontalPadding, y: Layout.verticalPadding),
          withAttributes: attributes
        )
      }
      return
    }

    frame.background.setFill()
    context.fill(rect)
    let rowRange = visibleRows(in: rect, frame: frame)
    guard !rowRange.isEmpty else { return }
    context.saveGState()
    context.clip(to: rect)

    // Paint all backgrounds before any glyph. A wide glyph may extend into its
    // spacer-tail cell, so interleaving the two passes would erase its tail.
    for row in rowRange {
      for col in 0..<frame.cols {
        let cell = frame.cells[row][col]
        cell.background.setFill()
        context.fill(cellRect(row: row, col: col))
      }
    }
    for row in rowRange {
      for col in 0..<frame.cols {
        let cell = frame.cells[row][col]
        if cell.wide == 2 || cell.wide == 3 { continue }
        if cell.blink && !blinkPhase { continue }
        drawCell(cell, row: row, col: col, context: context)
      }
    }
    if frame.cursorVisible,
       (!frame.cursorBlinking || blinkPhase),
       rowRange.contains(frame.cursorY),
       frame.cursorX >= 0,
       frame.cursorX < frame.cols
    {
      drawCursor(frame, context: context)
    }
    context.restoreGState()
  }

  private func installGestures() {
    let directTouchTypes = [
      NSNumber(value: UITouch.TouchType.direct.rawValue),
      NSNumber(value: UITouch.TouchType.pencil.rawValue),
    ]
    let singleTap = UITapGestureRecognizer(target: self, action: #selector(handleTap(_:)))
    let doubleTap = UITapGestureRecognizer(target: self, action: #selector(handleDoubleTap(_:)))
    doubleTap.numberOfTapsRequired = 2
    let tripleTap = UITapGestureRecognizer(target: self, action: #selector(handleTripleTap(_:)))
    tripleTap.numberOfTapsRequired = 3
    singleTap.require(toFail: doubleTap)
    doubleTap.require(toFail: tripleTap)

    let selectionPress = UILongPressGestureRecognizer(
      target: self,
      action: #selector(handleSelectionPress(_:))
    )
    selectionPress.minimumPressDuration = 0.35
    selectionPress.allowableMovement = 12

    let scroll = UIPanGestureRecognizer(target: self, action: #selector(handleScroll(_:)))
    scroll.maximumNumberOfTouches = 1
    scroll.allowedScrollTypesMask = []

    for recognizer in [singleTap, doubleTap, tripleTap, selectionPress, scroll] {
      recognizer.allowedTouchTypes = directTouchTypes
    }

    addGestureRecognizer(singleTap)
    addGestureRecognizer(doubleTap)
    addGestureRecognizer(tripleTap)
    addGestureRecognizer(selectionPress)
    addGestureRecognizer(scroll)

    let indirectPointer = [NSNumber(value: UITouch.TouchType.indirectPointer.rawValue)]
    let hover = UIHoverGestureRecognizer(target: self, action: #selector(handlePointerHover(_:)))
    hover.allowedTouchTypes = indirectPointer
    addGestureRecognizer(hover)

    let pointerScroll = UIPanGestureRecognizer(
      target: self,
      action: #selector(handlePointerScrollGesture(_:))
    )
    pointerScroll.allowedTouchTypes = []
    pointerScroll.allowedScrollTypesMask = [.continuous, .discrete]
    addGestureRecognizer(pointerScroll)
  }

  private func observeApplicationLifecycle() {
    let center = NotificationCenter.default
    notificationTokens.append(
      center.addObserver(
        forName: UIApplication.willResignActiveNotification,
        object: nil,
        queue: .main
      ) { [weak self] _ in
        self?.isApplicationInactive = true
        self?.resetTransientInputState()
        self?.emulator?.cancelSelectionGesture()
        self?.emitInput(self?.emulator?.encodeFocus(false) ?? Data())
        self?.stopBlinkTimer()
        self?.stopSelectionAutoscroll()
      }
    )
    notificationTokens.append(
      center.addObserver(
        forName: UIApplication.didBecomeActiveNotification,
        object: nil,
        queue: .main
      ) { [weak self] _ in
        self?.isApplicationInactive = false
        self?.blinkPhase = true
        self?.invalidateBlinkingContent()
        self?.emitInput(self?.emulator?.encodeFocus(self?.isFirstResponder == true) ?? Data())
        self?.updateFrame(forceFullRedraw: false)
      }
    )
  }

  @objc private func requestFocus() {
    _ = becomeFirstResponder()
  }

  @objc private func handleTap(_ recognizer: UITapGestureRecognizer) {
    requestFocus()
    let point = terminalCell(at: recognizer.location(in: self))
    if let url = emulator?.hyperlinkAt(x: point.x, y: point.y), !url.isEmpty {
      onOpenLink(["url": url])
      return
    }
    emulator?.clearSelection()
    updateFrame(forceFullRedraw: false)
  }

  @objc private func handleDoubleTap(_ recognizer: UITapGestureRecognizer) {
    requestFocus()
    let point = terminalCell(at: recognizer.location(in: self))
    emulator?.selectWord(x: point.x, y: point.y)
    updateFrame(forceFullRedraw: false)
  }

  @objc private func handleTripleTap(_ recognizer: UITapGestureRecognizer) {
    requestFocus()
    let point = terminalCell(at: recognizer.location(in: self))
    emulator?.selectLine(x: point.x, y: point.y)
    updateFrame(forceFullRedraw: false)
  }

  @objc private func handleSelectionPress(_ recognizer: UILongPressGestureRecognizer) {
    requestFocus()
    let location = recognizer.location(in: self)
    let point = terminalCell(at: location)
    switch recognizer.state {
    case .began:
      stopSelectionAutoscroll()
      emulator?.selectionPress(
        x: point.x,
        y: point.y,
        surfaceX: location.x,
        surfaceY: location.y,
        time: ProcessInfo.processInfo.systemUptime
      )
      updateFrame(forceFullRedraw: false)
    case .changed:
      emulator?.selectionDrag(
        x: point.x,
        y: point.y,
        surfaceX: location.x,
        surfaceY: location.y,
        rectangle: false,
        columns: Int(emulator?.cols ?? 1),
        cellWidth: cellWidth,
        paddingLeft: Layout.horizontalPadding,
        screenHeight: bounds.height
      )
      updateSelectionAutoscroll(for: location)
      updateFrame(forceFullRedraw: false)
    case .ended:
      stopSelectionAutoscroll()
      emulator?.selectionRelease(x: point.x, y: point.y, hasPosition: bounds.contains(location))
      updateFrame(forceFullRedraw: false)
      if emulator?.selectionText() != nil {
        UIMenuController.shared.showMenu(
          from: self,
          rect: CGRect(origin: location, size: CGSize(width: 1, height: 1))
        )
      }
    case .cancelled, .failed:
      stopSelectionAutoscroll()
      emulator?.selectionRelease(x: point.x, y: point.y, hasPosition: false)
    default:
      break
    }
  }

  @objc private func handleScroll(_ recognizer: UIPanGestureRecognizer) {
    requestFocus()
    switch recognizer.state {
    case .began:
      scrollTranslation = 0
    case .changed:
      let translation = recognizer.translation(in: self).y
      let delta = Int((scrollTranslation - translation) / max(1, cellHeight))
      guard delta != 0 else { return }
      scrollTranslation -= CGFloat(delta) * cellHeight
      emulator?.scroll(rows: delta)
      updateFrame(forceFullRedraw: false)
    case .ended, .cancelled, .failed:
      scrollTranslation = 0
    default:
      break
    }
  }

  @objc private func handlePointerHover(_ recognizer: UIHoverGestureRecognizer) {
    guard recognizer.state == .began || recognizer.state == .changed else { return }
    handlePointer(
      action: GHOSTTY_MOUSE_ACTION_MOTION,
      button: GHOSTTY_MOUSE_BUTTON_UNKNOWN,
      modifierFlags: recognizer.modifierFlags,
      location: recognizer.location(in: self)
    )
  }

  @objc private func handlePointerScrollGesture(_ recognizer: UIPanGestureRecognizer) {
    switch recognizer.state {
    case .began:
      pointerScrollTranslation = 0
    case .changed:
      let translation = recognizer.translation(in: self).y
      let rows = Int((pointerScrollTranslation - translation) / max(1, cellHeight))
      guard rows != 0 else { return }
      pointerScrollTranslation -= CGFloat(rows) * cellHeight
      handlePointerScroll(
        rows: rows,
        modifierFlags: recognizer.modifierFlags,
        location: recognizer.location(in: self)
      )
    case .ended, .cancelled, .failed:
      pointerScrollTranslation = 0
    default:
      break
    }
  }

  private func encodePointer(
    action: GhosttyMouseAction,
    button: GhosttyMouseButton,
    modifierFlags: UIKeyModifierFlags,
    location: CGPoint
  ) -> Data {
    let scale = window?.screen.scale ?? UIScreen.main.scale
    let contentLocation = CGPoint(
      x: max(0, location.x - Layout.horizontalPadding) * scale,
      y: max(0, location.y - Layout.verticalPadding) * scale
    )
    let contentSize = CGSize(
      width: max(1, bounds.width - Layout.horizontalPadding * 2) * scale,
      height: max(1, bounds.height - Layout.verticalPadding * 2) * scale
    )
    let pointerModifiers = ZuseTerminalKeyboard.modifiers(
      shift: modifierFlags.contains(.shift),
      control: modifierFlags.contains(.control),
      alternate: modifierFlags.contains(.alternate),
      command: modifierFlags.contains(.command),
      capsLock: modifierFlags.contains(.alphaShift)
    )
    return emulator?.encodeMouse(
      action: action,
      button: button,
      modifiers: pointerModifiers,
      location: contentLocation,
      screenSize: contentSize,
      cellSize: CGSize(width: cellWidth * scale, height: cellHeight * scale)
    ) ?? Data()
  }

  func pointerButton(for mask: UIEvent.ButtonMask) -> GhosttyMouseButton {
    if mask.contains(.button(3)) { return GHOSTTY_MOUSE_BUTTON_MIDDLE }
    if mask.contains(.secondary) { return GHOSTTY_MOUSE_BUTTON_RIGHT }
    return GHOSTTY_MOUSE_BUTTON_LEFT
  }

  private func beginLocalPointerSelection(at location: CGPoint) {
    stopSelectionAutoscroll()
    let point = terminalCell(at: location)
    emulator?.selectionPress(
      x: point.x,
      y: point.y,
      surfaceX: location.x,
      surfaceY: location.y,
      time: ProcessInfo.processInfo.systemUptime
    )
    updateFrame(forceFullRedraw: false)
  }

  private func updateLocalPointerSelection(at location: CGPoint) {
    let point = terminalCell(at: location)
    emulator?.selectionDrag(
      x: point.x,
      y: point.y,
      surfaceX: location.x,
      surfaceY: location.y,
      rectangle: false,
      columns: Int(emulator?.cols ?? 1),
      cellWidth: cellWidth,
      paddingLeft: Layout.horizontalPadding,
      screenHeight: bounds.height
    )
    updateSelectionAutoscroll(for: location)
    updateFrame(forceFullRedraw: false)
  }

  private func endLocalPointerSelection(
    at location: CGPoint,
    hasPosition: Bool
  ) {
    stopSelectionAutoscroll()
    let point = terminalCell(at: location)
    emulator?.selectionRelease(
      x: point.x,
      y: point.y,
      hasPosition: hasPosition
    )
    updateFrame(forceFullRedraw: false)
    if window != nil, emulator?.selectionText() != nil {
      UIMenuController.shared.showMenu(
        from: self,
        rect: CGRect(origin: location, size: CGSize(width: 1, height: 1))
      )
    }
  }

  private func cancelActivePointer() {
    if activePointerDisposition == .remote {
      emitInput(
        encodePointer(
          action: GHOSTTY_MOUSE_ACTION_RELEASE,
          button: activePointerButton,
          modifierFlags: activePointerModifierFlags,
          location: activePointerLocation
        )
      )
    } else if activePointerDisposition == .localSelection {
      endLocalPointerSelection(at: activePointerLocation, hasPosition: false)
    }
    emulator?.cancelMouseGesture()
    clearActivePointer()
  }

  private func clearActivePointer() {
    activePointerDisposition = nil
    activePointerButton = GHOSTTY_MOUSE_BUTTON_UNKNOWN
    activePointerLocation = .zero
    activePointerModifierFlags = []
  }

  private func handleHardwarePress(
    _ press: UIPress,
    action: GhosttyKeyAction
  ) -> Bool {
    guard let key = press.key else { return false }
    let usage = Int(key.keyCode.rawValue)
    if suppressedHardwareKeys.contains(usage), action != GHOSTTY_KEY_ACTION_PRESS {
      if action == GHOSTTY_KEY_ACTION_RELEASE { suppressedHardwareKeys.remove(usage) }
      return true
    }
    let flags = key.modifierFlags
    let shortcut = key.charactersIgnoringModifiers.lowercased()
    if action == GHOSTTY_KEY_ACTION_PRESS,
       flags.contains(.command),
       !flags.contains(.control),
       !flags.contains(.alternate)
    {
      switch shortcut {
      case "c": copy(nil)
      case "v": paste(nil)
      case "a": selectAll(nil)
      default: break
      }
      if shortcut == "c" || shortcut == "v" || shortcut == "a" {
        suppressedHardwareKeys.insert(usage)
        return true
      }
    }

    var modifiers = ZuseTerminalKeyboard.modifiers(
      shift: flags.contains(.shift),
      control: flags.contains(.control),
      alternate: flags.contains(.alternate),
      command: flags.contains(.command),
      capsLock: flags.contains(.alphaShift)
    )
    if action == GHOSTTY_KEY_ACTION_PRESS, controlArmed {
      modifiers |= 1 << 1
      controlArmed = false
      controlArmedHardwareKeys.insert(usage)
    } else if action != GHOSTTY_KEY_ACTION_PRESS,
              controlArmedHardwareKeys.contains(usage) {
      modifiers |= 1 << 1
      if action == GHOSTTY_KEY_ACTION_RELEASE { controlArmedHardwareKeys.remove(usage) }
    }
    let text = action == GHOSTTY_KEY_ACTION_RELEASE ? nil : terminalText(for: key)
    var consumed: UInt16 = 0
    if text != nil, flags.contains(.shift) { consumed |= 1 }
    if text != nil, flags.contains(.alphaShift) { consumed |= 1 << 4 }
    emitInput(
      emulator?.encodeKey(
        code: ZuseTerminalKeyboard.ghosttyKeyCode(forHIDUsage: usage),
        text: text,
        unshiftedCodepoint: terminalUnshiftedCodepoint(for: key),
        modifiers: modifiers,
        consumedModifiers: consumed,
        action: action
      ) ?? Data()
    )
    return true
  }

  private func unhandledHardwarePresses(
    _ presses: Set<UIPress>,
    phase: ZuseTerminalHardwarePressPhase
  ) -> Set<UIPress> {
    guard let action = ZuseTerminalKeyboard.ghosttyAction(
      forHardwarePressPhase: phase
    ) else { return presses }
    var unhandled = Set<UIPress>()
    for press in presses where !handleHardwarePress(press, action: action) {
      unhandled.insert(press)
    }
    return unhandled
  }

  private func terminalText(for key: UIKey) -> String? {
    let text = key.characters
    guard !text.isEmpty else { return nil }
    for scalar in text.unicodeScalars {
      if scalar.value < 0x20 || scalar.value == 0x7F
        || (scalar.value >= 0xF700 && scalar.value <= 0xF8FF)
      {
        return nil
      }
    }
    return text
  }

  private func terminalUnshiftedCodepoint(for key: UIKey) -> UInt32 {
    let text = key.charactersIgnoringModifiers
    guard text.unicodeScalars.count == 1,
          let scalar = text.unicodeScalars.first,
          scalar.value >= 0x20,
          scalar.value != 0x7F,
          !(scalar.value >= 0xF700 && scalar.value <= 0xF8FF)
    else { return 0 }
    return scalar.value
  }

  private func terminalCell(at point: CGPoint) -> (x: Int, y: Int) {
    let maxX = max(0, Int(emulator?.cols ?? 1) - 1)
    let maxY = max(0, Int(emulator?.rows ?? 1) - 1)
    return (
      min(maxX, max(0, Int((point.x - Layout.horizontalPadding) / max(1, cellWidth)))),
      min(maxY, max(0, Int((point.y - Layout.verticalPadding) / max(1, cellHeight))))
    )
  }

  private func updateFrame(forceFullRedraw: Bool) {
    guard let snapshot = emulator?.snapshot(
      selectionColor: selection,
      selectionForeground: selectionForeground
    ) else {
      if emulator == nil { setNeedsDisplay() }
      return
    }
    terminalFrame = snapshot.frame
    accessibilityValue = snapshot.frame.accessibilityText
    if forceFullRedraw || snapshot.fullRedraw {
      setNeedsDisplay()
    } else {
      for row in snapshot.changedRows {
        setNeedsDisplay(rowRect(row))
      }
    }
    updateBlinkTimer()
  }

  private func updateBlinkTimer() {
    guard window != nil, !isApplicationInactive,
          terminalFrame?.cursorBlinking == true || terminalFrame?.blinkingRows.isEmpty == false
    else {
      stopBlinkTimer()
      blinkPhase = true
      return
    }
    guard blinkTimer == nil else { return }
    let timer = Timer(timeInterval: 0.53, repeats: true) { [weak self] _ in
      guard let self, let frame = self.terminalFrame else { return }
      self.blinkPhase.toggle()
      if frame.cursorY >= 0 { self.setNeedsDisplay(self.rowRect(frame.cursorY)) }
      for row in frame.blinkingRows { self.setNeedsDisplay(self.rowRect(row)) }
    }
    RunLoop.main.add(timer, forMode: .common)
    blinkTimer = timer
  }

  private func stopBlinkTimer() {
    blinkTimer?.invalidate()
    blinkTimer = nil
    blinkPhase = true
  }

  private func invalidateBlinkingContent() {
    guard let frame = terminalFrame else { return }
    if frame.cursorY >= 0 { setNeedsDisplay(rowRect(frame.cursorY)) }
    for row in frame.blinkingRows { setNeedsDisplay(rowRect(row)) }
  }

  private func updateSelectionAutoscroll(for location: CGPoint) {
    let edge: CGFloat = 3
    guard location.y <= edge || location.y > bounds.height - edge else {
      stopSelectionAutoscroll()
      return
    }
    selectionAutoscrollLocation = location
    guard selectionAutoscrollTimer == nil else { return }
    let timer = Timer(timeInterval: 0.05, repeats: true) { [weak self] _ in
      self?.performSelectionAutoscroll()
    }
    RunLoop.main.add(timer, forMode: .common)
    selectionAutoscrollTimer = timer
  }

  private func performSelectionAutoscroll() {
    guard !isApplicationInactive, window != nil,
          let location = selectionAutoscrollLocation,
          let emulator
    else {
      stopSelectionAutoscroll()
      return
    }
    let point = terminalCell(at: location)
    guard emulator.selectionAutoscrollTick(
      viewportX: point.x,
      viewportY: point.y,
      surfaceX: location.x,
      surfaceY: location.y,
      rectangle: false,
      columns: Int(emulator.cols),
      cellWidth: cellWidth,
      paddingLeft: Layout.horizontalPadding,
      screenHeight: bounds.height
    ) else {
      stopSelectionAutoscroll()
      return
    }
    updateFrame(forceFullRedraw: false)
  }

  private func stopSelectionAutoscroll() {
    selectionAutoscrollTimer?.invalidate()
    selectionAutoscrollTimer = nil
    selectionAutoscrollLocation = nil
  }

  private func resetTransientInputState(sendPointerRelease: Bool = true) {
    if sendPointerRelease {
      cancelActivePointer()
    } else {
      clearActivePointer()
    }
    stopSelectionAutoscroll()
    scrollTranslation = 0
    pointerScrollTranslation = 0
    controlArmed = false
    controlArmedHardwareKeys.removeAll(keepingCapacity: true)
    suppressedHardwareKeys.removeAll(keepingCapacity: true)
  }

  private func emitInput(_ data: Data) {
    guard !data.isEmpty else { return }
    onInput(["data": String(decoding: data, as: UTF8.self)])
  }

  private func rebuildFonts() {
    regularFont = UIFont.monospacedSystemFont(ofSize: fontSize, weight: .regular)
    boldFont = UIFont.monospacedSystemFont(ofSize: fontSize, weight: .semibold)
    italicFont = font(from: regularFont, traits: .traitItalic)
    boldItalicFont = font(from: boldFont, traits: [.traitBold, .traitItalic])
  }

  private func font(
    from base: UIFont,
    traits: UIFontDescriptor.SymbolicTraits
  ) -> UIFont {
    guard let descriptor = base.fontDescriptor.withSymbolicTraits(traits) else { return base }
    return UIFont(descriptor: descriptor, size: fontSize)
  }

  private func font(for cell: ZuseTerminalCell) -> UIFont {
    switch (cell.bold, cell.italic) {
    case (true, true): return boldItalicFont
    case (true, false): return boldFont
    case (false, true): return italicFont
    case (false, false): return regularFont
    }
  }

  private func visibleRows(
    in rect: CGRect,
    frame: ZuseTerminalFrame
  ) -> Range<Int> {
    let first = max(
      0,
      min(frame.rows, Int(floor((rect.minY - Layout.verticalPadding) / cellHeight)))
    )
    let last = max(
      first,
      min(frame.rows, Int(ceil((rect.maxY - Layout.verticalPadding) / cellHeight)))
    )
    return first..<last
  }

  private func cellRect(row: Int, col: Int) -> CGRect {
    CGRect(
      x: Layout.horizontalPadding + CGFloat(col) * cellWidth,
      y: Layout.verticalPadding + CGFloat(row) * cellHeight,
      width: cellWidth,
      height: cellHeight
    )
  }

  private func rowRect(_ row: Int) -> CGRect {
    CGRect(
      x: 0,
      y: Layout.verticalPadding + CGFloat(row) * cellHeight - 1,
      width: bounds.width,
      height: cellHeight + 2
    )
  }

  private func drawCell(
    _ cell: ZuseTerminalCell,
    row: Int,
    col: Int,
    context: CGContext,
    foregroundOverride: UIColor? = nil
  ) {
    var rect = cellRect(row: row, col: col)
    if cell.wide == 1 { rect.size.width *= 2 }
    let font = font(for: cell)
    let color = (foregroundOverride ?? cell.foreground)
      .withAlphaComponent(cell.faint ? 0.55 : 1)
    if cell.text != " " && !cell.text.isEmpty {
      (cell.text as NSString).draw(
        at: CGPoint(
          x: rect.minX,
          y: rect.minY + max(0, (cellHeight - font.lineHeight) / 2)
        ),
        withAttributes: [
          .font: font,
          .foregroundColor: color,
        ]
      )
    }
    drawDecorations(cell, rect: rect, context: context)
  }

  private func drawDecorations(
    _ cell: ZuseTerminalCell,
    rect: CGRect,
    context: CGContext
  ) {
    context.saveGState()
    context.setLineWidth(1)
    if cell.underlineStyle > 0 {
      cell.underlineColor.setStroke()
      let y = rect.maxY - 2
      switch cell.underlineStyle {
      case 2:
        strokeLine(context, from: CGPoint(x: rect.minX, y: y - 2), to: CGPoint(x: rect.maxX, y: y - 2))
        strokeLine(context, from: CGPoint(x: rect.minX, y: y), to: CGPoint(x: rect.maxX, y: y))
      case 3:
        context.beginPath()
        context.move(to: CGPoint(x: rect.minX, y: y))
        var x = rect.minX
        var raised = false
        while x < rect.maxX {
          x = min(rect.maxX, x + 2)
          raised.toggle()
          context.addLine(to: CGPoint(x: x, y: y + (raised ? -1 : 1)))
        }
        context.strokePath()
      case 4:
        context.setLineDash(phase: 0, lengths: [1, 2])
        strokeLine(context, from: CGPoint(x: rect.minX, y: y), to: CGPoint(x: rect.maxX, y: y))
      case 5:
        context.setLineDash(phase: 0, lengths: [3, 2])
        strokeLine(context, from: CGPoint(x: rect.minX, y: y), to: CGPoint(x: rect.maxX, y: y))
      default:
        strokeLine(context, from: CGPoint(x: rect.minX, y: y), to: CGPoint(x: rect.maxX, y: y))
      }
    }
    cell.foreground.setStroke()
    if cell.strikethrough {
      let y = rect.midY
      strokeLine(context, from: CGPoint(x: rect.minX, y: y), to: CGPoint(x: rect.maxX, y: y))
    }
    if cell.overline {
      let y = rect.minY + 1
      strokeLine(context, from: CGPoint(x: rect.minX, y: y), to: CGPoint(x: rect.maxX, y: y))
    }
    context.restoreGState()
  }

  private func strokeLine(
    _ context: CGContext,
    from: CGPoint,
    to: CGPoint
  ) {
    context.beginPath()
    context.move(to: from)
    context.addLine(to: to)
    context.strokePath()
  }

  private func drawCursor(
    _ frame: ZuseTerminalFrame,
    context: CGContext
  ) {
    var rect = cellRect(row: frame.cursorY, col: frame.cursorX)
    if frame.cells[frame.cursorY][frame.cursorX].wide == 1 {
      rect.size.width *= 2
    }
    frame.cursorColor.setFill()
    frame.cursorColor.setStroke()
    switch frame.cursorStyle {
    case 0: // Bar
      context.fill(CGRect(x: rect.minX, y: rect.minY, width: 2, height: rect.height))
    case 2: // Underline
      context.fill(CGRect(x: rect.minX, y: rect.maxY - 2, width: rect.width, height: 2))
    case 3: // Hollow block
      context.setLineWidth(1.5)
      context.stroke(rect.insetBy(dx: 0.75, dy: 0.75))
    default: // Solid block
      context.fill(rect)
      let cell = frame.cells[frame.cursorY][frame.cursorX]
      drawCell(
        cell,
        row: frame.cursorY,
        col: frame.cursorX,
        context: context,
        foregroundOverride: frame.background
      )
    }
  }
}
