import XCTest
@testable import ZuseMobileTerminal

final class ZuseMobileTerminalTests: XCTestCase {
  func testTerminalFontSizeClampsToSupportedRange() {
    XCTAssertEqual(ZuseTerminalSettings.fontSize(-10), 9)
    XCTAssertEqual(ZuseTerminalSettings.fontSize(14), 14)
    XCTAssertEqual(ZuseTerminalSettings.fontSize(100), 24)
  }
}
