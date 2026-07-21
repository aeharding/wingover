import Foundation
import Tauri
import UIKit
import WebKit

// tauri-plugin-ionic — the iOS half of a Capacitor-compat layer for Ionic
// apps on Tauri. Everything here is behavior a Capacitor webview would have
// exhibited, so Ionic's web components (which listen for Capacitor's window
// events and assume its webview tuning) work unmodified:
//
//   - keyboardWillShow / keyboardWillHide CustomEvents with keyboardHeight
//     (Capacitor's Keyboard plugin event names — Ionic's keyboard controller
//     hides the tab bar / footer off them).
//   - <ion-app>-style keyboard resize support: contentInset reset, outer
//     scroll pinning, and scroll disable while the keyboard is up, so the
//     web layer's resize is the ONLY movement (Capacitor resize:'ionic').
//   - The input accessory bar (‹ › Done) swizzled away — Capacitor's
//     hideFormAccessoryBar default.
//   - Programmatic focus() raises the keyboard — Capacitor's
//     keyboardDisplayRequiresUserAction=false.
//   - Native overscroll bounce restored (wry hard-disables it; Ionic's
//     scrollers are designed around it).
//
// The web half (resizing <ion-app> off the events, html.keyboard-open, the
// window.Capacitor haptics facade) is the consuming app's JS — in Wingover,
// src/tauri-ionic/.
class IonicPlugin: Plugin {
  // The webview whose <ion-app> the keyboard observers resize; weak because
  // the webview owns the plugin's lifetime, not the other way around.
  private weak var keyboardWebview: WKWebView?
  // True between keyboardWillShow and keyboardWillHide. While set, the outer
  // scroll view is pinned to the top (see observeValue).
  private var keyboardUp = false
  // Reentrancy guard: writing contentOffset re-fires the KVO observer.
  private var pinningScrollOffset = false
  private var didObserveScrollOffset = false

  // WKWebView raises the keyboard only for focus born of a user gesture; a
  // programmatic focus() lands a caret with no keyboard. There is no public
  // switch. This is the WKContentView swizzle Capacitor and Cordova have
  // shipped for years (their keyboardDisplayRequiresUserAction=false): force
  // the internal focus call's userIsInteracting flag to true. Selector
  // guarded, so a WebKit that renames it degrades to the old behavior
  // instead of crashing.
  private static let allowProgrammaticKeyboard: Void = {
    guard let contentView: AnyClass = NSClassFromString("WKContentView") else {
      return
    }
    let selector = sel_getUid(
      "_elementDidFocus:userIsInteracting:blurPreviousNode:activityStateChanges:userObject:")
    guard let method = class_getInstanceMethod(contentView, selector) else {
      return
    }
    typealias OriginalFn = @convention(c) (
      AnyObject, Selector, UnsafeRawPointer, Bool, Bool, Int, AnyObject?
    ) -> Void
    let original = unsafeBitCast(method_getImplementation(method), to: OriginalFn.self)
    let swizzled: @convention(block) (
      AnyObject, UnsafeRawPointer, Bool, Bool, Int, AnyObject?
    ) -> Void = { view, node, _, blurPrevious, changes, userObject in
      original(view, selector, node, true, blurPrevious, changes, userObject)
    }
    method_setImplementation(method, imp_implementationWithBlock(swizzled))
  }()

  // Hide the input accessory bar — the ‹ › prev/next + Done strip WKWebView
  // floats above the keyboard for form fields. WKContentView returns it from
  // its `inputAccessoryView` getter; Capacitor's hideFormAccessoryBar (on by
  // default) swizzles that getter to nil. Same swizzle here, on the private
  // WKContentView / UIWebBrowserView classes, guarded so a renamed class
  // degrades to showing the bar instead of crashing.
  private static let hideInputAccessoryBar: Void = {
    let selector = sel_getUid("inputAccessoryView")
    let block: @convention(block) (AnyObject) -> UIView? = { _ in nil }
    let imp = imp_implementationWithBlock(block)
    for className in ["WKContentView", "UIWebBrowserView"] {
      guard let cls: AnyClass = NSClassFromString(className),
        let method = class_getInstanceMethod(cls, selector)
      else { continue }
      method_setImplementation(method, imp)
    }
  }()

  // Status-bar tap → a `statusTap` CustomEvent on window, Capacitor's event
  // (its UIStatusBarManager+CAPHandleTapAction category, minus the
  // NotificationCenter hop — one plugin owns both ends here). iOS routes
  // status-bar taps to the PRIVATE UIStatusBarManager.handleTapAction:;
  // wrap it, announce, then call through so the system's own handling
  // survives. Ionic's startStatusTap (opted in via setupIonicReact
  // statusTap: true under Tauri) scrolls the visible ion-content to top off
  // the event. Selector-guarded: a renamed private method degrades to no
  // status-tap, not a crash.
  private static weak var statusTapWebview: WKWebView?
  private static let observeStatusBarTap: Void = {
    guard let cls: AnyClass = NSClassFromString("UIStatusBarManager") else { return }
    let selector = sel_getUid("handleTapAction:")
    guard let method = class_getInstanceMethod(cls, selector) else { return }
    // Optional arg: it's a pure pass-through we never message, and (id) can
    // legally be nil.
    typealias OriginalFn = @convention(c) (AnyObject, Selector, AnyObject?) -> Void
    let original = method_getImplementation(method)
    let swizzled: @convention(block) (AnyObject, AnyObject?) -> Void = { manager, action in
      IonicPlugin.statusTapWebview?.evaluateJavaScript(
        "window.dispatchEvent(new CustomEvent('statusTap'))",
        completionHandler: nil)
      unsafeBitCast(original, to: OriginalFn.self)(manager, selector, action)
    }
    method_setImplementation(method, imp_implementationWithBlock(swizzled))
  }()

  override init() {
    super.init()
    _ = Self.allowProgrammaticKeyboard
    _ = Self.hideInputAccessoryBar
    _ = Self.observeStatusBarTap
  }

  @objc public override func load(webview: WKWebView) {
    // wry hard-disables the scroll view's rubber band (setBounces(false) in
    // its WKWebView setup) and exposes no config for it. An Ionic app shell
    // is fixed layout so the main frame never scrolls anyway; re-enabling
    // costs nothing and restores the native overscroll bounce Ionic's
    // scrollers are designed around.
    webview.scrollView.bounces = true
    IonicPlugin.statusTapWebview = webview
    installKeyboardResize(webview)
  }

  //
  // On-screen keyboard
  //
  // WKWebView, unlike Safari, never resizes for the keyboard: its scroll view
  // just slides the whole body up to keep the caret visible, so a field near
  // the bottom sits behind the keyboard and the layout never reclaims the
  // space. Tauri ships no keyboard handling and the JS `visualViewport` height
  // doesn't track the keyboard inside WKWebView (tauri #10631), so the fix has
  // to originate natively.
  //
  // This ports Capacitor's `resize: 'ionic'` mode plus Voyager's patch on top
  // (no animation-duration delay; the web side resizes inside
  // requestAnimationFrame so the shrink tracks the keyboard's own animation).
  // The web layer sets <ion-app>'s inline height to (window height − keyboard
  // height) and clears it on hide, leaving `vh`, `100%`, and the webview frame
  // untouched so fixed overlays never reflow.
  //
  // Resizing <ion-app> alone is not enough: WKWebView still scrolls the outer
  // scroll view on focus to lift the caret above the keyboard, and that scroll
  // room comes from private obscured insets (zeroing contentInset does NOT
  // stop it — verified on the simulator). With the shell already resized to
  // fit above the keyboard, that scroll is pure damage — it slides the whole
  // shell up into empty space and leaves the frame draggable. So we KVO-pin
  // the outer contentOffset to the top while the keyboard is up (see
  // observeValue). The shell is fixed layout — the main frame never scrolls —
  // and ion-content's own inner scroller is a separate element, untouched.
  private func installKeyboardResize(_ webview: WKWebView) {
    // load() is not guaranteed idempotent by the host; a second call would
    // double-register every observer (and deinit removes KVO only once).
    guard !didObserveScrollOffset else { return }
    keyboardWebview = webview
    let center = NotificationCenter.default
    center.addObserver(
      self, selector: #selector(keyboardWillChange(_:)),
      name: UIResponder.keyboardWillShowNotification, object: nil)
    center.addObserver(
      self, selector: #selector(keyboardWillChange(_:)),
      name: UIResponder.keyboardWillHideNotification, object: nil)
    webview.scrollView.addObserver(
      self, forKeyPath: "contentOffset", options: [.new],
      context: &IonicPlugin.scrollOffsetKVOContext)
    didObserveScrollOffset = true
  }

  // Identifies OUR registration in observeValue, so observations belonging to
  // the Plugin base class (or a future sibling) are forwarded, not swallowed.
  private static var scrollOffsetKVOContext = 0

  // While the keyboard is up, snap the outer scroll view back to the top every
  // time WebKit tries to scroll it (the caret-reveal described above). Cheap
  // no-op when the keyboard is down or the offset is already zero. Inner
  // ion-content scrolling does not move the outer offset, so it is unaffected.
  override func observeValue(
    forKeyPath keyPath: String?, of object: Any?,
    change: [NSKeyValueChangeKey: Any]?, context: UnsafeMutableRawPointer?
  ) {
    guard context == &IonicPlugin.scrollOffsetKVOContext else {
      super.observeValue(forKeyPath: keyPath, of: object, change: change, context: context)
      return
    }
    guard keyboardUp, !pinningScrollOffset,
      let scrollView = keyboardWebview?.scrollView, scrollView.contentOffset != .zero
    else { return }
    pinningScrollOffset = true
    scrollView.contentOffset = .zero
    pinningScrollOffset = false
  }

  @objc private func keyboardWillChange(_ notification: Notification) {
    guard let webview = keyboardWebview else { return }

    var keyboardHeight: CGFloat = 0
    if notification.name == UIResponder.keyboardWillShowNotification,
      let frame = (notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?
        .cgRectValue
    {
      // Only a DOCKED keyboard should shrink the app. An iPad floating or
      // undocked keyboard hovers inside the window — its raw height would
      // carve a dead band out of the layout; leave the app alone for those
      // (they cover content the way any floating panel does). Docked means
      // the keyboard's bottom sits at the window's bottom; the covered height
      // is then the intersection (not frame.height, which can exceed the
      // window in multi-window iPad layouts).
      if let window = webview.window {
        let inWindow = window.convert(frame, from: window.screen.coordinateSpace)
        let docked = inWindow.maxY >= window.bounds.maxY - 0.5
        keyboardHeight = docked ? window.bounds.intersection(inWindow).height : 0
      } else {
        keyboardHeight = frame.height
      }
    }
    // A show that occludes nothing (floating/undocked) gets HIDE semantics
    // end-to-end: nothing to resize for, and pinning/disabling the scroll
    // view or hiding the tab bar would punish a fully visible layout.
    let hiding = keyboardHeight == 0
    keyboardUp = !hiding

    // Keep WKWebView's built-in keyboard avoidance from adding a scroll region
    // on top of the <ion-app> resize — Capacitor's resetScrollView, every event.
    webview.scrollView.contentInset = .zero
    // Undo any scroll WebKit already applied for this keyboard; observeValue
    // holds it at the top for as long as the keyboard stays up.
    if !hiding { webview.scrollView.contentOffset = .zero }
    // Disable the outer scroll view while the keyboard is up so a drag never
    // registers — otherwise the scroll indicator flashes on every attempt even
    // though observeValue snaps the offset back. This is Capacitor's
    // disableScroll (scrollView.scrollEnabled = NO); ion-content's own inner
    // scroller is a separate element, so it keeps scrolling normally.
    webview.scrollView.isScrollEnabled = hiding

    // Announce the keyboard change to the web layer, which does the DOM half:
    // resize <ion-app> to sit above the keyboard and toggle html.keyboard-open.
    // These are the same window events Capacitor's plugin dispatches, so
    // Ionic's tab bar and footer also hide themselves off them
    // (createKeyboardController). The scroll-view pinning above is the
    // native-only half JS can't reach. keyboardHeight rides in the event
    // detail so the web side never needs the native window bounds.
    let event = hiding ? "keyboardWillHide" : "keyboardWillShow"
    let detail = hiding ? "{}" : "{ detail: { keyboardHeight: \(Int(keyboardHeight)) } }"
    webview.evaluateJavaScript(
      "window.dispatchEvent(new CustomEvent('\(event)', \(detail)))",
      completionHandler: nil)
  }

  deinit {
    NotificationCenter.default.removeObserver(self)
    if didObserveScrollOffset {
      keyboardWebview?.scrollView.removeObserver(self, forKeyPath: "contentOffset")
    }
  }
}

@_cdecl("init_plugin_ionic")
func initPluginIonic() -> Plugin {
  return IonicPlugin()
}
