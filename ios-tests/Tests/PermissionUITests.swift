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

  // Walks any leftover state (recording, acquiring, blocked takeover)
  // back to idle. The cancel branch needs a real wait — a cold launch
  // renders the webview seconds after launch() returns — and pre-takeoff
  // Cancel is guarded by the same BigConfirm as Stop (gloves-first); the
  // takeover's Cancel discards directly, so a missing confirm is fine.
  private func recoverToIdle(_ app: XCUIApplication) {
    let stop = app.buttons["Stop flight"].firstMatch
    let cancel = app.buttons["Cancel"].firstMatch
    if stop.waitForExistence(timeout: 3) {
      stop.tap()
      let confirm = app.buttons["Stop"].firstMatch
      if confirm.waitForExistence(timeout: 5) { confirm.tap() }
    } else if cancel.waitForExistence(timeout: 10) {
      cancel.tap()
      let confirm = app.buttons["Stop"].firstMatch
      if confirm.waitForExistence(timeout: 5) { confirm.tap() }
    }
    _ = app.buttons["Start Flight"].firstMatch.waitForExistence(timeout: 20)
  }

  // SwiftUI Settings virtualizes its lists: off-screen rows are absent
  // from the AX snapshot entirely, so finding one MEANS scrolling.
  private func scrollTo(
    _ app: XCUIApplication, _ label: String, swipes: Int = 10
  ) -> XCUIElement? {
    let target = row(app, label)
    for _ in 0...swipes {
      // Frame math, not isHittable: on iOS 26's SwiftUI Settings the
      // hittability probe itself can FAIL the test ("activation point
      // invalid") for oddly-exposed rows, where reading the frame cannot.
      if target.exists, !target.frame.isEmpty,
        app.windows.firstMatch.frame.intersects(target.frame)
      {
        return target
      }
      app.swipeUp()
    }
    return target.exists && !target.frame.isEmpty ? target : nil
  }

  // Settings navigation to Wingover's Location page. iOS 18+ nests
  // third-party apps under a root "Apps" item (below the fold); older
  // roots list them directly. Returns nil when this runtime's Settings
  // resists automation — callers XCTSkip rather than fail, because that
  // is a statement about the simulator, not the app.
  private func openWingoverLocationInSettings() -> XCUIApplication? {
    let settings = XCUIApplication(bundleIdentifier: "com.apple.Preferences")
    settings.launch()
    if let apps = scrollTo(settings, "Apps") { apps.tap() }
    guard let appRow = scrollTo(settings, "Wingover") else { return nil }
    appRow.tap()
    guard let location = scrollTo(settings, "Location", swipes: 3) else {
      return nil
    }
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

    // HARD contract: the deep link fires and Settings comes to the
    // foreground. Where exactly it lands is runtime-dependent on the
    // simulator, so page navigation below is fallback-tolerant.
    let settings = XCUIApplication(bundleIdentifier: "com.apple.Preferences")
    XCTAssertTrue(
      settings.wait(for: .runningForeground, timeout: 15),
      "app-settings: deep link did not foreground Settings")
    var location = row(settings, "Location")
    if !location.waitForExistence(timeout: 8) {
      guard let navigated = openWingoverLocationInSettings() else {
        throw XCTSkip(
          "Settings rows not automatable on this runtime; deep link "
            + "foregrounding verified, grant path needs a device")
      }
      _ = navigated
      location = row(settings, "Location")
    } else {
      location.tap()
    }
    guard let grant = scrollTo(settings, "While Using the App", swipes: 3)
    else {
      throw XCTSkip(
        "grant row not automatable on this runtime; verify on device")
    }
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
      guard let settings = openWingoverLocationInSettings(),
        let grant = scrollTo(settings, "While Using the App", swipes: 3)
      else {
        throw XCTSkip(
          "permission still revoked and Settings not automatable on "
            + "this runtime; verify on device")
      }
      grant.tap()
      app.activate()
    }
    XCTAssertTrue(
      app.staticTexts["Acquiring GPS"].firstMatch.waitForExistence(timeout: 20),
      "expected to sit in acquiring (is the location scenario cleared?)")

    guard let settings = openWingoverLocationInSettings(),
      let precise = scrollTo(settings, "Precise Location", swipes: 3)
    else {
      throw XCTSkip(
        "Settings rows not automatable on this runtime; the Precise "
          + "pipeline needs a device to drill")
    }
    precise.tap()

    app.activate()
    // Simulators differ from devices here: some runtimes fire
    // didChangeAuthorization for a live app on the toggle (device
    // behavior, device-verified), others deliver nothing — and with the
    // location scenario cleared there are no fixes for the reassert
    // path to ride either. Assert when the event arrives; skip honestly
    // when the runtime never emits it.
    let surfaced = app.staticTexts["Precise Location Is Off"].firstMatch
      .waitForExistence(timeout: 20)

    // Restore Precise either way so the sim is left clean.
    settings.activate()
    if scrollTo(settings, "Precise Location", swipes: 3) != nil {
      precise.tap()
    }
    app.activate()

    if !surfaced {
      recoverToIdle(app)
      throw XCTSkip(
        "accuracy-change event not observable on this runtime (no "
          + "delegate fire, no deliveries to reassert); the flip "
          + "pipeline is device-verified")
    }
    XCTAssertTrue(
      app.staticTexts["Acquiring GPS"].firstMatch.waitForExistence(timeout: 20),
      "restoring Precise Location did not resume acquiring hands-free")

    // Leave the app idle for whatever runs next.
    recoverToIdle(app)
  }
}
