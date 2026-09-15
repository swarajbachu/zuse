import GhosttyVt
import UIKit

struct ZuseTerminalCell {
  let text: String
  let foreground: UIColor
  let background: UIColor
  let bold: Bool
  let italic: Bool
  let faint: Bool
  let blink: Bool
  let underlineStyle: Int
  let underlineColor: UIColor
  let strikethrough: Bool
  let overline: Bool
  let selected: Bool
  let wide: Int
}

final class ZuseTerminalFrame {
  let cols: Int
  let rows: Int
  let cells: [[ZuseTerminalCell]]
  let foreground: UIColor
  let background: UIColor
  let cursorX: Int
  let cursorY: Int
  let cursorVisible: Bool
  let cursorBlinking: Bool
  let cursorStyle: Int
  let cursorColor: UIColor
  let blinkingRows: IndexSet

  init(
    cols: Int,
    rows: Int,
    cells: [[ZuseTerminalCell]],
    foreground: UIColor,
    background: UIColor,
    cursorX: Int,
    cursorY: Int,
    cursorVisible: Bool,
    cursorBlinking: Bool,
    cursorStyle: Int,
    cursorColor: UIColor,
    blinkingRows: IndexSet
  ) {
    self.cols = cols
    self.rows = rows
    self.cells = cells
    self.foreground = foreground
    self.background = background
    self.cursorX = cursorX
    self.cursorY = cursorY
    self.cursorVisible = cursorVisible
    self.cursorBlinking = cursorBlinking
    self.cursorStyle = cursorStyle
    self.cursorColor = cursorColor
    self.blinkingRows = blinkingRows
  }

  var accessibilityText: String {
    cells.map { row in
      row.map(\.text).joined().trimmingCharacters(in: .whitespaces)
    }.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
  }
}

struct ZuseTerminalSnapshot {
  let frame: ZuseTerminalFrame
  let changedRows: IndexSet
  let fullRedraw: Bool
}

struct ZuseGhosttyFeedResult {
  let replies: Data
  let resetEpoch: Bool
}

enum ZuseTerminalHardwarePressPhase {
  case began
  case changed
  case ended
  case cancelled
}

enum ZuseTerminalKeyboard {
  static func ghosttyAction(
    forHardwarePressPhase phase: ZuseTerminalHardwarePressPhase
  ) -> GhosttyKeyAction? {
    switch phase {
    case .began: return GHOSTTY_KEY_ACTION_PRESS
    case .changed: return nil
    case .ended, .cancelled: return GHOSTTY_KEY_ACTION_RELEASE
    }
  }

  /// USB HID usage to the stable GhosttyKey raw value. Keeping this pure makes
  /// the hardware-key contract testable without a UIKit event synthesizer.
  static func ghosttyKeyCode(forHIDUsage usage: Int) -> Int {
    switch usage {
    case 0x04...0x1D: return 20 + usage - 0x04 // A...Z
    case 0x1E...0x26: return 7 + usage - 0x1E // 1...9
    case 0x27: return 6 // 0
    case 0x28: return 58 // Enter
    case 0x29: return 120 // Escape
    case 0x2A: return 53 // Backspace
    case 0x2B: return 64 // Tab
    case 0x2C: return 63 // Space
    case 0x2D: return 46 // Minus
    case 0x2E: return 16 // Equal
    case 0x2F: return 3 // BracketLeft
    case 0x30: return 4 // BracketRight
    case 0x31: return 2 // Backslash
    case 0x32: return 17 // IntlBackslash
    case 0x33: return 49 // Semicolon
    case 0x34: return 48 // Quote
    case 0x35: return 1 // Backquote
    case 0x36: return 5 // Comma
    case 0x37: return 47 // Period
    case 0x38: return 50 // Slash
    case 0x39: return 54 // CapsLock
    case 0x3A...0x52:
      switch usage {
      case 0x3A...0x45: return 121 + usage - 0x3A // F1...F12
      case 0x46: return 148 // PrintScreen
      case 0x47: return 149 // ScrollLock
      case 0x48: return 150 // Pause
      case 0x49: return 72 // Insert
      case 0x4A: return 71 // Home
      case 0x4B: return 74 // PageUp
      case 0x4C: return 68 // Delete
      case 0x4D: return 69 // End
      case 0x4E: return 73 // PageDown
      case 0x4F: return 77 // ArrowRight
      case 0x50: return 76 // ArrowLeft
      case 0x51: return 75 // ArrowDown
      case 0x52: return 78 // ArrowUp
      default: return 0
      }
    case 0x53: return 79 // NumLock
    case 0x54: return 96 // NumpadDivide
    case 0x55: return 104 // NumpadMultiply
    case 0x56: return 107 // NumpadSubtract
    case 0x57: return 90 // NumpadAdd
    case 0x58: return 97 // NumpadEnter
    case 0x59...0x61:
      // HID is 1...9 then 0, while Ghostty's numpad digits are contiguous.
      return usage == 0x62 ? 80 : 81 + usage - 0x59
    case 0x62: return 80 // Numpad0
    case 0x63: return 95 // NumpadDecimal
    case 0x64: return 17 // IntlBackslash
    case 0x65: return 55 // ContextMenu
    case 0x75: return 70 // Help
    case 0x7F: return 170 // AudioVolumeMute
    case 0x80: return 171 // AudioVolumeUp
    case 0x81: return 169 // AudioVolumeDown
    case 0xE0: return 56 // ControlLeft
    case 0xE1: return 61 // ShiftLeft
    case 0xE2: return 51 // AltLeft
    case 0xE3: return 59 // MetaLeft
    case 0xE4: return 57 // ControlRight
    case 0xE5: return 62 // ShiftRight
    case 0xE6: return 52 // AltRight
    case 0xE7: return 60 // MetaRight
    default: return 0
    }
  }

  static func modifiers(
    shift: Bool,
    control: Bool,
    alternate: Bool,
    command: Bool,
    capsLock: Bool
  ) -> UInt16 {
    (shift ? 1 : 0)
      | (control ? 1 << 1 : 0)
      | (alternate ? 1 << 2 : 0)
      | (command ? 1 << 3 : 0)
      | (capsLock ? 1 << 4 : 0)
  }
}

final class ZuseGhosttyEmulator {
  private var terminal: GhosttyTerminal?
  private var renderState: GhosttyRenderState?
  private var rowIterator: GhosttyRenderStateRowIterator?
  private var rowCells: GhosttyRenderStateRowCells?
  private var keyEncoder: GhosttyKeyEncoder?
  private var keyEvent: GhosttyKeyEvent?
  private var outputQueue: OpaquePointer?
  private var focusController: OpaquePointer?
  private var mouseController: OpaquePointer?
  private var selectionController: OpaquePointer?
  private(set) var cols: UInt16 = 80
  private(set) var rows: UInt16 = 24
  private var cellWidthPixels: UInt32 = 1
  private var cellHeightPixels: UInt32 = 1
  private var foreground = GhosttyColorRgb(r: 232, g: 233, b: 235)
  private var background = GhosttyColorRgb(r: 11, g: 11, b: 12)
  private var cursor = GhosttyColorRgb(r: 232, g: 233, b: 235)
  private var cachedFrame: ZuseTerminalFrame?
  private var codepointScratch = Array(repeating: UInt32(0), count: 64)

  init?() {
    var options = GhosttyTerminalOptions(
      cols: cols,
      rows: rows,
      max_scrollback: 10_000
    )
    guard ghostty_terminal_new(nil, &terminal, options) == GHOSTTY_SUCCESS,
          ghostty_render_state_new(nil, &renderState) == GHOSTTY_SUCCESS,
          ghostty_render_state_row_iterator_new(nil, &rowIterator) == GHOSTTY_SUCCESS,
          ghostty_render_state_row_cells_new(nil, &rowCells) == GHOSTTY_SUCCESS,
          ghostty_key_encoder_new(nil, &keyEncoder) == GHOSTTY_SUCCESS,
          ghostty_key_event_new(nil, &keyEvent) == GHOSTTY_SUCCESS
    else {
      releaseResources()
      return nil
    }
    outputQueue = zuse_ghostty_output_queue_new()
    focusController = zuse_ghostty_focus_controller_new()
    mouseController = zuse_ghostty_mouse_controller_new()
    selectionController = zuse_ghostty_selection_controller_new()
    guard let outputQueue, let focusController, let mouseController,
          selectionController != nil,
          zuse_ghostty_output_queue_install(outputQueue, terminal) == GHOSTTY_SUCCESS
    else {
      releaseResources()
      return nil
    }
    zuse_ghostty_output_queue_set_size(
      outputQueue,
      cols,
      rows,
      cellWidthPixels,
      cellHeightPixels
    )
    zuse_ghostty_mouse_controller_sync(mouseController, terminal)
    zuse_ghostty_focus_controller_reset(focusController)
    applyPalette()
    var blink = true
    _ = ghostty_terminal_set(
      terminal,
      GHOSTTY_TERMINAL_OPT_DEFAULT_CURSOR_BLINK,
      &blink
    )
  }

  deinit {
    releaseResources()
  }

  func setPalette(foreground: UIColor, background: UIColor, cursor: UIColor) {
    self.foreground = Self.rgb(foreground)
    self.background = Self.rgb(background)
    self.cursor = Self.rgb(cursor)
    applyPalette()
    cachedFrame = nil
  }

  func feed(_ data: Data) -> ZuseGhosttyFeedResult {
    guard !data.isEmpty else {
      return ZuseGhosttyFeedResult(replies: drainReplies(), resetEpoch: false)
    }
    var resetEpoch = false
    data.withUnsafeBytes { raw in
      guard let bytes = raw.bindMemory(to: UInt8.self).baseAddress else { return }
      resetEpoch = zuse_ghostty_focus_controller_observe_vt_input(
        focusController,
        bytes,
        data.count
      )
      if resetEpoch {
        zuse_ghostty_selection_controller_reset(selectionController, terminal)
        zuse_ghostty_mouse_controller_reset(mouseController)
        cachedFrame = nil
      }
      ghostty_terminal_vt_write(terminal, bytes, data.count)
    }
    zuse_ghostty_mouse_controller_sync(mouseController, terminal)
    return ZuseGhosttyFeedResult(
      replies: drainReplies(),
      resetEpoch: resetEpoch
    )
  }

  func reset() -> Data {
    zuse_ghostty_selection_controller_reset(selectionController, terminal)
    ghostty_terminal_reset(terminal)
    zuse_ghostty_mouse_controller_reset(mouseController)
    zuse_ghostty_mouse_controller_sync(mouseController, terminal)
    zuse_ghostty_focus_controller_reset(focusController)
    cachedFrame = nil
    return drainReplies()
  }

  func resize(
    cols: Int,
    rows: Int,
    cellWidth: CGFloat,
    cellHeight: CGFloat,
    displayScale: CGFloat
  ) -> (applied: Bool, gridChanged: Bool, replies: Data) {
    let nextCols = UInt16(clamping: max(1, cols))
    let nextRows = UInt16(clamping: max(1, rows))
    let nextCellWidth = UInt32(clamping: max(1, Int((cellWidth * displayScale).rounded())))
    let nextCellHeight = UInt32(clamping: max(1, Int((cellHeight * displayScale).rounded())))
    let gridChanged = nextCols != self.cols || nextRows != self.rows
    guard gridChanged || nextCellWidth != cellWidthPixels || nextCellHeight != cellHeightPixels
    else { return (true, false, Data()) }
    guard ghostty_terminal_resize(
      terminal,
      nextCols,
      nextRows,
      nextCellWidth,
      nextCellHeight
    ) == GHOSTTY_SUCCESS else { return (false, false, drainReplies()) }
    self.cols = nextCols
    self.rows = nextRows
    cellWidthPixels = nextCellWidth
    cellHeightPixels = nextCellHeight
    zuse_ghostty_output_queue_set_size(
      outputQueue,
      nextCols,
      nextRows,
      nextCellWidth,
      nextCellHeight
    )
    return (true, gridChanged, drainReplies())
  }

  func encodeKey(
    code: Int,
    text: String?,
    unshiftedCodepoint: UInt32,
    modifiers: UInt16,
    consumedModifiers: UInt16,
    action: GhosttyKeyAction
  ) -> Data {
    guard let keyEncoder, let keyEvent else { return Data() }
    ghostty_key_encoder_setopt_from_terminal(keyEncoder, terminal)
    ghostty_key_event_set_action(keyEvent, action)
    zuse_ghostty_key_event_set_key_code(keyEvent, Int32(clamping: code))
    ghostty_key_event_set_mods(keyEvent, modifiers)
    ghostty_key_event_set_consumed_mods(keyEvent, consumedModifiers)
    ghostty_key_event_set_composing(keyEvent, false)
    ghostty_key_event_set_unshifted_codepoint(
      keyEvent,
      unshiftedCodepoint
    )
    if let text, !text.isEmpty {
      return text.utf8CString.withUnsafeBufferPointer { buffer in
        ghostty_key_event_set_utf8(keyEvent, buffer.baseAddress, max(0, buffer.count - 1))
        return encode { output, capacity, written in
          ghostty_key_encoder_encode(
            keyEncoder,
            keyEvent,
            output,
            capacity,
            written
          )
        }
      }
    }
    ghostty_key_event_set_utf8(keyEvent, nil, 0)
    return encode { output, capacity, written in
      ghostty_key_encoder_encode(keyEncoder, keyEvent, output, capacity, written)
    }
  }

  func encodePaste(_ text: String) -> Data {
    var input = Data(text.utf8)
    guard !input.isEmpty else { return Data() }
    return input.withUnsafeMutableBytes { raw in
      let pointer = raw.bindMemory(to: CChar.self).baseAddress
      return encode { output, capacity, written in
        zuse_ghostty_encode_paste(
          terminal,
          pointer,
          raw.count,
          output,
          capacity,
          written
        )
      }
    }
  }

  func encodeFocus(_ focused: Bool) -> Data {
    encode { output, capacity, written in
      zuse_ghostty_focus_controller_encode(
        focusController,
        terminal,
        focused,
        output,
        capacity,
        written
      )
    }
  }

  func encodeMouse(
    action: GhosttyMouseAction,
    button: GhosttyMouseButton,
    modifiers: UInt16,
    location: CGPoint,
    screenSize: CGSize,
    cellSize: CGSize
  ) -> Data {
    guard let mouseController,
          location.x.isFinite,
          location.y.isFinite,
          screenSize.width > 0,
          screenSize.height > 0,
          cellSize.width > 0,
          cellSize.height > 0
    else { return Data() }
    let encoded = encode { output, capacity, written in
      zuse_ghostty_mouse_encode(
        mouseController,
        action,
        button,
        modifiers,
        Float(location.x),
        Float(location.y),
        UInt32(clamping: Int(screenSize.width.rounded())),
        UInt32(clamping: Int(screenSize.height.rounded())),
        UInt32(clamping: Int(cellSize.width.rounded())),
        UInt32(clamping: Int(cellSize.height.rounded())),
        output,
        capacity,
        written
      )
    }
    return encoded.count <= 128 ? encoded : Data()
  }

  func cancelMouseGesture() {
    zuse_ghostty_mouse_controller_reset(mouseController)
    zuse_ghostty_mouse_controller_sync(mouseController, terminal)
  }

  func scroll(rows: Int) {
    guard rows != 0 else { return }
    zuse_ghostty_scroll_rows(terminal, rows)
  }

  func selectionPress(
    x: Int,
    y: Int,
    surfaceX: CGFloat,
    surfaceY: CGFloat,
    time: TimeInterval
  ) {
    _ = zuse_ghostty_selection_press(
      selectionController,
      terminal,
      UInt16(clamping: x),
      UInt32(clamping: y),
      Double(surfaceX),
      Double(surfaceY),
      UInt64(max(0, time) * 1_000_000_000)
    )
  }

  func selectionDrag(
    x: Int,
    y: Int,
    surfaceX: CGFloat,
    surfaceY: CGFloat,
    rectangle: Bool,
    columns: Int,
    cellWidth: CGFloat,
    paddingLeft: CGFloat,
    screenHeight: CGFloat
  ) {
    _ = zuse_ghostty_selection_drag(
      selectionController,
      terminal,
      UInt16(clamping: x),
      UInt32(clamping: y),
      Double(surfaceX),
      Double(surfaceY),
      rectangle,
      UInt32(clamping: columns),
      UInt32(clamping: max(1, Int(cellWidth.rounded()))),
      UInt32(clamping: max(0, Int(paddingLeft.rounded()))),
      UInt32(clamping: max(1, Int(screenHeight.rounded())))
    )
  }

  func selectionAutoscrollTick(
    viewportX: Int,
    viewportY: Int,
    surfaceX: CGFloat,
    surfaceY: CGFloat,
    rectangle: Bool,
    columns: Int,
    cellWidth: CGFloat,
    paddingLeft: CGFloat,
    screenHeight: CGFloat
  ) -> Bool {
    zuse_ghostty_selection_autoscroll_tick(
      selectionController,
      terminal,
      UInt16(clamping: viewportX),
      UInt32(clamping: viewportY),
      Double(surfaceX),
      Double(surfaceY),
      rectangle,
      UInt32(clamping: columns),
      UInt32(clamping: max(1, Int(cellWidth.rounded()))),
      UInt32(clamping: max(0, Int(paddingLeft.rounded()))),
      UInt32(clamping: max(1, Int(screenHeight.rounded())))
    ) == GHOSTTY_SUCCESS
  }

  func selectionRelease(x: Int, y: Int, hasPosition: Bool) {
    zuse_ghostty_selection_release(
      selectionController,
      terminal,
      UInt16(clamping: x),
      UInt32(clamping: y),
      hasPosition
    )
  }

  func selectWord(x: Int, y: Int) {
    _ = zuse_ghostty_select_word(
      terminal,
      UInt16(clamping: x),
      UInt32(clamping: y)
    )
  }

  func selectLine(x: Int, y: Int) {
    _ = zuse_ghostty_select_line(
      terminal,
      UInt16(clamping: x),
      UInt32(clamping: y)
    )
  }

  func selectAll() {
    _ = zuse_ghostty_select_all(terminal)
  }

  func clearSelection() {
    zuse_ghostty_selection_controller_reset(selectionController, terminal)
    _ = ghostty_terminal_set(terminal, GHOSTTY_TERMINAL_OPT_SELECTION, nil)
  }

  func cancelSelectionGesture() {
    zuse_ghostty_selection_controller_reset(selectionController, terminal)
  }

  func selectionText() -> String? {
    let data = encode(acceptNoValue: true) { output, capacity, written in
      zuse_ghostty_selection_text(
        terminal,
        output.map { UnsafeMutableRawPointer($0).assumingMemoryBound(to: UInt8.self) },
        capacity,
        written
      )
    }
    guard !data.isEmpty else { return nil }
    return String(data: data, encoding: .utf8)
  }

  func hyperlinkAt(x: Int, y: Int) -> String? {
    let data = encode(acceptNoValue: true) { output, capacity, written in
      zuse_ghostty_viewport_hyperlink(
        terminal,
        UInt16(clamping: x),
        UInt32(clamping: y),
        output.map { UnsafeMutableRawPointer($0).assumingMemoryBound(to: UInt8.self) },
        capacity,
        written
      )
    }
    guard !data.isEmpty else { return nil }
    return String(data: data, encoding: .utf8)
  }

  func snapshot(
    selectionColor: UIColor,
    selectionForeground: UIColor
  ) -> ZuseTerminalSnapshot? {
    guard ghostty_render_state_update(renderState, terminal) == GHOSTTY_SUCCESS
    else { return nil }

    var dirty = GHOSTTY_RENDER_STATE_DIRTY_FULL
    var frameCols: UInt16 = cols
    var frameRows: UInt16 = rows
    _ = ghostty_render_state_get(renderState, GHOSTTY_RENDER_STATE_DATA_DIRTY, &dirty)
    _ = ghostty_render_state_get(renderState, GHOSTTY_RENDER_STATE_DATA_COLS, &frameCols)
    _ = ghostty_render_state_get(renderState, GHOSTTY_RENDER_STATE_DATA_ROWS, &frameRows)
    if dirty == GHOSTTY_RENDER_STATE_DIRTY_FALSE,
       let cachedFrame,
       cachedFrame.cols == Int(frameCols),
       cachedFrame.rows == Int(frameRows)
    {
      return ZuseTerminalSnapshot(
        frame: cachedFrame,
        changedRows: [],
        fullRedraw: false
      )
    }

    let fullRedraw = dirty == GHOSTTY_RENDER_STATE_DIRTY_FULL
      || cachedFrame?.cols != Int(frameCols)
      || cachedFrame?.rows != Int(frameRows)
    let defaultForegroundRgb = renderRgb(
      GHOSTTY_RENDER_STATE_DATA_COLOR_FOREGROUND,
      fallback: foreground
    )
    let defaultBackgroundRgb = renderRgb(
      GHOSTTY_RENDER_STATE_DATA_COLOR_BACKGROUND,
      fallback: background
    )
    let defaultForeground = Self.color(defaultForegroundRgb)
    let defaultBackground = Self.color(defaultBackgroundRgb)
    let palette = activePalette()
    var colorCache: [UInt32: UIColor] = [:]
    colorCache[Self.colorKey(defaultForegroundRgb)] = defaultForeground
    colorCache[Self.colorKey(defaultBackgroundRgb)] = defaultBackground
    var cursorX: UInt16 = 0
    var cursorY: UInt16 = 0
    var cursorVisible = false
    var cursorInViewport = false
    var cursorOnWideTail = false
    var cursorBlinking = false
    var cursorStyle = GHOSTTY_RENDER_STATE_CURSOR_VISUAL_STYLE_BLOCK
    var hasCursorColor = false
    _ = ghostty_render_state_get(
      renderState,
      GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_X,
      &cursorX
    )
    _ = ghostty_render_state_get(
      renderState,
      GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_Y,
      &cursorY
    )
    _ = ghostty_render_state_get(
      renderState,
      GHOSTTY_RENDER_STATE_DATA_CURSOR_VISIBLE,
      &cursorVisible
    )
    _ = ghostty_render_state_get(
      renderState,
      GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_HAS_VALUE,
      &cursorInViewport
    )
    _ = ghostty_render_state_get(
      renderState,
      GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_WIDE_TAIL,
      &cursorOnWideTail
    )
    _ = ghostty_render_state_get(
      renderState,
      GHOSTTY_RENDER_STATE_DATA_CURSOR_BLINKING,
      &cursorBlinking
    )
    _ = ghostty_render_state_get(
      renderState,
      GHOSTTY_RENDER_STATE_DATA_CURSOR_VISUAL_STYLE,
      &cursorStyle
    )
    _ = ghostty_render_state_get(
      renderState,
      GHOSTTY_RENDER_STATE_DATA_COLOR_CURSOR_HAS_VALUE,
      &hasCursorColor
    )
    let cursorColor = hasCursorColor
      ? Self.color(renderRgb(GHOSTTY_RENDER_STATE_DATA_COLOR_CURSOR, fallback: cursor))
      : Self.color(cursor)

    guard ghostty_render_state_get(
      renderState,
      GHOSTTY_RENDER_STATE_DATA_ROW_ITERATOR,
      &rowIterator
    ) == GHOSTTY_SUCCESS
    else { return nil }

    var output: [[ZuseTerminalCell]] = []
    var changedRows = IndexSet()
    var blinkingRows = IndexSet()
    while output.count < Int(frameRows),
          ghostty_render_state_row_iterator_next(rowIterator)
    {
      let rowIndex = output.count
      var rowDirty = true
      _ = ghostty_render_state_row_get(
        rowIterator,
        GHOSTTY_RENDER_STATE_ROW_DATA_DIRTY,
        &rowDirty
      )
      if !fullRedraw,
         !rowDirty,
         let cached = cachedFrame?.cells[rowIndex]
      {
        output.append(cached)
        if cached.contains(where: \.blink) { blinkingRows.insert(rowIndex) }
      } else {
        guard ghostty_render_state_row_get(
          rowIterator,
          GHOSTTY_RENDER_STATE_ROW_DATA_CELLS,
          &rowCells
        ) == GHOSTTY_SUCCESS
        else { return nil }
        let line = readLine(
          cols: Int(frameCols),
          defaultForeground: defaultForeground,
          defaultBackground: defaultBackground,
          defaultForegroundRgb: defaultForegroundRgb,
          defaultBackgroundRgb: defaultBackgroundRgb,
          palette: palette,
          colorCache: &colorCache,
          selectionColor: selectionColor,
          selectionForeground: selectionForeground
        )
        output.append(line)
        changedRows.insert(rowIndex)
        if line.contains(where: \.blink) { blinkingRows.insert(rowIndex) }
      }
      var clean = false
      _ = ghostty_render_state_row_set(
        rowIterator,
        GHOSTTY_RENDER_STATE_ROW_OPTION_DIRTY,
        &clean
      )
    }
    while output.count < Int(frameRows) {
      changedRows.insert(output.count)
      output.append(
        emptyLine(
          cols: Int(frameCols),
          foreground: defaultForeground,
          background: defaultBackground
        )
      )
    }

    var clean = GHOSTTY_RENDER_STATE_DIRTY_FALSE
    _ = ghostty_render_state_set(renderState, GHOSTTY_RENDER_STATE_OPTION_DIRTY, &clean)
    let frame = ZuseTerminalFrame(
      cols: Int(frameCols),
      rows: Int(frameRows),
      cells: output,
      foreground: defaultForeground,
      background: defaultBackground,
      cursorX: cursorInViewport
        ? max(0, Int(cursorX) - (cursorOnWideTail ? 1 : 0))
        : -1,
      cursorY: cursorInViewport ? Int(cursorY) : -1,
      cursorVisible: cursorVisible && cursorInViewport,
      cursorBlinking: cursorBlinking,
      cursorStyle: Int(cursorStyle.rawValue),
      cursorColor: cursorColor,
      blinkingRows: blinkingRows
    )
    if let old = cachedFrame {
      if old.cursorY >= 0 { changedRows.insert(old.cursorY) }
      if frame.cursorY >= 0 { changedRows.insert(frame.cursorY) }
    }
    cachedFrame = frame
    return ZuseTerminalSnapshot(
      frame: frame,
      changedRows: fullRedraw ? IndexSet(integersIn: 0..<Int(frameRows)) : changedRows,
      fullRedraw: fullRedraw
    )
  }

  private func readLine(
    cols: Int,
    defaultForeground: UIColor,
    defaultBackground: UIColor,
    defaultForegroundRgb: GhosttyColorRgb,
    defaultBackgroundRgb: GhosttyColorRgb,
    palette: [GhosttyColorRgb],
    colorCache: inout [UInt32: UIColor],
    selectionColor: UIColor,
    selectionForeground: UIColor
  ) -> [ZuseTerminalCell] {
    var line: [ZuseTerminalCell] = []
    line.reserveCapacity(cols)
    while line.count < cols, ghostty_render_state_row_cells_next(rowCells) {
      line.append(
        readCell(
          defaultForegroundRgb: defaultForegroundRgb,
          defaultBackgroundRgb: defaultBackgroundRgb,
          palette: palette,
          colorCache: &colorCache,
          selectionColor: selectionColor,
          selectionForeground: selectionForeground
        )
      )
    }
    while line.count < cols {
      line.append(emptyCell(foreground: defaultForeground, background: defaultBackground))
    }
    return line
  }

  private func readCell(
    defaultForegroundRgb: GhosttyColorRgb,
    defaultBackgroundRgb: GhosttyColorRgb,
    palette: [GhosttyColorRgb],
    colorCache: inout [UInt32: UIColor],
    selectionColor: UIColor,
    selectionForeground: UIColor
  ) -> ZuseTerminalCell {
    var style = GhosttyStyle()
    ghostty_style_default(&style)
    style.size = MemoryLayout<GhosttyStyle>.size
    var hasStyling = false
    _ = ghostty_render_state_row_cells_get(
      rowCells,
      GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_HAS_STYLING,
      &hasStyling
    )
    if hasStyling {
      _ = ghostty_render_state_row_cells_get(
        rowCells,
        GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_STYLE,
        &style
      )
    }
    var foregroundRgb = defaultForegroundRgb
    var backgroundRgb = defaultBackgroundRgb
    if ghostty_render_state_row_cells_get(
      rowCells,
      GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_FG_COLOR,
      &foregroundRgb
    ) != GHOSTTY_SUCCESS {
      foregroundRgb = defaultForegroundRgb
    }
    if ghostty_render_state_row_cells_get(
      rowCells,
      GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_BG_COLOR,
      &backgroundRgb
    ) != GHOSTTY_SUCCESS {
      backgroundRgb = defaultBackgroundRgb
    }
    if style.bold,
       style.fg_color.tag == GHOSTTY_STYLE_COLOR_PALETTE,
       style.fg_color.value.palette < 8
    {
      foregroundRgb = palette[Int(style.fg_color.value.palette) + 8]
    }
    if style.inverse { swap(&foregroundRgb, &backgroundRgb) }

    var graphemeCount: UInt32 = 0
    _ = ghostty_render_state_row_cells_get(
      rowCells,
      GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_LEN,
      &graphemeCount
    )
    let text = readGrapheme(count: Int(graphemeCount), invisible: style.invisible)
    var selected = false
    _ = ghostty_render_state_row_cells_get(
      rowCells,
      GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_SELECTED,
      &selected
    )
    var rawCell: GhosttyCell = 0
    var wide = GHOSTTY_CELL_WIDE_NARROW
    if ghostty_render_state_row_cells_get(
      rowCells,
      GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_RAW,
      &rawCell
    ) == GHOSTTY_SUCCESS {
      _ = ghostty_cell_get(rawCell, GHOSTTY_CELL_DATA_WIDE, &wide)
    }
    let foregroundColor = selected
      ? selectionForeground
      : Self.color(foregroundRgb, cache: &colorCache)
    let backgroundColor = selected
      ? selectionColor
      : Self.color(backgroundRgb, cache: &colorCache)
    let underlineColor = resolve(
      style.underline_color,
      palette: palette,
      cache: &colorCache,
      fallback: foregroundColor
    )
    return ZuseTerminalCell(
      text: text,
      foreground: foregroundColor,
      background: backgroundColor,
      bold: style.bold,
      italic: style.italic,
      faint: style.faint,
      blink: style.blink,
      underlineStyle: Int(style.underline),
      underlineColor: underlineColor,
      strikethrough: style.strikethrough,
      overline: style.overline,
      selected: selected,
      wide: Int(wide.rawValue)
    )
  }

  private func readGrapheme(count: Int, invisible: Bool) -> String {
    guard count > 0, !invisible else { return " " }
    if count > codepointScratch.count {
      codepointScratch = Array(repeating: 0, count: count)
    }
    let result = codepointScratch.withUnsafeMutableBufferPointer { buffer in
      ghostty_render_state_row_cells_get(
        rowCells,
        GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_BUF,
        buffer.baseAddress
      )
    }
    guard result == GHOSTTY_SUCCESS else { return " " }
    var scalars = String.UnicodeScalarView()
    scalars.reserveCapacity(count)
    for codepoint in codepointScratch.prefix(count) {
      if let scalar = UnicodeScalar(codepoint) { scalars.append(scalar) }
    }
    return scalars.isEmpty ? " " : String(scalars)
  }

  private func emptyLine(
    cols: Int,
    foreground: UIColor,
    background: UIColor
  ) -> [ZuseTerminalCell] {
    Array(
      repeating: emptyCell(foreground: foreground, background: background),
      count: cols
    )
  }

  private func emptyCell(
    foreground: UIColor,
    background: UIColor
  ) -> ZuseTerminalCell {
    ZuseTerminalCell(
      text: " ",
      foreground: foreground,
      background: background,
      bold: false,
      italic: false,
      faint: false,
      blink: false,
      underlineStyle: 0,
      underlineColor: foreground,
      strikethrough: false,
      overline: false,
      selected: false,
      wide: 0
    )
  }

  private func activePalette() -> [GhosttyColorRgb] {
    var palette = Array(repeating: foreground, count: 256)
    let result = palette.withUnsafeMutableBufferPointer { buffer in
      ghostty_render_state_get(
        renderState,
        GHOSTTY_RENDER_STATE_DATA_COLOR_PALETTE,
        buffer.baseAddress
      )
    }
    return result == GHOSTTY_SUCCESS ? palette : Array(repeating: foreground, count: 256)
  }

  private func renderRgb(
    _ data: GhosttyRenderStateData,
    fallback: GhosttyColorRgb
  ) -> GhosttyColorRgb {
    var value = fallback
    if ghostty_render_state_get(renderState, data, &value) != GHOSTTY_SUCCESS {
      value = fallback
    }
    return value
  }

  private func resolve(
    _ value: GhosttyStyleColor,
    palette: [GhosttyColorRgb],
    cache: inout [UInt32: UIColor],
    fallback: UIColor
  ) -> UIColor {
    switch value.tag {
    case GHOSTTY_STYLE_COLOR_RGB:
      return Self.color(value.value.rgb, cache: &cache)
    case GHOSTTY_STYLE_COLOR_PALETTE:
      return Self.color(palette[Int(value.value.palette)], cache: &cache)
    default:
      return fallback
    }
  }

  private func encode(
    acceptNoValue: Bool = false,
    _ operation: (
      UnsafeMutablePointer<CChar>?,
      Int,
      UnsafeMutablePointer<Int>
    ) -> GhosttyResult
  ) -> Data {
    var required = 0
    let sizing = operation(nil, 0, &required)
    guard required > 0,
          sizing == GHOSTTY_OUT_OF_SPACE
            || sizing == GHOSTTY_SUCCESS
            || (acceptNoValue && sizing == GHOSTTY_NO_VALUE)
    else { return Data() }
    var output = Data(count: required)
    var written = 0
    let result = output.withUnsafeMutableBytes { raw in
      operation(raw.bindMemory(to: CChar.self).baseAddress, raw.count, &written)
    }
    guard result == GHOSTTY_SUCCESS, written >= 0, written <= output.count
    else { return Data() }
    output.count = written
    return output
  }

  private func drainReplies() -> Data {
    guard let outputQueue else { return Data() }
    let length = zuse_ghostty_output_queue_length(outputQueue)
    var output = Data(count: length)
    var written = 0
    let result = output.withUnsafeMutableBytes { raw in
      zuse_ghostty_output_queue_take(
        outputQueue,
        raw.bindMemory(to: UInt8.self).baseAddress,
        raw.count,
        &written
      )
    }
    guard result == GHOSTTY_SUCCESS || result == GHOSTTY_OUT_OF_MEMORY,
          written <= output.count
    else { return Data() }
    output.count = written
    return output
  }

  private func applyPalette() {
    _ = withUnsafePointer(to: &foreground) { pointer in
      ghostty_terminal_set(terminal, GHOSTTY_TERMINAL_OPT_COLOR_FOREGROUND, pointer)
    }
    _ = withUnsafePointer(to: &background) { pointer in
      ghostty_terminal_set(terminal, GHOSTTY_TERMINAL_OPT_COLOR_BACKGROUND, pointer)
    }
    _ = withUnsafePointer(to: &cursor) { pointer in
      ghostty_terminal_set(terminal, GHOSTTY_TERMINAL_OPT_COLOR_CURSOR, pointer)
    }
  }

  private func releaseResources() {
    zuse_ghostty_selection_controller_free(selectionController, terminal)
    selectionController = nil
    zuse_ghostty_mouse_controller_free(mouseController)
    mouseController = nil
    zuse_ghostty_focus_controller_free(focusController)
    focusController = nil
    ghostty_key_event_free(keyEvent)
    keyEvent = nil
    ghostty_key_encoder_free(keyEncoder)
    keyEncoder = nil
    ghostty_render_state_row_cells_free(rowCells)
    rowCells = nil
    ghostty_render_state_row_iterator_free(rowIterator)
    rowIterator = nil
    ghostty_render_state_free(renderState)
    renderState = nil
    ghostty_terminal_free(terminal)
    terminal = nil
    zuse_ghostty_output_queue_free(outputQueue)
    outputQueue = nil
  }

  private static func rgb(_ color: UIColor) -> GhosttyColorRgb {
    var red: CGFloat = 0
    var green: CGFloat = 0
    var blue: CGFloat = 0
    var alpha: CGFloat = 0
    guard color.getRed(&red, green: &green, blue: &blue, alpha: &alpha) else {
      return GhosttyColorRgb(r: 255, g: 255, b: 255)
    }
    return GhosttyColorRgb(
      r: UInt8(clamping: Int((red * 255).rounded())),
      g: UInt8(clamping: Int((green * 255).rounded())),
      b: UInt8(clamping: Int((blue * 255).rounded()))
    )
  }

  private static func color(_ rgb: GhosttyColorRgb) -> UIColor {
    UIColor(
      red: CGFloat(rgb.r) / 255,
      green: CGFloat(rgb.g) / 255,
      blue: CGFloat(rgb.b) / 255,
      alpha: 1
    )
  }

  private static func color(
    _ rgb: GhosttyColorRgb,
    cache: inout [UInt32: UIColor]
  ) -> UIColor {
    let key = colorKey(rgb)
    if let color = cache[key] { return color }
    let resolved = Self.color(rgb)
    cache[key] = resolved
    return resolved
  }

  private static func colorKey(_ rgb: GhosttyColorRgb) -> UInt32 {
    UInt32(rgb.r) << 16 | UInt32(rgb.g) << 8 | UInt32(rgb.b)
  }
}
