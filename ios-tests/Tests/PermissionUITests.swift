import XCTest

// The blocked-state drills: the error paths a pilot actually hits in a
// field — location revoked, Precise Location flipped off — exercised
// against the REAL native pipeline (CoreLocation delegates → Swift
// lastError codes → Rust drain mirror → JS engine → red takeover), the
// one ring no browser test can reach.
//
// Run contract (ios-tests/run.sh): this class runs in its OWN xcodebuild
// invocation, AFTER the main suite, with
//   - the simctl location scenario CLEARED (no fixes → acquiring
//     persists, so pre-takeoff blocking is actually observable), and
//   - location permission REVOKED host-side (simctl privacy revoke)
//     before the invocation.
// Tests are ordered by name (test1/test2/test3) because later ones
// depend on the Settings state earlier ones leave behind.
final class PermissionUITests: XCTestCase {

  private let bundleId = "app.wingover.wingover"

  // iOS 26's SwiftUI Settings does not expose rows as Cell-descended
  // StaticTexts (XCUITest logs "Automation type mismatch: computed Other
  // from legacy attributes"), so match by label across ANY element type.
  private func row(_ app: XCUIApplication, _ label: String) -> XCUIElement {
    app.descendants(matching: .any)
      .matching(
        NSPredicate(format: "label == %@ OR identifier == %@", label, label)
      )
      .firstMatch
  }

  private func recoverToIdle(_ app: XCUIApplication) {
    let stop = app.buttons["Stop flight"].firstMatch
    let cancel = app.buttons["Cancel"].firstMatch
    if stop.waitForExistence(timeout: 3) {
      stop.tap()
      let confirm = app.buttons["Stop"].firstMatch
      if confirm.waitForExistence(timeout: 5) { confirm.tap() }
      _ = app.buttons["Fly"].firstMatch.waitForExistence(timeout: 20)
    } else if cancel.exists {
      cancel.tap()
    }
  }

  // Settings navigation to Wingover's own page. iOS 18 nests third-party
  // apps under a root "Apps" item; earlier versions list them at the
  // root. Scroll-and-tap either way.
  private func openWingoverInSettings() -> XCUIApplication {
    let settings = XCUIApplication(bundleIdentifier: "com.apple.Preferences")
    settings.launch()
    let apps = row(settings, "Apps")
    if apps.waitForExistence(timeout: 5) { apps.tap() }
    let appRow = row(settings, "Wingover")
    for _ in 0..<8 where !appRow.isHittable {
      settings.swipeUp()
    }
    XCTAssertTrue(
      appRow.waitForExistence(timeout: 10), "no Wingover row in Settings")
    appRow.tap()
    let location = row(settings, "Location")
    XCTAssertTrue(
      location.waitForExistence(timeout: 10), "no Location row on the app page")
    location.tap()
    return settings
  }

  // Revoked before launch (run.sh): tapping Start Flight must land on the
  // red takeover — with Open Settings and Cancel, and NO Try Again
  // (native recovers by itself; the button is web-only).
  func test1DeniedShowsBlockingTakeover() throws {
    let app = XCUIApplication(bundleIdentifier: bundleId)
    app.launch()
    recoverToIdle(app)

    let start = app.buttons["Start Flight"].firstMatch
    XCTAssertTrue(start.waitForExistence(timeout: 30), "app is not idle")
    start.tap()

    XCTAssertTrue(
      app.staticTexts["Location Access Needed"].firstMatch
        .waitForExistence(timeout: 15),
      "denied permission did not surface the blocking takeover")
    XCTAssertTrue(app.buttons["Open Settings"].firstMatch.exists)
    XCTAssertFalse(
      app.buttons["Try Again"].firstMatch.exists,
      "Try Again is web-only; native must recover hands-free")
    // Leave the takeover up: test2 recovers from exactly this state.
  }

  // From the takeover, Open Settings must deep-link to the app's own
  // Settings page (app-settings: through the scoped opener capability),
  // and after re-granting there, RETURNING must proceed with zero taps
  // (readiness poll / foreground heal).
  func test2RecoveryIsHandsFree() throws {
    let app = XCUIApplication(bundleIdentifier: bundleId)
    app.activate()

    let openSettings = app.buttons["Open Settings"].firstMatch
    if !openSettings.waitForExistence(timeout: 5) {
      // Fresh launch (test isolation): re-create the blocked state.
      app.launch()
      recoverToIdle(app)
      let start = app.buttons["Start Flight"].firstMatch
      XCTAssertTrue(start.waitForExistence(timeout: 30))
      start.tap()
      XCTAssertTrue(openSettings.waitForExistence(timeout: 15))
    }
    openSettings.tap()

    // The deep link must land inside Settings on Wingover's page.
    let settings = XCUIApplication(bundleIdentifier: "com.apple.Preferences")
    let location = row(settings, "Location")
    XCTAssertTrue(
      location.waitForExistence(timeout: 20),
      "app-settings: deep link did not open the app's Settings page")
    location.tap()
    let grant = row(settings, "While Using the App")
    XCTAssertTrue(grant.waitForExistence(timeout: 10))
    grant.tap()

    // Back to the app: no taps allowed past this point. (iOS may have
    // relaunched the app on the TCC change; activate covers both.)
    app.activate()
    let takeoverGone = NSPredicate(format: "exists == false")
    expectation(
      for: takeoverGone,
      evaluatedWith: app.staticTexts["Location Access Needed"].firstMatch)
    waitForExpectations(timeout: 20)
    XCTAssertTrue(
      app.staticTexts["Acquiring GPS"].firstMatch.waitForExistence(timeout: 20),
      "granting in Settings did not resume acquiring hands-free")
  }

  // Precise Location off mid-acquiring must surface its own takeover —
  // this is the full new pipeline (didChangeAuthorization → lastError
  // code → drain mirror → fixes_since → JS classification), not the
  // start-time refusal. Flipping it back on must recover hands-free.
  func test3PreciseFlipMidAcquiring() throws {
    let app = XCUIApplication(bundleIdentifier: bundleId)
    app.launch()
    recoverToIdle(app)

    let start = app.buttons["Start Flight"].firstMatch
    XCTAssertTrue(start.waitForExistence(timeout: 30))
    start.tap()
    // Self-heal if test2's grant never landed: permission may still be
    // revoked, in which case Start lands on the takeover, not acquiring.
    if app.staticTexts["Location Access Needed"].firstMatch
      .waitForExistence(timeout: 5)
    {
      let settings = openWingoverInSettings()
      let grant = row(settings, "While Using the App")
      XCTAssertTrue(grant.waitForExistence(timeout: 10))
      grant.tap()
      app.activate()
    }
    XCTAssertTrue(
      app.staticTexts["Acquiring GPS"].firstMatch.waitForExistence(timeout: 20),
      "expected to sit in acquiring (is the location scenario cleared?)")

    let settings = openWingoverInSettings()
    let precise = row(settings, "Precise Location")
    XCTAssertTrue(
      precise.waitForExistence(timeout: 10), "no Precise Location switch")
    precise.tap()

    app.activate()
    XCTAssertTrue(
      app.staticTexts["Precise Location Is Off"].firstMatch
        .waitForExistence(timeout: 15),
      "reduced accuracy mid-acquiring did not surface the takeover")

    // Flip it back — recovery must again be hands-free.
    settings.activate()
    XCTAssertTrue(precise.waitForExistence(timeout: 10))
    precise.tap()
    app.activate()
    XCTAssertTrue(
      app.staticTexts["Acquiring GPS"].firstMatch.waitForExistence(timeout: 20),
      "restoring Precise Location did not resume acquiring hands-free")

    // Leave the app idle for whatever runs next.
    recoverToIdle(app)
  }
}
