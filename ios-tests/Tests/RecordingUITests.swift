import XCTest

// The recording engine's reason to exist: capture keeps running while the
// webview is suspended. Swift buffers CoreLocation fixes
// (allowsBackgroundLocationUpdates), the Rust ingest thread persists them to
// session.jsonl at 1 Hz, and JS only catches up on foreground — so
// backgrounding the app must lose nothing. This test proves it three ways:
//
//   1. directly: the native session log KEEPS GROWING while the app is
//      backgrounded (read straight off the sim's filesystem — the run
//      script passes the app's data container as WINGOVER_DATA);
//   2. end-to-end: the flight saved afterwards spans the backgrounded
//      window (minutes-scale Duration around a 45 s background gap);
//   3. the flight actually moved (Distance well past a stationary fix).
//
// Motion comes from `simctl location start` playing out-and-back laps at
// 40 m/s (ios-tests/flight-path.txt, started by run.sh) — the scenario is
// host-side, so it keeps streaming no matter what the app process does.
// Takeoff auto-detects at 4.5 m/s sustained for 5 fixes; there is no
// "begin recording" button. The home button stands in for the lock button:
// XCUITest has no public lock press, and everything below the screen —
// background delivery, ingest, catch-up — is the same app-lifecycle path.
//
// Do NOT wait for the "Waiting for takeoff" screen: simctl fixes carry no
// vertical accuracy, so the armed gate (≤15 m vertical) may never pass.
// Recording starts anyway — takeoff detection is horizontal-only.
final class RecordingUITests: XCTestCase {

  // A stat row's name and value are sibling static texts (IonLabel then the
  // value note, in DOM order) — the row itself is not a single AX element,
  // so there is no concatenated label to parse. Read the text that follows
  // the name.
  private func statValue(_ app: XCUIApplication, _ name: String) -> String? {
    let texts = app.staticTexts.allElementsBoundByIndex
    guard let index = texts.firstIndex(where: { $0.label == name }),
      index + 1 < texts.count
    else { return nil }
    return texts[index + 1].label
  }

  // The Rust core's durable store, found inside the app's data container.
  // Simulator processes all run as the host user, so the runner can read
  // another app's container — one of the reasons this harness is sim-only.
  private func sessionLog() -> URL? {
    guard let root = ProcessInfo.processInfo.environment["WINGOVER_DATA"]
    else { return nil }
    let enumerator = FileManager.default.enumerator(
      at: URL(fileURLWithPath: root), includingPropertiesForKeys: nil)
    while let candidate = enumerator?.nextObject() as? URL {
      if candidate.lastPathComponent == "session.jsonl" { return candidate }
    }
    return nil
  }

  private func fixCount(_ log: URL) -> Int {
    guard let content = try? String(contentsOf: log, encoding: .utf8)
    else { return 0 }
    return content.split(separator: "\n").count
  }

  // A previous aborted run can leave a live flight (the engine self-heals
  // across relaunches by design — session.jsonl survives until stop).
  // Walk it back to idle so the test starts from a known state.
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

  func testRecordingSurvivesBackgrounding() throws {
    let app = XCUIApplication(bundleIdentifier: "app.wingover.wingover")
    app.launch()
    recoverToIdle(app)

    let start = app.buttons["Start Flight"].firstMatch
    XCTAssertTrue(
      start.waitForExistence(timeout: 30),
      "no Start Flight button — app is not idle on the Fly tab")
    start.tap()

    // Location permission is pre-granted by run.sh (simctl privacy), so no
    // system alert appears here. Takeoff needs 5 sustained fixes ≥4.5 m/s
    // at 1 Hz — the 12 m/s scenario trips it in ~5–10 s.
    let stop = app.buttons["Stop flight"].firstMatch
    XCTAssertTrue(
      stop.waitForExistence(timeout: 60),
      "recording never started — is the simctl location scenario streaming?")

    // Fly foregrounded for a bit before backgrounding.
    Thread.sleep(forTimeInterval: 15)

    XCUIDevice.shared.press(.home)
    Thread.sleep(forTimeInterval: 2)

    // (1) The direct proof: the native log grows with the webview suspended.
    let log = sessionLog()
    XCTAssertNotNil(
      log,
      "session.jsonl not found under WINGOVER_DATA while recording — "
        + "either the store moved or run.sh did not pass the container")
    let before = fixCount(log!)
    Thread.sleep(forTimeInterval: 30)
    let grown = fixCount(log!) - before
    // ~1 fix/s expected; demand half to stay far from flakiness.
    XCTAssertGreaterThanOrEqual(
      grown, 15,
      "native session log grew by only \(grown) fixes in 30 s backgrounded")
    Thread.sleep(forTimeInterval: 13)

    // Foreground: the JS poll resumes and drains the whole backlog.
    app.activate()
    XCTAssertTrue(
      stop.waitForExistence(timeout: 15),
      "recording UI did not come back on foreground")
    Thread.sleep(forTimeInterval: 10)

    // (2)+(3) End the flight deterministically: Stop → BigConfirm "Stop".
    stop.tap()
    let confirm = app.buttons["Stop"].firstMatch
    XCTAssertTrue(confirm.waitForExistence(timeout: 5), "no End flight? confirm")
    confirm.tap()

    // Saved: the tab shell replaces the flight surface.
    let logbookTab = app.buttons["Logbook"].firstMatch
    XCTAssertTrue(
      logbookTab.waitForExistence(timeout: 20),
      "tab shell did not return after stopping the flight")
    logbookTab.tap()

    // Newest-first list; rows are the page's only links. The fresh flight
    // is the top row.
    let row = app.links.firstMatch
    XCTAssertTrue(row.waitForExistence(timeout: 10), "no flight row in logbook")
    row.tap()

    XCTAssertTrue(
      app.staticTexts["Duration"].firstMatch.waitForExistence(timeout: 10),
      "no Duration stat")
    // formatAirtime: "45 sec" / "2 min" / "1 hr 34 min". The flight ran
    // ≥ 80 s around the 45 s background gap, so a seconds-only duration
    // means the track lost time (the airtight gap proof is the session-log
    // growth above; this is the end-to-end echo).
    let durationText = statValue(app, "Duration") ?? ""
    let spansGap = durationText.contains("hr") || durationText.contains("min")
    XCTAssertTrue(spansGap, "flight duration too short: \(durationText)")

    // formatDistance: "1.24 mi" / "1.99 km" (2 decimals). ~90 s at 40 m/s
    // ≈ 3.6 km ≈ 2.2 mi; half of it flown while backgrounded.
    let distanceText = statValue(app, "Distance") ?? ""
    let number =
      Double(
        distanceText.split(separator: " ").first?
          .replacingOccurrences(of: ",", with: "") ?? ""
      ) ?? 0
    let floor = distanceText.contains("km") ? 2.4 : 1.5
    XCTAssertGreaterThanOrEqual(
      number, floor, "flight distance too short: \(distanceText)")

    // Leave the logbook as found: delete the test flight.
    app.buttons["Options"].firstMatch.tap()
    let deleteAction = app.buttons
      .matching(NSPredicate(format: "label BEGINSWITH %@", "Delete flight"))
      .firstMatch
    XCTAssertTrue(deleteAction.waitForExistence(timeout: 5), "no Delete action")
    deleteAction.tap()
    let confirmDelete = app.buttons["Delete"].firstMatch
    XCTAssertTrue(confirmDelete.waitForExistence(timeout: 5), "no Delete confirm")
    confirmDelete.tap()
    XCTAssertTrue(
      app.staticTexts["Logbook"].firstMatch.waitForExistence(timeout: 10),
      "did not return to the logbook after delete")
  }
}
