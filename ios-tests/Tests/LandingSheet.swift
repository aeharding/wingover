import XCTest

/// Dismiss the sheet a finished flight raises (src/ui/app/logbook/EndedFlightSheet).
///
/// Every drill that ends a flight and then drives the shell needs this, and
/// the reason is stronger than "the sheet is in the way": a presented
/// ion-modal takes everything behind it OUT of the accessibility tree, so the
/// tab bar does not sit under the sheet — it does not exist. The symptom is
/// therefore `No matches found for "Logbook" Button`, which reads like the
/// shell failing to return rather than like a modal being up. Measured on
/// a simulator before this existed: RecordingUITests:132 failed with exactly
/// that, "tab shell did not return after stopping the flight".
///
/// Only for flights that SAVED. A discarded or never-launched session raises
/// nothing, and waiting here would just burn the timeout.
func dismissLandingSheet(_ app: XCUIApplication) {
  let close = app.buttons["Close"].firstMatch
  XCTAssertTrue(
    close.waitForExistence(timeout: 20),
    "no landing sheet after the flight saved")
  // Tapped by OFFSET FROM ITS ORIGIN, not by the element, because XCUITest
  // taps an element's centre and this element's reported size is wrong. In a
  // presented sheet WKWebView does not account for the modal's translate when
  // it maps accessibility frames: the button measures 30x30 in the DOM and
  // reports {{350, 535}, {31, 479}} to the AX tree — origin right, height
  // sixteen times too big. A centre tap lands at y≈774, down among the stat
  // rows, and the sheet just sits there. The origin is trustworthy, so 15,15
  // into it is the middle of the real button.
  close.coordinate(withNormalizedOffset: .zero)
    .withOffset(CGVector(dx: 15, dy: 15))
    .tap()
  // Wait for it to be GONE, not merely tapped: the dismissal is animated, and
  // a tab button that has re-entered the AX tree is still behind the sheet
  // while it slides — measured as `Failed to ... not hittable: Button, label:
  // 'Logbook'` one line after this call.
  XCTAssertTrue(
    close.waitForNonExistence(timeout: 10),
    "landing sheet did not dismiss")
}
