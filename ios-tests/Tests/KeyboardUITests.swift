import XCTest

// The on-screen-keyboard suite that browser tests cannot reach: these run
// against the REAL WKWebView + real iOS keyboard, exercising
// tauri-plugin-ionic's native half end-to-end (event dispatch → Ionic's
// tab-bar reaction, outer-scroll pinning, the accessory-bar swizzle).
//
// The app under test is whatever `app.wingover.wingover` build is installed
// on the destination simulator — CI builds and installs it first (ci.yml).
// The Map Provider page hosts the test field so no seeded flight is needed.
//
// AX-tree facts these rely on (verified on-simulator): Ionic tab buttons
// surface as Button "Fly"/"Logbook"/…; "Fly" is the unambiguous
// tab-bar-presence probe ("Settings" also matches the ‹ back button); row
// labels concatenate ("Map Provider MapKit"), so rows match by prefix.
final class KeyboardUITests: XCTestCase {

  private func element(
    _ app: XCUIApplication, labelStartingWith prefix: String
  ) -> XCUIElement {
    app.descendants(matching: .any)
      .matching(NSPredicate(format: "label BEGINSWITH %@", prefix))
      .firstMatch
  }

  func testKeyboardSuite() throws {
    let app = XCUIApplication(bundleIdentifier: "app.wingover.wingover")
    app.launch()

    // Navigate: Settings → Map Provider → MapLibre (its key field is the
    // only always-available text field in the app).
    let settingsTab = app.buttons["Settings"].firstMatch
    XCTAssertTrue(settingsTab.waitForExistence(timeout: 15), "app did not boot to tabs")
    settingsTab.tap()
    let mapRow = element(app, labelStartingWith: "Map Provider")
    XCTAssertTrue(mapRow.waitForExistence(timeout: 5))
    mapRow.tap()
    let maplibreRow = element(app, labelStartingWith: "MapLibre")
    XCTAssertTrue(maplibreRow.waitForExistence(timeout: 5))
    maplibreRow.tap()

    let field = app.textFields.firstMatch
    XCTAssertTrue(field.waitForExistence(timeout: 5), "MapTiler key field missing")
    let title = app.staticTexts["Map Provider"].firstMatch
    XCTAssertTrue(title.waitForExistence(timeout: 5))
    let flyTab = app.buttons["Fly"].firstMatch
    XCTAssertTrue(flyTab.exists, "tab bar should be present before the keyboard")
    let titleYBefore = title.frame.origin.y

    // Focus → the real software keyboard appears (programmatic-focus
    // swizzle + hardware-keyboard disabled on the CI sim).
    field.tap()
    XCTAssertTrue(
      app.keyboards.element.waitForExistence(timeout: 7),
      "software keyboard never appeared")

    // Typing flows into the web input (value readable back through AX).
    field.typeText("uitest")
    // Let the web layer's rAF resize + Ionic's tab-bar reaction settle.
    Thread.sleep(forTimeInterval: 2.0)
    XCTAssertTrue(
      String(describing: field.value).contains("uitest"),
      "typed text did not reach the web input")

    // Ionic hid the tab bar off the plugin's keyboardWillShow event.
    XCTAssertFalse(flyTab.exists, "tab bar should hide while the keyboard is up")

    // The ‹ › Done accessory bar is swizzled away.
    XCTAssertEqual(app.toolbars.count, 0, "input accessory bar should be hidden")

    // The keyboard did not scroll the outer frame (contentOffset pin):
    // the nav title holds its place…
    XCTAssertEqual(
      title.frame.origin.y, titleYBefore, accuracy: 1.0,
      "outer frame scrolled when the keyboard appeared")

    // …and stays pinned through a drag on the shell (scroll disabled).
    let content = app.webViews.firstMatch
    let start = content.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.35))
    let end = content.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.15))
    start.press(forDuration: 0.05, thenDragTo: end)
    Thread.sleep(forTimeInterval: 0.7)
    XCTAssertEqual(
      title.frame.origin.y, titleYBefore, accuracy: 1.0,
      "outer frame scrolled on drag while the keyboard was up")

    // Tap outside the field → keyboard dismisses and the tab bar returns
    // (keyboardWillHide → Ionic un-hides).
    title.tap()
    let gone = NSPredicate(format: "exists == false")
    expectation(for: gone, evaluatedWith: app.keyboards.element)
    waitForExpectations(timeout: 7)
    XCTAssertTrue(
      flyTab.waitForExistence(timeout: 5),
      "tab bar should return after the keyboard dismisses")

    // Leave the app as found: clear the junk key and restore MapKit.
    field.tap()
    if app.keyboards.element.waitForExistence(timeout: 5) {
      if let value = field.value as? String, !value.isEmpty {
        field.typeText(String(
          repeating: XCUIKeyboardKey.delete.rawValue, count: value.count + 2))
      }
      title.tap()
    }
    element(app, labelStartingWith: "MapKit").tap()
  }
}
