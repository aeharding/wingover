import XCTest

// The native announcer end-to-end: a Plan-tab pin becomes a Rust-side
// geofence at flight start, and flying into it must make the Swift speak()
// primitive say "Waypoint reached" — decided entirely in the app process,
// here with the app BACKGROUNDED during the crossing, per the reliability
// doctrine (announcements keep working with the webview suspended). The
// in-flight "Distance to waypoint" tile is the JS twin's reach tracking;
// only speak() observes the native path, and AVSpeechSynthesizer's audio
// is invisible to the AX tree — so the app is launched with
// WINGOVER_UITEST_SPEAK_LOG set, which makes speak() mirror every utterance
// to tmp/speak.log (WingoverPlugin.swift), read off the simulator's
// filesystem by this runner.
//
// Geometry: the location scenario is a constant-latitude out-and-back lap
// (run.sh + flight-path.txt), so the pin has to land on ONE line of
// latitude, within the announcer's fixed 322 m radius, and the flight
// re-crosses it every lap (~60 s). That outside→inside crossing is the one
// transition that announces; arming on the first fix is silent by design
// (launching from inside your own waypoint must not speak), so the test
// works whether the flight starts inside or outside.
//
// WHY THIS DRILL CALIBRATES INSTEAD OF PRESSING AT A MAGIC OFFSET (#151):
// MapKit's annotation layer is hidden from the accessibility tree (verified
// against XCUITest's own snapshot), so a dropped pin can be neither queried
// nor tapped, and the only way in is a long-press at a normalized offset in
// the webview. Every earlier version hard-coded that offset against
// wherever "Center on me" happened to land the camera — dy 0.444 was the
// plan map's raw container center — and #145 legitimately moved the
// landing to the map's PADDED center (the visually unobstructed middle,
// below the status bar): 24 pt on an iPhone 11, which at the app's locate
// zoom of 12 is 637 m, twice the radius. The five-rung fence that replaced
// it (#148) was sparser than the radius it had to catch — 1.09 km between
// rungs against a 644 m capture window — and the corridor landed in a gap
// (measured 424 m from the nearest rung).
//
// So this drill measures instead of assuming. Two pins one half-screen
// apart give the map's screen→latitude mapping AT WHATEVER SCALE AND
// CENTER the app legitimately chose; the app's own files supply the ground
// truth for both ends of that mapping (waypoints.json = the exact
// coordinates the presses produced, session.jsonl = the exact latitudes
// CoreLocation is feeding the app). The corridor pin is then placed at a
// computed offset, and its distance to the corridor is asserted in METRES
// before the announcement is ever waited on — so a future camera change
// fails with "the camera landed N m off", not with a mute empty log.
//
// Pin creation is probed via the "Route:" pill (plain page DOM — it appears
// once a second pin makes a route). Pins are never deleted individually (a
// tap on the marker is the only delete), but the plan IS wiped through the
// app's own route sheet at the start, so repeated local runs on one install
// calibrate against their own pins and not a previous run's.
final class WaypointUITests: XCTestCase {

  // Mirrors WAYPOINT_RADIUS_M in src/flight/waypoints.ts (0.2 mi). Only the
  // guards and the failure messages use it; the announcement itself is
  // decided by the Rust announcer against its own copy.
  private let waypointRadiusM = 0.2 * 1609.344
  // Good to ~0.1% over the few km this drill spans.
  private let metersPerDegreeLat = 111_132.0
  // The calibration rungs: one half-screen apart, clear of the status bar
  // at the top and of the route pill (dy ~0.85) at the bottom.
  private let calibrationTopDy = 0.25
  private let calibrationBottomDy = 0.75

  override func setUp() {
    // The steps build on each other; a cascade of follow-on failures after
    // the first only buries the signal.
    continueAfterFailure = false
  }

  // A previous aborted run can leave a live or armed flight (the engine
  // self-heals across relaunches by design). Walk back to idle first.
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

  private func containerFile(named name: String) -> URL? {
    guard let root = ProcessInfo.processInfo.environment["WINGOVER_DATA"]
    else { return nil }
    let enumerator = FileManager.default.enumerator(
      at: URL(fileURLWithPath: root), includingPropertiesForKeys: nil)
    while let candidate = enumerator?.nextObject() as? URL {
      if candidate.lastPathComponent == name { return candidate }
    }
    return nil
  }

  // Proof a route exists (i.e. the long-presses dropped pins). Nil while
  // fewer than two pins exist, so no pill renders.
  //
  // The pill became a <button> (a tap opens the clear-route sheet), and
  // WKWebView flattens a button's text into ONE Button whose label is the
  // whole string, e.g. "Route: 5.2 km" — no child StaticTexts. Match that
  // button. Fall back to the older exposure (sibling "Route:" + length
  // StaticTexts, as a plain <div> gave) so the probe survives either tree.
  private func routePill(_ app: XCUIApplication) -> XCUIElement? {
    app.buttons.allElementsBoundByIndex.first { $0.label.hasPrefix("Route:") }
  }

  private func routeValue(_ app: XCUIApplication) -> String? {
    if let pill = routePill(app) { return pill.label }
    let texts = app.staticTexts.allElementsBoundByIndex
    guard let index = texts.firstIndex(where: { $0.label == "Route:" }),
      index + 1 < texts.count
    else { return nil }
    return texts[index + 1].label
  }

  // Reruns on one install would otherwise leave the previous run's pins in
  // the plan, and the calibration below pairs the two pins it just dropped
  // by creation order. The route sheet's destructive action is the app's own
  // "delete all"; no pill means fewer than two pins, i.e. nothing to clear.
  private func clearPlan(_ app: XCUIApplication) {
    guard let pill = routePill(app) else { return }
    pill.tap()
    let deleteAll = app.buttons
      .matching(NSPredicate(format: "label BEGINSWITH %@", "Delete all"))
      .firstMatch
    if deleteAll.waitForExistence(timeout: 5) {
      deleteAll.tap()
    } else {
      let cancel = app.buttons["Cancel"].firstMatch
      if cancel.exists { cancel.tap() }
    }
    Thread.sleep(forTimeInterval: 1)
  }

  private func longPress(_ map: XCUIElement, dy: Double) {
    map.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: dy))
      .press(forDuration: 1.2)
    Thread.sleep(forTimeInterval: 1)
  }

  private func startFlight(_ app: XCUIApplication) {
    app.buttons["Fly"].firstMatch.tap()
    let start = app.buttons["Start Flight"].firstMatch
    XCTAssertTrue(start.waitForExistence(timeout: 15), "no Start Flight button")
    start.tap()
    XCTAssertTrue(
      app.buttons["Stop flight"].firstMatch.waitForExistence(timeout: 60),
      "recording never started")
  }

  private func stopFlight(_ app: XCUIApplication) {
    let stop = app.buttons["Stop flight"].firstMatch
    XCTAssertTrue(stop.waitForExistence(timeout: 15), "recording UI did not return")
    stop.tap()
    let confirm = app.buttons["Stop"].firstMatch
    XCTAssertTrue(confirm.waitForExistence(timeout: 5), "no End flight? confirm")
    confirm.tap()
    // Every stop here saves a flight, and the sheet that announces it takes
    // the whole tab shell out of the AX tree until it goes. Cleared HERE
    // rather than at each call site: the calibration flight's sheet was
    // still up two hundred lines later, where the failure surfaced as
    // "Failed to tap Plan Button: No matches found".
    dismissLandingSheet(app)
  }

  // The flight's waypoints exactly as the native announcer holds them: the
  // plan is copied into waypoints.json at start (plugins/wingover/src/core.rs)
  // and the file is deleted at stop, so this is only readable mid-flight.
  private func activeWaypoints(count: Int, timeout: TimeInterval)
    -> [(lat: Double, lon: Double)]
  {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      if let url = containerFile(named: "waypoints.json"),
        let data = try? Data(contentsOf: url),
        let list = (try? JSONSerialization.jsonObject(with: data))
          as? [[String: Any]],
        list.count >= count
      {
        return list.compactMap { entry in
          guard let lat = entry["latitude"] as? Double,
            let lon = entry["longitude"] as? Double
          else { return nil }
          return (lat, lon)
        }
      }
      Thread.sleep(forTimeInterval: 0.5)
    }
    return []
  }

  // The corridor's latitude, read from the app's own durable fix log rather
  // than assumed from flight-path.txt: run.sh plays that file into
  // CoreLocation, the engine persists every fix to session.jsonl, and the
  // scenario is a constant-latitude lap — so the mean of the fixes IS the
  // line the pin has to sit on. Cleared at stop, like waypoints.json.
  private func corridorLatitude(timeout: TimeInterval) -> Double? {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      if let url = containerFile(named: "session.jsonl"),
        let text = try? String(contentsOf: url, encoding: .utf8)
      {
        let lats = text.split(separator: "\n").compactMap { line -> Double? in
          guard let data = line.data(using: .utf8),
            let fix = (try? JSONSerialization.jsonObject(with: data))
              as? [String: Any]
          else { return nil }
          return fix["latitude"] as? Double
        }
        if lats.count >= 3 {
          return lats.reduce(0, +) / Double(lats.count)
        }
      }
      Thread.sleep(forTimeInterval: 0.5)
    }
    return nil
  }

  func testWaypointAnnouncementSpokenWhileBackgrounded() throws {
    let app = XCUIApplication(bundleIdentifier: "app.wingover.wingover")
    app.launchEnvironment["WINGOVER_UITEST_SPEAK_LOG"] = "1"
    app.launch()
    recoverToIdle(app)

    let planTab = app.buttons["Plan"].firstMatch
    XCTAssertTrue(planTab.waitForExistence(timeout: 30), "no Plan tab")
    planTab.tap()
    clearPlan(app)

    // Center on the (moving) simulated position. One press is enough: the
    // app's Center-on-me is an absolute move to zoom 12 (PlanPage.locate),
    // not a pan at the current zoom, so a fresh install's world-scale start
    // is gone after the first fly-to. Which point of the lap it centers on
    // does not matter — the corridor is a line of constant latitude and the
    // pin inherits the camera's longitude, so it is on the lap by
    // construction.
    let locate = app.buttons["Center on me"].firstMatch
    XCTAssertTrue(locate.waitForExistence(timeout: 10), "no Center on me")
    locate.tap()
    Thread.sleep(forTimeInterval: 3)

    let map = app.webViews.firstMatch
    let viewport = map.frame.height
    XCTAssertGreaterThan(viewport, 100, "no map viewport to press in")

    // --- calibration: two pins, one half-screen apart ----------------------
    let before = routeValue(app)
    longPress(map, dy: calibrationTopDy)
    longPress(map, dy: calibrationBottomDy)
    let after = routeValue(app)
    XCTAssertTrue(
      after != nil && after != before,
      "route pill did not appear/change — long-presses created no pins")

    // Starting the flight is what publishes the pins' real coordinates to a
    // file this runner can read; a short flight is the price of ground truth.
    startFlight(app)
    let pair = Array(activeWaypoints(count: 2, timeout: 30).suffix(2))
    XCTAssertEqual(
      pair.count, 2, "waypoints.json never carried the two calibration pins")
    let corridor = corridorLatitude(timeout: 30)
    XCTAssertNotNil(
      corridor, "session.jsonl carried no fixes — the location scenario is dead")
    stopFlight(app)

    // Both presses were the same screen column, so a longitude split means
    // the pair is not the pair we just dropped (a stale pin from an earlier
    // run at a different camera longitude).
    let lonSpreadM =
      abs(pair[0].lon - pair[1].lon) * metersPerDegreeLat
      * cos(pair[0].lat * .pi / 180)
    XCTAssertLessThan(
      lonSpreadM, 5,
      "calibration pins are \(lonSpreadM) m apart in longitude — not one column")

    let north = max(pair[0].lat, pair[1].lat)
    let south = min(pair[0].lat, pair[1].lat)
    // Screen y grows downward, latitude grows upward: negative by
    // construction, and degenerate if the presses produced one point.
    let degreesPerDy = (south - north) / (calibrationBottomDy - calibrationTopDy)
    XCTAssertLessThan(degreesPerDy, 0, "calibration pins share a latitude")
    let metersPerPoint = abs(degreesPerDy) * metersPerDegreeLat / Double(viewport)
    // A press lands on a whole point, so the map must be zoomed in far enough
    // that a point is worth much less than the radius or no computed offset
    // could be trusted. At the app's locate zoom this is ~26 m.
    XCTAssertLessThan(
      metersPerPoint, waypointRadiusM / 3,
      "map scale is \(metersPerPoint) m/pt — too coarse to place a \(waypointRadiusM) m waypoint")

    let targetDy =
      calibrationTopDy + (corridor! - north) / degreesPerDy
    // Off the map means Center-on-me left the simulated position more than a
    // third of a screen from where it centered — an app regression, not a
    // flake, and this is the line that will say so.
    XCTAssertTrue(
      (0.12...0.78).contains(targetDy),
      """
      the flight corridor is not on the plan map: Center on me put lat \
      \(corridor!) at dy \(targetDy) (calibration \(north)@\(calibrationTopDy) \
      .. \(south)@\(calibrationBottomDy), \(metersPerPoint) m/pt)
      """)

    // --- the drill ---------------------------------------------------------
    // Center on me again, and press the offset the calibration solved for.
    // The calibration measured the map's LANDING RULE — which screen row a
    // Center-on-me puts the simulated position on, and how many meters a
    // point is worth — not one particular camera, and that rule is the same
    // on the next press: the corridor's latitude is constant and the app's
    // locate is an absolute move to a fixed zoom. Re-centering is not
    // optional. A flight replaces the whole tab shell with the flight
    // surface (App.tsx: `if (inFlight) return <FlightSurface />`), so the
    // Plan page and its map are destroyed at start and rebuilt from scratch
    // at stop — the rebuilt map can come up on MapKit's construction camera
    // (a long-press then drops a pin in Kansas, which is how this was
    // caught).
    planTab.tap()
    Thread.sleep(forTimeInterval: 1.5)
    XCTAssertTrue(locate.waitForExistence(timeout: 15), "no Center on me after the flight")
    locate.tap()
    Thread.sleep(forTimeInterval: 3)
    longPress(map, dy: targetDy)

    // A stale speak.log — or anything the calibration flight might have said
    // — must not satisfy the assertion.
    if let log = containerFile(named: "speak.log") {
      try? FileManager.default.removeItem(at: log)
    }

    // Fly: the pin list is copied to the Rust announcer at start, and the
    // flight never re-reads the plan.
    startFlight(app)

    // Prove the geometry BEFORE waiting on audio, so a future camera change
    // fails as "the pin is N m off" instead of as a mute empty log.
    let placed = activeWaypoints(count: 3, timeout: 30)
    XCTAssertFalse(placed.isEmpty, "waypoints.json never carried the flight's pins")
    let miss =
      placed.map { abs($0.lat - corridor!) * metersPerDegreeLat }.min() ?? .infinity
    XCTAssertLessThan(
      miss, waypointRadiusM,
      "nearest waypoint is \(miss) m off the corridor (radius \(waypointRadiusM) m)")

    // Background the app for the crossing: the announcement must be decided
    // and spoken with the webview suspended. The speak log is read
    // host-side, so nothing needs the UI until the flight is over.
    XCUIDevice.shared.press(.home)
    let deadline = Date().addingTimeInterval(120)
    var spoken = ""
    while Date() < deadline {
      if let log = containerFile(named: "speak.log"),
        let content = try? String(contentsOf: log, encoding: .utf8)
      {
        spoken = content
        if spoken.contains("Waypoint reached") { break }
      }
      Thread.sleep(forTimeInterval: 5)
    }
    XCTAssertTrue(
      spoken.contains("Waypoint reached"),
      "no announcement within one lap; speak.log: \(spoken.isEmpty ? "<empty>" : spoken)")

    // Wind down: stop the flight, then delete BOTH logbook entries (the
    // calibration flight left one too) so a rerun starts from an empty
    // logbook.
    app.activate()
    stopFlight(app)

    let logbookTab = app.buttons["Logbook"].firstMatch
    XCTAssertTrue(logbookTab.waitForExistence(timeout: 20), "tab shell did not return")
    logbookTab.tap()
    for _ in 0..<3 {
      let row = app.links.firstMatch
      guard row.waitForExistence(timeout: 10) else { break }
      row.tap()
      app.buttons["Options"].firstMatch.tap()
      let deleteAction = app.buttons
        .matching(NSPredicate(format: "label BEGINSWITH %@", "Delete flight"))
        .firstMatch
      guard deleteAction.waitForExistence(timeout: 5) else { break }
      deleteAction.tap()
      let confirmDelete = app.buttons["Delete"].firstMatch
      if confirmDelete.waitForExistence(timeout: 5) { confirmDelete.tap() }
      Thread.sleep(forTimeInterval: 1)
    }
  }
}
