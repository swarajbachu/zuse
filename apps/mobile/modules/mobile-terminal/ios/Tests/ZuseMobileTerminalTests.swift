import GhosttyVt
import UIKit
import XCTest
@testable import ZuseMobileTerminal

final class ZuseMobileTerminalTests: XCTestCase {
  func testTerminalFontSizeClampsToSupportedRange() {
    XCTAssertEqual(ZuseTerminalSettings.fontSize(-10), 9)
    XCTAssertEqual(ZuseTerminalSettings.fontSize(14), 14)
    XCTAssertEqual(ZuseTerminalSettings.fontSize(100), 24)
  }

  func testHardwareKeyMappingCoversTextNavigationAndNumpad() {
    XCTAssertEqual(ZuseTerminalKeyboard.ghosttyKeyCode(forHIDUsage: 0x04), 20)
    XCTAssertEqual(ZuseTerminalKeyboard.ghosttyKeyCode(forHIDUsage: 0x1D), 45)
    XCTAssertEqual(ZuseTerminalKeyboard.ghosttyKeyCode(forHIDUsage: 0x27), 6)
    XCTAssertEqual(ZuseTerminalKeyboard.ghosttyKeyCode(forHIDUsage: 0x52), 78)
    XCTAssertEqual(ZuseTerminalKeyboard.ghosttyKeyCode(forHIDUsage: 0x59), 81)
    XCTAssertEqual(ZuseTerminalKeyboard.ghosttyKeyCode(forHIDUsage: 0x62), 80)
    XCTAssertEqual(ZuseTerminalKeyboard.ghosttyKeyCode(forHIDUsage: -1), 0)
  }

  func testHardwareModifierMappingUsesGhosttyBitContract() {
    XCTAssertEqual(
      ZuseTerminalKeyboard.modifiers(
        shift: true,
        control: true,
        alternate: true,
        command: true,
        capsLock: true
      ),
      0b1_1111
    )
  }

  func testHardwarePressPhaseMappingNeverTreatsChangedAsRepeat() {
    XCTAssertEqual(
      ZuseTerminalKeyboard.ghosttyAction(forHardwarePressPhase: .began),
      GHOSTTY_KEY_ACTION_PRESS
    )
    XCTAssertNil(
      ZuseTerminalKeyboard.ghosttyAction(forHardwarePressPhase: .changed)
    )
    XCTAssertEqual(
      ZuseTerminalKeyboard.ghosttyAction(forHardwarePressPhase: .ended),
      GHOSTTY_KEY_ACTION_RELEASE
    )
    XCTAssertEqual(
      ZuseTerminalKeyboard.ghosttyAction(forHardwarePressPhase: .cancelled),
      GHOSTTY_KEY_ACTION_RELEASE
    )
  }

  func testGhosttyOwnsQueryRepliesAndApplicationCursorEncoding() throws {
    let emulator = try XCTUnwrap(ZuseGhosttyEmulator())
    let reply = emulator.feed(Data("\u{1B}[6n".utf8)).replies
    XCTAssertEqual(String(decoding: reply, as: UTF8.self), "\u{1B}[1;1R")

    _ = emulator.feed(Data("\u{1B}[?1h".utf8))
    let encoded = emulator.encodeKey(
      code: 78,
      text: nil,
      unshiftedCodepoint: 0,
      modifiers: 0,
      consumedModifiers: 0,
      action: GHOSTTY_KEY_ACTION_PRESS
    )
    XCTAssertEqual(String(decoding: encoded, as: UTF8.self), "\u{1B}OA")
  }

  func testGhosttyRepliesToDeviceGeometryAndColorSchemeQueries() throws {
    let emulator = try XCTUnwrap(ZuseGhosttyEmulator())
    _ = emulator.resize(
      cols: 20,
      rows: 4,
      cellWidth: 8,
      cellHeight: 16,
      displayScale: 2
    )
    XCTAssertEqual(
      String(decoding: emulator.feed(Data("\u{1B}[18t".utf8)).replies, as: UTF8.self),
      "\u{1B}[8;4;20t"
    )
    XCTAssertEqual(
      String(decoding: emulator.feed(Data("\u{1B}[16t".utf8)).replies, as: UTF8.self),
      "\u{1B}[6;32;16t"
    )
    XCTAssertEqual(
      String(decoding: emulator.feed(Data("\u{1B}[?996n".utf8)).replies, as: UTF8.self),
      "\u{1B}[?997;1n"
    )
    XCTAssertEqual(
      String(decoding: emulator.feed(Data("\u{1B}[c".utf8)).replies, as: UTF8.self),
      "\u{1B}[?62;22c"
    )
  }

  func testGhosttyReReportsFocusAfterCoalescedResetAndReplay() throws {
    let emulator = try XCTUnwrap(ZuseGhosttyEmulator())
    _ = emulator.feed(Data("\u{1B}[?1004h".utf8))
    XCTAssertEqual(
      String(decoding: emulator.encodeFocus(true), as: UTF8.self),
      "\u{1B}[I"
    )
    XCTAssertTrue(emulator.encodeFocus(true).isEmpty)

    _ = emulator.feed(Data("\u{1B}c\u{1B}[?1004h".utf8))
    XCTAssertEqual(
      String(decoding: emulator.encodeFocus(true), as: UTF8.self),
      "\u{1B}[I"
    )
  }

  func testGhosttyEncodesBracketedPasteAndFiltersUnsafeBytes() throws {
    let emulator = try XCTUnwrap(ZuseGhosttyEmulator())
    _ = emulator.feed(Data("\u{1B}[?2004h".utf8))
    let encoded = emulator.encodePaste("hello\nworld\u{1B}")
    XCTAssertEqual(
      String(decoding: encoded, as: UTF8.self),
      "\u{1B}[200~hello\nworld \u{1B}[201~"
    )
  }

  func testGhosttyMouseEncodingHonorsTrackingButtonsModifiersAndWheel() throws {
    let emulator = try XCTUnwrap(ZuseGhosttyEmulator())
    let screenSize = CGSize(width: 800, height: 400)
    let cellSize = CGSize(width: 8, height: 16)
    func encode(
      _ action: GhosttyMouseAction,
      _ button: GhosttyMouseButton,
      _ location: CGPoint,
      modifiers: UInt16 = 0
    ) -> String {
      String(
        decoding: emulator.encodeMouse(
          action: action,
          button: button,
          modifiers: modifiers,
          location: location,
          screenSize: screenSize,
          cellSize: cellSize
        ),
        as: UTF8.self
      )
    }

    _ = emulator.feed(Data("\u{1B}[?1002h\u{1B}[?1006h".utf8))
    XCTAssertEqual(encode(GHOSTTY_MOUSE_ACTION_MOTION, GHOSTTY_MOUSE_BUTTON_UNKNOWN, .zero), "")
    XCTAssertEqual(encode(GHOSTTY_MOUSE_ACTION_PRESS, GHOSTTY_MOUSE_BUTTON_LEFT, .zero), "\u{1B}[<0;1;1M")
    XCTAssertEqual(encode(GHOSTTY_MOUSE_ACTION_MOTION, GHOSTTY_MOUSE_BUTTON_LEFT, CGPoint(x: 16, y: 0)), "\u{1B}[<32;3;1M")
    XCTAssertEqual(encode(GHOSTTY_MOUSE_ACTION_RELEASE, GHOSTTY_MOUSE_BUTTON_LEFT, CGPoint(x: 16, y: 0)), "\u{1B}[<0;3;1m")
    XCTAssertEqual(encode(GHOSTTY_MOUSE_ACTION_MOTION, GHOSTTY_MOUSE_BUTTON_UNKNOWN, CGPoint(x: 24, y: 0)), "")

    _ = emulator.feed(Data("\u{1B}[?1002l\u{1B}[?1003h".utf8))
    XCTAssertEqual(encode(GHOSTTY_MOUSE_ACTION_MOTION, GHOSTTY_MOUSE_BUTTON_UNKNOWN, CGPoint(x: 24, y: 0)), "\u{1B}[<35;4;1M")
    XCTAssertEqual(encode(GHOSTTY_MOUSE_ACTION_PRESS, GHOSTTY_MOUSE_BUTTON_RIGHT, .zero, modifiers: 1 << 1), "\u{1B}[<18;1;1M")
    XCTAssertEqual(encode(GHOSTTY_MOUSE_ACTION_RELEASE, GHOSTTY_MOUSE_BUTTON_RIGHT, .zero, modifiers: 1 << 1), "\u{1B}[<18;1;1m")
    XCTAssertEqual(encode(GHOSTTY_MOUSE_ACTION_PRESS, GHOSTTY_MOUSE_BUTTON_MIDDLE, .zero), "\u{1B}[<1;1;1M")
    XCTAssertEqual(encode(GHOSTTY_MOUSE_ACTION_RELEASE, GHOSTTY_MOUSE_BUTTON_MIDDLE, .zero), "\u{1B}[<1;1;1m")
    XCTAssertEqual(encode(GHOSTTY_MOUSE_ACTION_PRESS, GHOSTTY_MOUSE_BUTTON_FOUR, .zero), "\u{1B}[<64;1;1M")
    XCTAssertEqual(encode(GHOSTTY_MOUSE_ACTION_PRESS, GHOSTTY_MOUSE_BUTTON_FIVE, .zero), "\u{1B}[<65;1;1M")
  }

  func testExpoViewForwardsPasteFocusAndPointerThroughGhosttyModes() throws {
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 800, height: 400))
    let controller = UIViewController()
    let view = ZuseMobileTerminalView(appContext: nil)
    var emitted: [String] = []
    view.onInput.onEventSent = { payload in
      if let data = payload["data"] as? String { emitted.append(data) }
    }
    controller.view.addSubview(view)
    view.frame = controller.view.bounds
    window.rootViewController = controller
    window.makeKeyAndVisible()
    view.layoutIfNeeded()

    XCTAssertTrue(view.becomeFirstResponder())
    view.feed("1\u{0}\u{1B}[?2004h\u{1B}[?1004h\u{1B}[?1003h\u{1B}[?1006h")
    UIPasteboard.general.string = "hello\nworld\u{1B}"
    view.paste(nil)
    XCTAssertEqual(
      view.handlePointer(
        action: GHOSTTY_MOUSE_ACTION_PRESS,
        button: GHOSTTY_MOUSE_BUTTON_LEFT,
        modifierFlags: [],
        location: .zero
      ),
      .remote
    )
    XCTAssertEqual(
      view.handlePointer(
        action: GHOSTTY_MOUSE_ACTION_RELEASE,
        button: GHOSTTY_MOUSE_BUTTON_LEFT,
        modifierFlags: [],
        location: .zero
      ),
      .remote
    )
    XCTAssertEqual(view.pointerButton(for: .secondary), GHOSTTY_MOUSE_BUTTON_RIGHT)
    XCTAssertEqual(view.pointerButton(for: .button(3)), GHOSTTY_MOUSE_BUTTON_MIDDLE)
    XCTAssertEqual(
      view.handlePointer(
        action: GHOSTTY_MOUSE_ACTION_PRESS,
        button: GHOSTTY_MOUSE_BUTTON_RIGHT,
        modifierFlags: [.control],
        location: .zero
      ),
      .remote
    )
    XCTAssertEqual(
      view.handlePointer(
        action: GHOSTTY_MOUSE_ACTION_RELEASE,
        button: GHOSTTY_MOUSE_BUTTON_RIGHT,
        modifierFlags: [.control],
        location: .zero
      ),
      .remote
    )
    XCTAssertEqual(
      view.handlePointer(
        action: GHOSTTY_MOUSE_ACTION_PRESS,
        button: GHOSTTY_MOUSE_BUTTON_MIDDLE,
        modifierFlags: [],
        location: .zero
      ),
      .remote
    )
    XCTAssertEqual(
      view.handlePointer(
        action: GHOSTTY_MOUSE_ACTION_RELEASE,
        button: GHOSTTY_MOUSE_BUTTON_MIDDLE,
        modifierFlags: [],
        location: .zero
      ),
      .remote
    )
    XCTAssertEqual(
      view.handlePointer(
        action: GHOSTTY_MOUSE_ACTION_MOTION,
        button: GHOSTTY_MOUSE_BUTTON_UNKNOWN,
        modifierFlags: [],
        location: .zero
      ),
      .remote
    )
    XCTAssertEqual(
      view.handlePointerScroll(rows: -1, modifierFlags: [], location: .zero),
      .remote
    )
    XCTAssertEqual(
      view.handlePointerScroll(rows: 1, modifierFlags: [], location: .zero),
      .remote
    )
    XCTAssertTrue(view.resignFirstResponder())

    XCTAssertEqual(
      emitted,
      [
        "\u{1B}[I",
        "\u{1B}[200~hello\nworld \u{1B}[201~",
        "\u{1B}[<0;1;1M",
        "\u{1B}[<0;1;1m",
        "\u{1B}[<18;1;1M",
        "\u{1B}[<18;1;1m",
        "\u{1B}[<1;1;1M",
        "\u{1B}[<1;1;1m",
        "\u{1B}[<35;1;1M",
        "\u{1B}[<64;1;1M",
        "\u{1B}[<65;1;1M",
        "\u{1B}[O",
      ]
    )
    window.isHidden = true
  }

  func testExpoViewKeepsSelectionAndScrollLocalWithoutRemoteMouseCapture() {
    let view = ZuseMobileTerminalView(appContext: nil)
    view.frame = CGRect(x: 0, y: 0, width: 800, height: 160)
    view.layoutIfNeeded()
    var emitted: [String] = []
    view.onInput.onEventSent = { payload in
      if let data = payload["data"] as? String { emitted.append(data) }
    }
    let lines = (1...60).map { String(format: "line%02d", $0) }.joined(separator: "\r\n")
    view.feed("1\u{0}\(lines)")
    let beforeScroll = view.accessibilityValue as? String
    XCTAssertEqual(
      view.handlePointerScroll(rows: -3, modifierFlags: [], location: .zero),
      .localScroll
    )
    XCTAssertNotEqual(view.accessibilityValue as? String, beforeScroll)

    XCTAssertEqual(
      view.handlePointer(
        action: GHOSTTY_MOUSE_ACTION_PRESS,
        button: GHOSTTY_MOUSE_BUTTON_LEFT,
        modifierFlags: [],
        location: CGPoint(x: 5, y: 5)
      ),
      .localSelection
    )
    XCTAssertEqual(
      view.handlePointer(
        action: GHOSTTY_MOUSE_ACTION_MOTION,
        button: GHOSTTY_MOUSE_BUTTON_LEFT,
        modifierFlags: [],
        location: CGPoint(x: 45, y: 5)
      ),
      .localSelection
    )
    XCTAssertEqual(
      view.handlePointer(
        action: GHOSTTY_MOUSE_ACTION_RELEASE,
        button: GHOSTTY_MOUSE_BUTTON_LEFT,
        modifierFlags: [],
        location: CGPoint(x: 45, y: 5)
      ),
      .localSelection
    )
    UIPasteboard.general.string = nil
    view.copy(nil)
    XCTAssertFalse(UIPasteboard.general.string?.isEmpty ?? true)

    view.feed("2\u{0}\u{1B}[?1003h\u{1B}[?1006h")
    emitted.removeAll()
    XCTAssertEqual(
      view.handlePointer(
        action: GHOSTTY_MOUSE_ACTION_PRESS,
        button: GHOSTTY_MOUSE_BUTTON_LEFT,
        modifierFlags: [.shift],
        location: CGPoint(x: 5, y: 5)
      ),
      .localSelection
    )
    XCTAssertEqual(
      view.handlePointer(
        action: GHOSTTY_MOUSE_ACTION_RELEASE,
        button: GHOSTTY_MOUSE_BUTTON_LEFT,
        modifierFlags: [.shift],
        location: CGPoint(x: 45, y: 5)
      ),
      .localSelection
    )
    XCTAssertTrue(emitted.isEmpty)
  }

  func testExpoViewDropsPointerStateAcrossCoalescedResetAndReplay() {
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 800, height: 400))
    let controller = UIViewController()
    let view = ZuseMobileTerminalView(appContext: nil)
    var emitted: [String] = []
    view.onInput.onEventSent = { payload in
      if let data = payload["data"] as? String { emitted.append(data) }
    }
    controller.view.addSubview(view)
    view.frame = controller.view.bounds
    window.rootViewController = controller
    window.makeKeyAndVisible()
    view.layoutIfNeeded()

    view.feed("1\u{0}\u{1B}[?1002h\u{1B}[?1006h")
    XCTAssertEqual(
      view.handlePointer(
        action: GHOSTTY_MOUSE_ACTION_PRESS,
        button: GHOSTTY_MOUSE_BUTTON_LEFT,
        modifierFlags: [],
        location: .zero
      ),
      .remote
    )

    view.feed("2\u{0}\u{1B}c\u{1B}[?1002h\u{1B}[?1006h")
    XCTAssertEqual(
      view.handlePointer(
        action: GHOSTTY_MOUSE_ACTION_MOTION,
        button: GHOSTTY_MOUSE_BUTTON_LEFT,
        modifierFlags: [],
        location: CGPoint(x: 16, y: 0)
      ),
      .ignored
    )
    XCTAssertEqual(
      view.handlePointer(
        action: GHOSTTY_MOUSE_ACTION_RELEASE,
        button: GHOSTTY_MOUSE_BUTTON_LEFT,
        modifierFlags: [],
        location: CGPoint(x: 16, y: 0)
      ),
      .ignored
    )
    XCTAssertEqual(
      view.handlePointer(
        action: GHOSTTY_MOUSE_ACTION_PRESS,
        button: GHOSTTY_MOUSE_BUTTON_LEFT,
        modifierFlags: [],
        location: CGPoint(x: 16, y: 0)
      ),
      .remote
    )
    XCTAssertEqual(emitted, ["\u{1B}[<0;1;1M", "\u{1B}[<0;3;1M"])
    window.isHidden = true
  }

  func testGhosttySnapshotPreservesStylesWideCellsAndDirtyIdentity() throws {
    let emulator = try XCTUnwrap(ZuseGhosttyEmulator())
    _ = emulator.feed(Data("\u{1B}[1;3;4;9m界\u{1B}[0m".utf8))
    let first = try XCTUnwrap(
      emulator.snapshot(selectionColor: .blue, selectionForeground: .white)
    )
    XCTAssertEqual(first.frame.cells[0][0].text, "界")
    XCTAssertTrue(first.frame.cells[0][0].bold)
    XCTAssertTrue(first.frame.cells[0][0].italic)
    XCTAssertGreaterThan(first.frame.cells[0][0].underlineStyle, 0)
    XCTAssertTrue(first.frame.cells[0][0].strikethrough)
    XCTAssertEqual(first.frame.cells[0][0].wide, 1)
    XCTAssertEqual(first.frame.cells[0][1].wide, 2)

    let second = try XCTUnwrap(
      emulator.snapshot(selectionColor: .blue, selectionForeground: .white)
    )
    XCTAssertTrue(first.frame === second.frame)
    XCTAssertTrue(second.changedRows.isEmpty)
  }

  func testGhosttySelectionHyperlinksScrollbackAndReset() throws {
    let emulator = try XCTUnwrap(ZuseGhosttyEmulator())
    _ = emulator.resize(
      cols: 20,
      rows: 4,
      cellWidth: 8,
      cellHeight: 16,
      displayScale: 2
    )
    let linked = "\u{1B}]8;;https://zuse.sh\u{7}hello\u{1B}]8;;\u{7} world"
    _ = emulator.feed(Data(linked.utf8))
    XCTAssertEqual(emulator.hyperlinkAt(x: 1, y: 0), "https://zuse.sh")
    emulator.selectWord(x: 7, y: 0)
    XCTAssertEqual(emulator.selectionText(), "world")

    _ = emulator.feed(Data("\r\none\r\ntwo\r\nthree\r\nfour\r\nfive".utf8))
    emulator.scroll(rows: -2)
    let scrolled = try XCTUnwrap(
      emulator.snapshot(selectionColor: .blue, selectionForeground: .white)
    )
    XCTAssertTrue(scrolled.frame.accessibilityText.contains("two"))

    _ = emulator.reset()
    let reset = try XCTUnwrap(
      emulator.snapshot(selectionColor: .blue, selectionForeground: .white)
    )
    XCTAssertEqual(reset.frame.accessibilityText, "")
    XCTAssertNil(emulator.selectionText())
  }
}
