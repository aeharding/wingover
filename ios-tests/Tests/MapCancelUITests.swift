import XCTest

// #185 REPRODUCTION DRILL — throwaway branch, never merged.
//
// Root cause, read out of Apple's shipped bundle: MapKit's pan recognizer
// inherits an EMPTY `touchesCancelled`, and `enterCancelledState()` is reachable
// from nowhere but the `enabled` setter. So no MapKit recognizer ever unwinds on
// a cancelled touch. It stays armed with an empty touch list,
// `locationInElement()` divides by that zero, and `Camera.translate()` writes the
// NaN into `camera.center` through an unvalidated
// `Object.create(MapPoint.prototype)`.
//
// The device ceremony, owner-confirmed: Reachability, then END IT WITH A SWIPE
// UP FROM THE BOTTOM OF THE SCREEN, OVER THE APP, then open the app switcher.
// Dismissing Reachability with its close button, or with a swipe in the empty
// half above the app, never reproduces. So Reachability contributes exactly one
// thing: it slides the app down, so that the bottom-edge swipe begins on the MAP
// rather than on the tab bar.
//
// Two measurements shaped this drill:
//  - Top-edge system gestures deliver NOTHING to the page — not even a
//    pointerdown. iOS consumes them whole. An earlier drill built on them was
//    silent for that reason, not because the mechanism is wrong.
//  - The BOTTOM edge does deliver: a home-indicator swipe produced a real
//    `touchcancel` in the page, at (201,860), on `ios tab-bar-translucent`.
//    That is the theft, landing on the wrong element.
//
// So the simulator cannot slide the app, but it can put a map where the slide
// would have put one: `src/ui/cancelProbe.ts` docks a real mapkit.Map to the
// bottom 280 px. Now the same measured theft begins on a map.
//
// Real touches, not synthetic: synthetic DOM events were measured not to engage
// MapKit's recognizers at all (`panned=false`), while an XCUITest drag moves the
// camera Kansas → Antarctica.
//
// A FAILING ASSERTION HERE IS THE RESULT BEING LOOKED FOR.
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

  private func at(_ app: XCUIApplication, _ dx: Double, _ dy: Double)
    -> XCUICoordinate
  {
    app.coordinate(withNormalizedOffset: CGVector(dx: dx, dy: dy))
  }

  private func report(_ app: XCUIApplication, _ stage: String) {
    print("WINGOVER-PROBE [\(stage)] \(probe(app))")
  }

  /// Waits for the docked map to exist, which the banner reports as `maps1`.
  private func waitForDockedMap(_ app: XCUIApplication) {
    let deadline = Date().addingTimeInterval(45)
    while Date() < deadline {
      let line = probe(app)
      if line.contains("maps") && !line.contains("maps0") { return }
      usleep(500_000)
    }
    XCTFail("docked map never appeared — \(probe(app))")
  }

  /// A pan entirely inside the docked map (the bottom 280 pt).
  private func panDockedMap(_ app: XCUIApplication) {
    at(app, 0.5, 0.88).press(forDuration: 0.1, thenDragTo: at(app, 0.38, 0.80))
    usleep(1_200_000)
  }

  /// The measured theft: a swipe up from the very bottom edge. iOS wins it, and
  /// the page gets `touchstart` then `touchcancel` — on the docked map.
  private func stealFromBottomEdge(_ app: XCUIApplication) {
    at(app, 0.5, 1.0).withOffset(CGVector(dx: 0, dy: -1))
      .press(forDuration: 0.12, thenDragTo: at(app, 0.5, 0.45))
    usleep(1_500_000)
    app.activate()
    usleep(2_000_000)
  }

  // Control. Real pans on the docked map, no theft. If this ever fails, nothing
  // else in this file means anything.
  func testDockedMapSurvivesPlainPans() {
    let app = self.app()
    app.launch()
    waitForDockedMap(app)
    report(app, "baseline")
    for _ in 0..<5 { panDockedMap(app) }
    let line = probe(app)
    report(app, "after 5 plain pans")
    XCTAssertFalse(line.contains("POISONED"), "control poisoned — \(line)")
  }

  // THE MECHANISM. Steal a touch that began on the map, then pan.
  func testBottomEdgeStealOverADockedMap() {
    let app = self.app()
    app.launch()
    waitForDockedMap(app)
    report(app, "baseline")

    stealFromBottomEdge(app)
    report(app, "after steal 1")

    // The device sequence steals twice: the swipe that ends Reachability, then
    // the swipe that opens the app switcher. The second touch is also the stray
    // move that detonates a recognizer the first one armed.
    stealFromBottomEdge(app)
    report(app, "after steal 2")

    for i in 1...4 {
      panDockedMap(app)
      report(app, "pan \(i)")
    }

    let line = probe(app)
    XCTAssertFalse(line.contains("POISONED"), "MAP POISONED — \(line)")
  }

  // Steal, pan, steal, pan — in case arming and detonation have to interleave.
  func testInterleavedStealsAndPans() {
    let app = self.app()
    app.launch()
    waitForDockedMap(app)
    report(app, "baseline")
    for round in 1...4 {
      stealFromBottomEdge(app)
      panDockedMap(app)
      panDockedMap(app)
      report(app, "round \(round)")
      if probe(app).contains("POISONED") { break }
    }
    let line = probe(app)
    XCTAssertFalse(line.contains("POISONED"), "MAP POISONED — \(line)")
  }
}
