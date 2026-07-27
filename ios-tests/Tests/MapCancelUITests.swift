import XCTest

// #185 REPRODUCTION DRILL — throwaway branch, never merged.
//
// The device repro is Reachability, then the app switcher, and the map is grey
// 100% of the time. A simulator has no Reachability, so this drill goes after
// the MECHANISM instead of the ceremony.
//
// Read out of Apple's shipped bundle: MapKit's pan recognizer inherits an EMPTY
// `touchesCancelled`, and `enterCancelledState()` is reachable from nowhere but
// the `enabled` setter. So no MapKit recognizer ever unwinds on `pointercancel`.
// It stays armed with an empty touch list, `locationInElement()` divides by that
// zero, and `Camera.translate()` writes the resulting NaN straight into
// `camera.center` through an unvalidated `Object.create(MapPoint.prototype)`.
//
// What Reachability supplies is only this: it slides the app down half a screen,
// so the physical bottom edge — where the next system swipe begins — stops being
// the tab bar and becomes the MAP. The touch that iOS steals is a touch that
// began on the map. Without Reachability the same swipe starts on the tab bar
// and steals nothing, which is exactly why the app switcher alone is harmless.
//
// A screen-edge system gesture steals a touch the same way Reachability's does,
// and the simulator has those. So: begin a real drag ON the map at an edge iOS
// owns, let it be stolen, come back, drag again, and read `map.center`.
//
// Synthetic DOM events were measured NOT to engage MapKit's recognizers at all
// (`panned=false`); XCUITest touches do (a drag moved the camera Kansas →
// Antarctica). That is the whole reason this is a UI test and not a unit test.
//
// The verdict is read from the page's own probe banner (src/ui/cancelProbe.ts),
// which polls every live map's `center` through try/catch and paints one line.
// FAILURE HERE IS THE RESULT BEING LOOKED FOR: a poisoned map means the
// mechanism reproduced.
final class MapCancelUITests: XCTestCase {

  override func setUp() {
    continueAfterFailure = true
  }

  private func app() -> XCUIApplication {
    XCUIApplication(bundleIdentifier: "app.wingover.wingover")
  }

  /// The probe's single painted line, or a marker when it has not appeared.
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
    // MapKit needs a moment to load and lay out before it can be poisoned.
    usleep(4_000_000)
  }

  private func at(_ app: XCUIApplication, _ dx: Double, _ dy: Double)
    -> XCUICoordinate
  {
    app.coordinate(withNormalizedOffset: CGVector(dx: dx, dy: dy))
  }

  /// A plain drag entirely inside the map. This is what a pilot's pan is, and
  /// it is also the "next stray move" that detonates an armed recognizer.
  private func panMap(_ app: XCUIApplication) {
    at(app, 0.5, 0.35).press(forDuration: 0.1, thenDragTo: at(app, 0.4, 0.5))
    usleep(1_500_000)
  }

  /// Begin a drag at a screen edge iOS owns, so the system recognizer wins and
  /// the page's touch is CANCELLED mid-gesture. Then leave the system UI the
  /// way a pilot would, and come back.
  private func steal(_ app: XCUIApplication, dx: Double) {
    at(app, dx, 0.0).withOffset(CGVector(dx: 0, dy: 1))
      .press(forDuration: 0.15, thenDragTo: at(app, dx, 0.6))
    usleep(1_500_000)
    XCUIDevice.shared.press(.home)
    usleep(1_500_000)
    app.activate()
    usleep(2_500_000)
  }

  private func assertHealthy(_ app: XCUIApplication, _ stage: String) {
    let line = probe(app)
    print("WINGOVER-PROBE [\(stage)] \(line)")
    XCTAssertFalse(
      line.contains("POISONED"),
      "MAP POISONED at \(stage) — \(line)")
  }

  // Control: real drags, no system gesture. Must stay healthy, or every other
  // result in this file means nothing.
  func testPlainPansLeaveTheMapHealthy() {
    let app = self.app()
    app.launch()
    openPlan(app)
    waitForProbe(app)
    for _ in 0..<4 { panMap(app) }
    assertHealthy(app, "plain pans")
  }

  // Notification Center: a downward drag from the TOP-LEFT edge, which on the
  // Plan tab begins on the map.
  func testNotificationCenterStealOverTheMap() {
    let app = self.app()
    app.launch()
    openPlan(app)
    waitForProbe(app)
    assertHealthy(app, "before steal")
    steal(app, dx: 0.25)
    print("WINGOVER-PROBE [after steal] \(probe(app))")
    panMap(app)
    panMap(app)
    assertHealthy(app, "after NC steal + pan")
  }

  // Control Center: the same theft from the TOP-RIGHT edge. Different system
  // recognizer, same question.
  func testControlCentreStealOverTheMap() {
    let app = self.app()
    app.launch()
    openPlan(app)
    waitForProbe(app)
    assertHealthy(app, "before steal")
    steal(app, dx: 0.9)
    print("WINGOVER-PROBE [after steal] \(probe(app))")
    panMap(app)
    panMap(app)
    assertHealthy(app, "after CC steal + pan")
  }

  // The device ceremony, as close as a simulator gets: home-indicator swipe up
  // (app switcher) with the app foregrounded, then back, then pan. On the Plan
  // tab that swipe begins on the TAB BAR, not the map — so this is the negative
  // control for the geometry argument, and it should survive.
  func testAppSwitcherFromTheTabBar() {
    let app = self.app()
    app.launch()
    openPlan(app)
    waitForProbe(app)
    at(app, 0.5, 1.0).withOffset(CGVector(dx: 0, dy: -1))
      .press(forDuration: 0.15, thenDragTo: at(app, 0.5, 0.45))
    usleep(2_000_000)
    app.activate()
    usleep(2_500_000)
    panMap(app)
    panMap(app)
    assertHealthy(app, "after tab-bar app switcher + pan")
  }
}
