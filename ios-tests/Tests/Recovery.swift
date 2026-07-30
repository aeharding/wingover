import XCTest

// What the app can be showing when a drill takes hold of it, and the button
// that proves each. Two mechanisms keep these apart: a presented ion-modal
// takes everything behind it out of the accessibility tree (see
// dismissLandingSheet), and a flight sheds the whole tab shell
// (src/ui/App.tsx: `if (inFlight) return <FlightSurface />`).
//
// Declaration order is precedence, for the overlaps those two do not rule
// out: the sheet first because nothing behind it can be read, the shell
// before the pre-takeoff Cancel because a shell that is already up needs no
// recovery at all.
private enum LaunchState: String, CaseIterable {
  case landingSheet = "Close"
  case recording = "Stop flight"
  case shell = "Fly"
  case pending = "Cancel"
}

/// Walk whatever a previous run left behind — a recording flight, a
/// pre-takeoff session, a blocking takeover, an undismissed landing sheet —
/// back to the ground shell.
///
/// Every suite needs it and none can skip it: ios-tests/run.sh resets the
/// simulator's location and permissions between invocations but nothing
/// resets the app's own flight, and the engine deliberately resumes a live
/// flight on the next launch (STEERING: recording never loses a flight).
///
/// Loud on purpose. The three per-suite copies this replaced were not, and
/// both halves of that cost showed up in CI:
///   - they stopped a recording flight and then waited for the shell, which a
///     SAVED flight's sheet keeps out of the tree — run 30456461261, where
///     WaypointUITests tapped Stop at t=8.67s, spent 20 s on a "Fly" button
///     that was not in the tree, carried on regardless, and failed as "no
///     Plan tab";
///   - they probed "Stop flight" for 3 s, then "Cancel" for 10 s, and said
///     nothing at all when neither answered, so whatever the app was really
///     showing stayed unnamed. Run 30246617113 is what that costs: both
///     probes came back empty by t=19.1s, the caller then spent 50 s on a
///     "Start Flight" that never appeared, and the only evidence left was
///     "XCTAssertTrue failed - app is not idle" at PermissionUITests:144.
func recoverToIdle(_ app: XCUIApplication) {
  guard let state = launchState(app) else { return }
  switch state {
  case .shell:
    return
  case .landingSheet:
    dismissLandingSheet(app)
  case .recording:
    // Stopping a recording flight saves it, and the save raises the sheet.
    stop(app, with: app.buttons[LaunchState.recording.rawValue].firstMatch)
    dismissLandingSheet(app)
  case .pending:
    // Before takeoff there is nothing to finalize, so the confirmed action
    // discards instead of ending (src/ui/flight/FlightSurface.tsx:
    // confirmEndFlight) and no flight is saved to announce.
    stop(app, with: app.buttons[LaunchState.pending.rawValue].firstMatch)
  }
  XCTAssertTrue(
    app.buttons[LaunchState.shell.rawValue].firstMatch
      .waitForExistence(timeout: 30),
    "the tab shell did not come back after recovering from \(state)")
}

// Both flight-surface stops are guarded by the same BigConfirm ("End flight?"
// with a "Stop" action); the blocking takeover's Cancel discards directly. So
// the confirm is tapped when it appears rather than waited on hard.
private func stop(_ app: XCUIApplication, with button: XCUIElement) {
  button.tap()
  let confirm = app.buttons["Stop"].firstMatch
  if confirm.waitForExistence(timeout: 5) { confirm.tap() }
}

// Waits for the app to paint a state this file knows, then names it.
//
// The wait is on the app's own UI rather than on a guessed interval because a
// cold launch under CI load is slow enough to make any short probe a coin
// flip: in run 30246617113 launch() — which returns once the app reports idle
// — took 23 s in that run's WaypointUITests, and one existence check against
// the webview cost 2 s in its PermissionUITests.
private func launchState(_ app: XCUIApplication, timeout: TimeInterval = 60)
  -> LaunchState?
{
  let labels = LaunchState.allCases.map(\.rawValue)
  let known = app.buttons
    .matching(
      NSPredicate(format: "label IN %@ OR identifier IN %@", labels, labels)
    )
    .firstMatch
  guard known.waitForExistence(timeout: timeout) else {
    XCTFail(
      """
      the app painted none of \(labels) within \(Int(timeout))s, so nothing \
      here can name what it is showing, let alone recover it. A flight stuck \
      in collection is one way in: that surface carries no buttons at all \
      until its retry appears (src/ui/flight/SavingSurface.tsx). Tree:
      \(app.debugDescription)
      """)
    return nil
  }
  guard
    let state = LaunchState.allCases.first(where: {
      app.buttons[$0.rawValue].firstMatch.exists
    })
  else {
    XCTFail(
      """
      one of \(labels) existed and was gone a snapshot later. Tree:
      \(app.debugDescription)
      """)
    return nil
  }
  return state
}
