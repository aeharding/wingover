import XCTest

// #185 REPRODUCTION DRILL — throwaway branch, never merged.
//
// The device gave up the whole mechanism. Trail pulled off the phone after the
// owner's 100%-reliable repro (Reachability, end it with a swipe up from the
// bottom of the screen over the app, then the app switcher):
//
//   184879  pointerdown    261,461   mk-map-node-element
//   184884  pointermove    260,440   mk-map-node-element
//   184890  pointermove    258,424   mk-map-node-element
//   184892  pointercancel  258,424   mk-map-node-element   <-- ARMS
//      ...1170 ms...
//   186063  pointerdown    258,799   ios tab-bar-translucent
//   186072  pointermove    258,787   ios tab-bar-translucent
//   186088  pointermove    258,777   ios tab-bar-translucent
//   186097  TypeError: [MapKit] map rect property origin.x is not a number
//
// Two facts in that trail, neither of which was guessed:
//
//  1. The arming touch begins at page-y 461 of an 812 pt viewport — the middle
//     of the page — while the finger was at the physical bottom edge. That is
//     Reachability's slide, and it puts the bottom edge on the MAP.
//  2. The DETONATING moves are on the TAB BAR. They never touch the map. From
//     Apple's bundle: a gesture attaches window-level move listeners when it
//     begins and drops them when it ends, but `touchesCancelled` is EMPTY, so
//     after a cancel it keeps receiving every move on the page with an empty
//     touch list. `locationInElement()` divides by that zero, and
//     `Camera.translate()` writes the NaN into `camera.center`.
//
// This is why five earlier simulator drills all passed: each one followed the
// steal by panning THE MAP, and a fresh `touchstart` on the map repopulates the
// touch list. They were healing it, not detonating it.
//
// It also explains, with no special pleading, why the fullscreen logbook map
// never reproduces: it is `inset: 0`, so the follow-up swipe lands on the map
// and repopulates. On Plan and Fly the tab bar owns the bottom edge, so the
// follow-up misses the map and the list stays empty.
//
// Layout under test: `cancelProbe.ts` docks a real mapkit.Map to the bottom
// 280 pt (the only place a system gesture delivers a cancel here), leaving the
// rest of the page bare for the detonating touch.
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

  private func start(_ name: String) -> XCUIApplication {
    let app = self.app()
    app.launch()
    let deadline = Date().addingTimeInterval(45)
    while Date() < deadline {
      let line = probe(app)
      if line.contains("maps") && !line.contains("maps0") { break }
      usleep(500_000)
    }
    report(app, "\(name) baseline")
    return app
  }

  private func check(_ app: XCUIApplication, _ name: String) {
    let line = probe(app)
    report(app, "\(name) FINAL")
    XCTAssertFalse(line.contains("POISONED"), "MAP POISONED [\(name)] — \(line)")
  }

  /// ARM: a touch that begins on the docked map and is cancelled by iOS. The
  /// device's arming touch saw two moves before its cancel; so does this.
  private func arm(_ app: XCUIApplication) {
    at(app, 0.5, 1.0).withOffset(CGVector(dx: 0, dy: -1))
      .press(forDuration: 0.05, thenDragTo: at(app, 0.5, 0.86))
    usleep(1_200_000)
    app.activate()
    usleep(1_500_000)
  }

  /// DETONATE: moves delivered to the page from a touch that is NOT on the map,
  /// so nothing repopulates the touch list. The device's were on the tab bar.
  private func detonateOffMap(_ app: XCUIApplication) {
    at(app, 0.5, 0.30).press(forDuration: 0.1, thenDragTo: at(app, 0.5, 0.18))
    usleep(1_000_000)
  }

  /// The counter-experiment: the same follow-up, but ON the map. This is what
  /// every earlier drill did, and what the fullscreen logbook map does.
  private func panOnMap(_ app: XCUIApplication) {
    at(app, 0.5, 0.88).press(forDuration: 0.1, thenDragTo: at(app, 0.38, 0.80))
    usleep(1_000_000)
  }

  // THE REPRODUCTION. Arm on the map, detonate off it.
  func testArmOnMapThenDetonateOffMap() {
    let app = start("arm+detonate")
    for round in 1...4 {
      arm(app)
      report(app, "round \(round) armed")
      detonateOffMap(app)
      report(app, "round \(round) detonated")
      if probe(app).contains("POISONED") { break }
    }
    check(app, "arm+detonate")
  }

  // Same arming, follow-up ON the map. Predicted to SURVIVE — and if it does,
  // it is the difference between the Plan tab and the fullscreen logbook map.
  func testArmOnMapThenPanOnMap() {
    let app = start("arm+pan-on-map")
    for round in 1...4 {
      arm(app)
      panOnMap(app)
      report(app, "round \(round)")
      if probe(app).contains("POISONED") { break }
    }
    check(app, "arm+pan-on-map")
  }

  // Off-map drags with NO arming touch. Isolates the detonation half: it must
  // be harmless on its own, or the arming step is not what matters.
  func testOffMapDragsWithoutArming() {
    let app = start("no arming")
    for _ in 0..<6 { detonateOffMap(app) }
    check(app, "no arming")
  }

  // The device waited 1170 ms between the cancel and the detonating touch, and
  // backgrounded in between. This holds that shape as closely as a simulator
  // can, in case the delay or the background matters.
  func testArmBackgroundThenDetonate() {
    let app = start("arm+bg+detonate")
    for round in 1...3 {
      arm(app)
      XCUIDevice.shared.press(.home)
      usleep(1_200_000)
      app.activate()
      usleep(2_000_000)
      report(app, "round \(round) after background")
      detonateOffMap(app)
      detonateOffMap(app)
      report(app, "round \(round) detonated")
      if probe(app).contains("POISONED") { break }
    }
    check(app, "arm+bg+detonate")
  }
}
