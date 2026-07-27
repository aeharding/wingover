import XCTest

// #185 REPRODUCTION DRILL — throwaway branch, never merged.
//
// Root cause, read out of Apple's shipped bundle: MapKit's pan recognizer
// inherits an EMPTY `touchesCancelled`, and `enterCancelledState()` is reachable
// from nowhere but the `enabled` setter. So no MapKit recognizer ever unwinds on
// a cancelled touch. It stays armed with an empty touch list,
// `locationInElement()` divides by that zero, and `Camera.translate()` writes the
// NaN into `camera.center` through an unvalidated
// `Object.create(MapPoint.prototype)`. A NaN velocity then passes the too-slow
// filter and never self-terminates, which is why every captured stack ended in
// `_decelerationEnded`.
//
// Owner-confirmed ceremony: Reachability, then END IT WITH A SWIPE UP FROM THE
// BOTTOM OF THE SCREEN, OVER THE APP, then open the app switcher. The close
// button does not do it. A swipe in the empty half above the app does not do it.
// So Reachability contributes one thing: it slides the app down, so the
// bottom-edge swipe begins on the MAP instead of the tab bar.
//
// MEASURED SO FAR:
//  - Top-edge system gestures deliver NOTHING to the page. iOS eats them whole.
//  - Bottom-edge swipes DO deliver `touchstart` then `touchcancel`.
//  - With a map docked to the bottom edge, that cancel lands on
//    `mk-map-node-element` — MapKit's own element — and the map SURVIVES.
//
// That last line is why this file now sweeps gesture PARAMETERS. The surviving
// case cancelled after two moves (`p1/2/1/0`): a gesture MapKit's recognizer
// never began, which is not the experiment. The owner's swipe is long and fast,
// and the stacks end in deceleration, so what has to be cancelled is a pan
// already in flight — or a fling already decelerating.
//
// The probe now reports moves-in-the-cancelled-touch (`/mvN`) and the map's
// centre, so "did the pan actually engage" is visible rather than assumed.
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

  /// A pan entirely inside the docked map (the bottom 280 pt).
  private func panDockedMap(_ app: XCUIApplication) {
    at(app, 0.5, 0.88).press(forDuration: 0.1, thenDragTo: at(app, 0.38, 0.80))
    usleep(1_200_000)
  }

  /// A hard fling on the docked map: releases with momentum, so MapKit is
  /// decelerating afterwards. This is the state every captured stack was in.
  private func flingDockedMap(_ app: XCUIApplication) {
    at(app, 0.5, 0.93).press(
      forDuration: 0.02, thenDragTo: at(app, 0.2, 0.72),
      withVelocity: .fast, thenHoldForDuration: 0)
  }

  private func pans(_ app: XCUIApplication, _ n: Int) {
    for _ in 0..<n { panDockedMap(app) }
  }

  private func comeBack(_ app: XCUIApplication) {
    usleep(1_200_000)
    app.activate()
    usleep(2_000_000)
  }

  // Baseline the earlier cycle already established, kept as the control.
  func testControlPlainPans() {
    let app = start("control")
    pans(app, 5)
    check(app, "control")
  }

  // A FAST theft: the owner's swipe is fast, and speed changes how many moves
  // the page sees before iOS claims the gesture.
  func testFastBottomSteal() {
    let app = start("fast steal")
    for i in 1...3 {
      at(app, 0.5, 1.0).withOffset(CGVector(dx: 0, dy: -1)).press(
        forDuration: 0.01, thenDragTo: at(app, 0.5, 0.35),
        withVelocity: .fast, thenHoldForDuration: 0)
      comeBack(app)
      report(app, "fast steal \(i)")
      pans(app, 2)
      report(app, "fast steal \(i) after pans")
    }
    check(app, "fast steal")
  }

  // A theft that does NOT background the app: a short flick from the bottom
  // edge, released before iOS commits to going home. Closest thing a simulator
  // has to dismissing Reachability, where the app never leaves the foreground.
  func testShortBottomFlickKeepsAppForeground() {
    let app = start("short flick")
    for i in 1...5 {
      at(app, 0.5, 1.0).withOffset(CGVector(dx: 0, dy: -1)).press(
        forDuration: 0.01, thenDragTo: at(app, 0.5, 0.93),
        withVelocity: .fast, thenHoldForDuration: 0)
      usleep(800_000)
      report(app, "short flick \(i)")
      panDockedMap(app)
      report(app, "short flick \(i) after pan")
      if probe(app).contains("POISONED") { break }
    }
    check(app, "short flick")
  }

  // Hold first so MapKit's pan recognizer definitely begins, THEN let iOS take
  // the gesture. Cancels a pan in flight rather than a gesture that never was.
  func testHoldThenSteal() {
    let app = start("hold then steal")
    for i in 1...3 {
      at(app, 0.5, 1.0).withOffset(CGVector(dx: 0, dy: -1)).press(
        forDuration: 0.6, thenDragTo: at(app, 0.5, 0.40),
        withVelocity: .default, thenHoldForDuration: 0)
      comeBack(app)
      report(app, "hold then steal \(i)")
      pans(app, 2)
      report(app, "hold then steal \(i) after pans")
    }
    check(app, "hold then steal")
  }

  // THE DECELERATION CASE. Fling the map, then steal a touch while it is still
  // coasting. Every stack captured on device ended in `_decelerationEnded`.
  func testStealDuringDeceleration() {
    let app = start("steal during decel")
    for i in 1...4 {
      flingDockedMap(app)
      // No sleep: the steal has to land inside the coast.
      at(app, 0.5, 1.0).withOffset(CGVector(dx: 0, dy: -1)).press(
        forDuration: 0.01, thenDragTo: at(app, 0.5, 0.93),
        withVelocity: .fast, thenHoldForDuration: 0)
      usleep(900_000)
      report(app, "decel steal \(i)")
      panDockedMap(app)
      report(app, "decel steal \(i) after pan")
      if probe(app).contains("POISONED") { break }
    }
    check(app, "steal during decel")
  }

  // Fling, then background and return mid-coast: the deceleration timer is
  // suspended and resumed, which is the other half of the device ceremony.
  func testFlingThenBackgroundMidCoast() {
    let app = start("fling then background")
    for i in 1...3 {
      flingDockedMap(app)
      XCUIDevice.shared.press(.home)
      comeBack(app)
      report(app, "fling+bg \(i)")
      pans(app, 2)
      report(app, "fling+bg \(i) after pans")
      if probe(app).contains("POISONED") { break }
    }
    check(app, "fling then background")
  }
}
