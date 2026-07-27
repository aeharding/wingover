import XCTest

// #185 REPRODUCTION DRILL — throwaway branch, never merged.
//
// Read out of Apple's shipped bundle: MapKit's pan recognizer inherits an EMPTY
// `touchesCancelled`, and `enterCancelledState()` is reachable from nowhere but
// the `enabled` setter. So no MapKit recognizer ever unwinds on a cancelled
// touch. It stays armed with an empty touch list, `locationInElement()` divides
// by that zero, and `Camera.translate()` writes the NaN straight into
// `camera.center` through an unvalidated `Object.create(MapPoint.prototype)`.
//
// The device repro is Reachability, then the app switcher. Reachability is not
// the mechanism: it slides the app down half a screen, so the physical bottom
// edge — where the next system swipe begins — stops being the tab bar and
// becomes the MAP. What matters is only that iOS steals a touch that BEGAN on
// the map.
//
// First drill measured a clean negative: four screen-edge gestures, zero
// cancels delivered to the page and no `pointerdown` either. iOS consumed those
// touches whole. So the question ahead of the hypothesis is an empirical one —
// WHAT, in this webview, actually delivers a cancel? — and that is what the
// sweep below measures rather than assumes.
//
// Real touches, not synthetic: synthetic DOM events were measured not to engage
// MapKit's recognizers at all (`panned=false`), while an XCUITest drag moves the
// camera Kansas → Antarctica.
//
// The verdict is read from the page's own probe banner (src/ui/cancelProbe.ts):
// pointer and touch counters, the last cancel's target, and every live map's
// `center` polled through try/catch.
final class MapCancelUITests: XCTestCase {

  override func setUp() {
    continueAfterFailure = true
  }

  private func app() -> XCUIApplication {
    XCUIApplication(bundleIdentifier: "app.wingover.wingover")
  }

  private func probe(_ app: XCUIApplication) -> String {
    for text in app.staticTexts.allElementsBoundByIndex
    where text.label.hasPrefix("PROBE") {
      return text.label
    }
    return "<no probe>"
  }

  private func waitForProbe(_ app: XCUIApplication) {
    let deadline = Date().addingTimeInterval(30)
    while Date() < deadline {
      if probe(app) != "<no probe>" { return }
      usleep(300_000)
    }
    XCTFail("probe banner never appeared; the page did not boot")
  }

  private func openPlan(_ app: XCUIApplication) {
    let plan = app.buttons["Plan"].firstMatch
    XCTAssertTrue(plan.waitForExistence(timeout: 30), "no Plan tab")
    plan.tap()
    usleep(4_000_000)
  }

  private func at(_ app: XCUIApplication, _ dx: Double, _ dy: Double)
    -> XCUICoordinate
  {
    app.coordinate(withNormalizedOffset: CGVector(dx: dx, dy: dy))
  }

  private func report(_ app: XCUIApplication, _ stage: String) {
    print("WINGOVER-PROBE [\(stage)] \(probe(app))")
  }

  /// A gesture that may hand the screen to iOS. Come back the way a pilot
  /// would, then read the counters.
  private func gesture(
    _ app: XCUIApplication, _ name: String,
    from: XCUICoordinate, to: XCUICoordinate,
    hold: TimeInterval = 0.12, leavesApp: Bool = true
  ) {
    from.press(forDuration: hold, thenDragTo: to)
    usleep(1_200_000)
    if leavesApp {
      XCUIDevice.shared.press(.home)
      usleep(1_200_000)
      app.activate()
      usleep(2_000_000)
    }
    report(app, name)
  }

  // THE SWEEP. One question: which gesture, if any, delivers a cancel to the
  // page? Counters are cumulative, so a rising `c` names the culprit.
  func testWhatDeliversACancel() {
    let app = self.app()
    app.launch()
    openPlan(app)
    waitForProbe(app)
    report(app, "baseline")

    // Control: an ordinary pan, entirely inside the map.
    gesture(
      app, "plain pan", from: at(app, 0.5, 0.35), to: at(app, 0.4, 0.5),
      leavesApp: false)

    // Top edge at three depths. The system's activation band is finite; inside
    // it the app is delivered touches and then cancelled, outside it the app is
    // never told at all.
    for inset in [1.0, 10.0, 26.0, 44.0] {
      gesture(
        app, "top edge +\(Int(inset))",
        from: at(app, 0.3, 0.0).withOffset(CGVector(dx: 0, dy: inset)),
        to: at(app, 0.3, 0.6))
    }

    // Bottom edge, the home-indicator band. On Plan this begins on the TAB BAR,
    // which is the geometry Reachability changes.
    for inset in [1.0, 12.0, 30.0] {
      gesture(
        app, "bottom edge -\(Int(inset))",
        from: at(app, 0.5, 1.0).withOffset(CGVector(dx: 0, dy: -inset)),
        to: at(app, 0.5, 0.45))
    }

    // Side edges: back-swipe and its mirror.
    gesture(
      app, "left edge",
      from: at(app, 0.0, 0.4).withOffset(CGVector(dx: 2, dy: 0)),
      to: at(app, 0.7, 0.4))
    gesture(
      app, "right edge",
      from: at(app, 1.0, 0.4).withOffset(CGVector(dx: -2, dy: 0)),
      to: at(app, 0.3, 0.4))

    // A long press first, then a drag: a different recognizer wins the touch,
    // which is another way a pan gets cancelled.
    gesture(
      app, "longpress then drag", from: at(app, 0.5, 0.4),
      to: at(app, 0.35, 0.55), hold: 1.6, leavesApp: false)

    // Whatever armed anything above, detonate it.
    for _ in 0..<3 {
      at(app, 0.5, 0.35).press(forDuration: 0.1, thenDragTo: at(app, 0.4, 0.5))
      usleep(900_000)
    }
    report(app, "FINAL after pans")

    let line = probe(app)
    XCTAssertFalse(line.contains("POISONED"), "MAP POISONED — \(line)")
  }

  // The same sweep where the map itself owns the bottom edge: the fullscreen
  // logbook map is `position: fixed; inset: 0`, so a home-indicator swipe there
  // begins ON the map with no Reachability needed. That is the geometry the
  // device repro manufactures.
  func testHomeIndicatorOverAFullscreenMap() {
    let app = self.app()
    app.launch()
    let logbook = app.buttons["Logbook"].firstMatch
    XCTAssertTrue(logbook.waitForExistence(timeout: 30), "no Logbook tab")
    logbook.tap()
    usleep(3_000_000)
    report(app, "logbook")

    // Whatever opens a map here; the drill reports what it found either way.
    let mapButton = app.buttons["Map"].firstMatch
    if mapButton.waitForExistence(timeout: 6) {
      mapButton.tap()
      usleep(5_000_000)
    }
    waitForProbe(app)
    report(app, "fullscreen map")

    for inset in [1.0, 12.0, 30.0] {
      gesture(
        app, "fullscreen bottom -\(Int(inset))",
        from: at(app, 0.5, 1.0).withOffset(CGVector(dx: 0, dy: -inset)),
        to: at(app, 0.5, 0.45))
    }
    for _ in 0..<3 {
      at(app, 0.5, 0.5).press(forDuration: 0.1, thenDragTo: at(app, 0.4, 0.62))
      usleep(900_000)
    }
    report(app, "FINAL after pans")

    let line = probe(app)
    XCTAssertFalse(line.contains("POISONED"), "MAP POISONED — \(line)")
  }
}
