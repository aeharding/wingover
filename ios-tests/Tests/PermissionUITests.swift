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
      // Frame math, not isHittable: when the query resolves to nothing,
      // the hittability probe THROWS instead of answering — "Failed to
      // determine hittability of "Precise Location" Any: Activation point
      // invalid and no suggested hit points based on element frame" (CI
      // run 30164810665, where Settings was probed mid-transition). exists
      // plus a frame on screen answers the same question and cannot throw.
      if target.exists, !target.frame.isEmpty,
        app.windows.firstMatch.frame.intersects(target.frame)
      {
        return target
      }
      app.swipeUp()
    }
    return target.exists && !target.frame.isEmpty ? target : nil
  }

  // Wingover's Precise Location toggle, reached by navigating Settings
  // from scratch. On iOS 26 the row is a Switch WRAPPER whose only live
  // tap target is an unlabeled child Switch on the trailing edge — the
  // accessibility tree of the Location page, verified on iPhone 11 /
  // iOS 26.5:
  //
  //   Cell     id 'app.wingover.wingover'                {{20,433},{374,53}}
  //     Switch id 'app.wingover.wingover'  label 'Precise Location'  value 1
  //       Button id 'app.wingover.wingover'  label 'Precise Location'
  //       Switch (no id, no label)  value 1     {{313,445.5},{63,28}}
  //
  // Tapping the wrapper activates the middle of the row, which Settings
  // ignores: the value stays 1 and the drill proves nothing. Only the
  // child knob flips it.
  //
  // nil = this runtime has no Precise Location row at all.
  private func preciseToggle() -> XCUIElement? {
    guard let settings = openWingoverLocationInSettings() else { return nil }
    let wrapper = settings.switches
      .matching(NSPredicate(format: "label == %@", "Precise Location"))
      .firstMatch
    guard wrapper.waitForExistence(timeout: 5) else { return nil }
    return wrapper.children(matching: .switch).firstMatch
  }

  // Taps a switch to `on` and waits for the value to LAND there. Reading
  // the result back is the point: a tap that misses the control is
  // silent, and a drill that cannot tell the difference is decoration.
  private func flip(_ toggle: XCUIElement, to on: Bool) -> Bool {
    let want = on ? "1" : "0"
    if String(describing: toggle.value ?? "") == want { return true }
    toggle.tap()
    let landed = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "value == %@", want), object: toggle)
    return XCTWaiter().wait(for: [landed], timeout: 5) == .completed
  }

  // Settings navigation to Wingover's Location page. iOS 18+ nests
  // third-party apps under a root "Apps" item (below the fold); older
  // roots list them directly. Returns nil when this runtime's Settings
  // resists automation — callers XCTSkip rather than fail, because that
  // is a statement about the simulator, not the app.
  //
  // launch(), never activate(): a Settings sent to the background comes
  // back on whatever page it feels like, and probing it mid-transition is
  // what made the hittability call above throw on CI. Relaunching costs a
  // few seconds and buys a page this test knows the shape of.
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

    guard let precise = preciseToggle() else {
      throw XCTSkip(
        "no Precise Location row in this runtime's Settings; the accuracy "
          + "pipeline needs a device to drill")
    }
    // Nothing outside Settings can put accuracy back: the reduced-accuracy
    // flag survives BOTH `simctl privacy revoke location` and `reset`
    // (verified, iOS 26.5). So a drill that dies between the two flips
    // leaves every later run on this simulator red for an unrelated
    // reason — with accuracy reduced, readiness is false by design and
    // test2's grant can never resume. Teardown is the one place that also
    // runs on the failure path.
    var restored = false
    addTeardownBlock {
      if !restored, let toggle = self.preciseToggle() {
        _ = self.flip(toggle, to: true)
      }
    }
    XCTAssertTrue(
      flip(precise, to: false), "Precise Location would not turn off")

    app.activate()
    XCTAssertTrue(
      app.staticTexts["Precise Location Is Off"].firstMatch
        .waitForExistence(timeout: 20),
      "Precise Location off mid-acquiring did not surface its takeover")

    // And back: the pilot flips the switch, the app recovers with no taps.
    guard let again = preciseToggle() else {
      XCTFail("the Precise Location row vanished before restoring it")
      return
    }
    restored = flip(again, to: true)
    XCTAssertTrue(restored, "Precise Location would not turn back on")
    app.activate()
    XCTAssertTrue(
      app.staticTexts["Acquiring GPS"].firstMatch.waitForExistence(timeout: 20),
      "restoring Precise Location did not resume acquiring hands-free")

    // Leave the app idle for whatever runs next.
    recoverToIdle(app)
  }
}
