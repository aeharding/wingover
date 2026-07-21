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
// Geometry: the location scenario is an out-and-back lap (run.sh +
// flight-path.txt), so "wherever the sim is right now" is a point the path
// re-crosses every lap. A pin is dropped there (Center on me → long-press
// the map center — pins are created ONLY by long-press, at the pressed
// point). The flight then leaves the pin's fixed 322 m radius and re-enters
// within one lap (~60 s worst case). That outside→inside crossing is the
// one transition that announces; arming on the first fix is silent by
// design (launching from inside your own waypoint must not speak), so the
// test works whether the flight starts inside or outside.
//
// MapKit's annotation layer is hidden from the accessibility tree (verified
// against XCUITest's own snapshot), so the pin markers can be neither
// queried nor tapped: pin creation is probed via the "Route:" pill (plain
// page DOM — it appears once a second pin makes a route), and pins are
// never deleted (a tap on the marker is the only delete). CI runs on a
// fresh install every time; local reruns accumulate a couple of pins per
// run, which only adds announcement sources and cannot break the assertion.
final class WaypointUITests: XCTestCase {

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

  // The pill renders as sibling texts: "Route:" then the length. Nil while
  // fewer than two pins exist.
  private func routeValue(_ app: XCUIApplication) -> String? {
    let texts = app.staticTexts.allElementsBoundByIndex
    guard let index = texts.firstIndex(where: { $0.label == "Route:" }),
      index + 1 < texts.count
    else { return nil }
    return texts[index + 1].label
  }

  func testWaypointAnnouncementSpokenWhileBackgrounded() throws {
    let app = XCUIApplication(bundleIdentifier: "app.wingover.wingover")
    app.launchEnvironment["WINGOVER_UITEST_SPEAK_LOG"] = "1"
    app.launch()
    recoverToIdle(app)

    // Stale speak.log from an earlier run must not satisfy the assertion.
    if let log = containerFile(named: "speak.log") {
      try? FileManager.default.removeItem(at: log)
    }

    let planTab = app.buttons["Plan"].firstMatch
    XCTAssertTrue(planTab.waitForExistence(timeout: 30), "no Plan tab")
    planTab.tap()

    // Center on the (moving) simulated position, then drop two pins: one at
    // the screen center — a point on the scenario's corridor by
    // construction — and one to the north whose only job is to complete a
    // route, because the route pill is the only AX-visible proof the
    // presses took.
    let locate = app.buttons["Center on me"].firstMatch
    XCTAssertTrue(locate.waitForExistence(timeout: 10), "no Center on me")
    locate.tap()
    Thread.sleep(forTimeInterval: 2)
    // Centering keeps the current zoom, and a fresh install starts at world
    // scale — where the few-points offset between the press and the true
    // camera-center row measured ~73 km of latitude. Pinch in hard so the
    // same offset is tens of meters, then re-center: the simulated position
    // kept moving while we zoomed, and each pinch anchors at the gesture
    // centroid, not the camera center, so the camera wanders regardless.
    let map = app.webViews.firstMatch
    for _ in 0..<4 {
      map.pinch(withScale: 8, velocity: 8)
      Thread.sleep(forTimeInterval: 1)
    }
    locate.tap()
    Thread.sleep(forTimeInterval: 2)
    let before = routeValue(app)
    // 0.444: the visual center of the map area (the tab bar is excluded
    // from the map but not from the webview's frame).
    map.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.444))
      .press(forDuration: 1.2)
    Thread.sleep(forTimeInterval: 1)
    map.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.32))
      .press(forDuration: 1.2)
    Thread.sleep(forTimeInterval: 1)
    let after = routeValue(app)
    XCTAssertTrue(
      after != nil && after != before,
      "route pill did not appear/change — long-presses created no pins")

    // Fly: the pin list is copied to the Rust announcer at start, and the
    // flight never re-reads the plan.
    app.buttons["Fly"].firstMatch.tap()
    let start = app.buttons["Start Flight"].firstMatch
    XCTAssertTrue(start.waitForExistence(timeout: 10), "no Start Flight button")
    start.tap()
    let stop = app.buttons["Stop flight"].firstMatch
    XCTAssertTrue(stop.waitForExistence(timeout: 60), "recording never started")

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

    // Wind down: stop the flight and delete it from the logbook.
    app.activate()
    XCTAssertTrue(stop.waitForExistence(timeout: 15), "recording UI did not return")
    stop.tap()
    let confirm = app.buttons["Stop"].firstMatch
    XCTAssertTrue(confirm.waitForExistence(timeout: 5), "no End flight? confirm")
    confirm.tap()

    let logbookTab = app.buttons["Logbook"].firstMatch
    XCTAssertTrue(logbookTab.waitForExistence(timeout: 20), "tab shell did not return")
    logbookTab.tap()
    let row = app.links.firstMatch
    if row.waitForExistence(timeout: 10) {
      row.tap()
      app.buttons["Options"].firstMatch.tap()
      let deleteAction = app.buttons
        .matching(NSPredicate(format: "label BEGINSWITH %@", "Delete flight"))
        .firstMatch
      if deleteAction.waitForExistence(timeout: 5) {
        deleteAction.tap()
        let confirmDelete = app.buttons["Delete"].firstMatch
        if confirmDelete.waitForExistence(timeout: 5) { confirmDelete.tap() }
      }
    }
  }
}
