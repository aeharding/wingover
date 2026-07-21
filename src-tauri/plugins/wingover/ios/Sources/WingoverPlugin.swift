import AuthenticationServices
import AVFoundation
import CoreLocation
import Foundation
import Security
import StoreKit
import Tauri
import UIKit
import WebKit

// Holds the in-flight Sign in with Apple request. ASAuthorizationController
// keeps only weak references to its delegate, so the plugin retains this until
// Apple's sheet resolves — dropping it early would strand the invoke forever.
class SiwaDelegate: NSObject, ASAuthorizationControllerDelegate,
  ASAuthorizationControllerPresentationContextProviding
{
  private let invoke: Invoke
  private let done: () -> Void

  init(invoke: Invoke, done: @escaping () -> Void) {
    self.invoke = invoke
    self.done = done
  }

  func authorizationController(
    controller: ASAuthorizationController,
    didCompleteWithAuthorization authorization: ASAuthorization
  ) {
    defer { done() }
    // The raw JWT, verbatim. The server verifies it against Apple's JWKS and
    // reads only the stable subject — re-encoding it would break the signature,
    // same rule as the StoreKit JWS below.
    guard
      let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
      let data = credential.identityToken,
      let token = String(data: data, encoding: .utf8)
    else {
      invoke.reject("no identity token in authorization")
      return
    }
    invoke.resolve(["identityToken": token])
  }

  func authorizationController(
    controller: ASAuthorizationController, didCompleteWithError error: Error
  ) {
    defer { done() }
    // "cancelled" verbatim, matching storekitPurchase — the JS side treats a
    // closed sheet as a non-event, not a problem to display.
    if let authError = error as? ASAuthorizationError, authError.code == .canceled {
      invoke.reject("cancelled")
    } else {
      invoke.reject(error.localizedDescription)
    }
  }

  func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
    UIApplication.shared.connectedScenes
      .compactMap { ($0 as? UIWindowScene)?.keyWindow }
      .first ?? ASPresentationAnchor()
  }
}

class SpeakArgs: Decodable {
  let text: String
}

class KeychainGetArgs: Decodable {
  let key: String
}

class KeychainSetArgs: Decodable {
  let key: String
  let value: String
}

class ProductsArgs: Decodable {
  let productIds: [String]
}

class PurchaseArgs: Decodable {
  let productId: String
}

class EntitlementArgs: Decodable {
  /// Which products count as "our subscription". Transaction.all carries every
  /// SKU this Apple Account ever bought from us, so the fallback below has to
  /// know what it is looking for.
  let productIds: [String]
}

class ShareFileArgs: Decodable {
  let name: String
  let content: String
}

/// Sends new-window requests to the system browser; forwards everything else
/// to wry's own delegate.
///
/// WKWebView opens no window for `target="_blank"` or `window.open()` on its
/// own, so any link asking for one just does nothing on tap — notably Apple
/// Maps' "Legal" credit, which lives in a CLOSED shadow root that no JS click
/// handler can reach (the event is retargeted to the shadow host before it
/// ever bubbles to `document`). wry routes new-window requests through
/// `createWebViewWith` and, with no handler configured, drops them. We take
/// that one method to open the URL in Safari, and forward every other call
/// (JS dialogs, capture-permission prompts, the file picker) to the delegate
/// wry already installed, so nothing else regresses.
final class NewWindowToBrowserDelegate: NSObject, WKUIDelegate {
  weak var forwardTo: WKUIDelegate?

  init(forwardingTo delegate: WKUIDelegate?) {
    self.forwardTo = delegate
    super.init()
  }

  func webView(
    _ webView: WKWebView,
    createWebViewWith configuration: WKWebViewConfiguration,
    for navigationAction: WKNavigationAction,
    windowFeatures: WKWindowFeatures
  ) -> WKWebView? {
    if let url = navigationAction.request.url,
      let scheme = url.scheme?.lowercased(),
      scheme == "http" || scheme == "https"
    {
      UIApplication.shared.open(url)
    }
    // Never a child webview: the app is one fixed shell.
    return nil
  }

  override func responds(to aSelector: Selector!) -> Bool {
    super.responds(to: aSelector) || (forwardTo?.responds(to: aSelector) ?? false)
  }

  override func forwardingTarget(for aSelector: Selector!) -> Any? {
    if let forwardTo = forwardTo, forwardTo.responds(to: aSelector) {
      return forwardTo
    }
    return super.forwardingTarget(for: aSelector)
  }
}

// Sensor/actuator shim (ARCHITECTURE.md): five dumb primitives — capture,
// drain, permissions, speak, share. NO business logic, NO storage: the
// Rust core owns the durable session log, cursors, and all announcement
// decisions. This class only bridges CoreLocation in (background delivery
// on), speech out, and the system share sheet.
class WingoverPlugin: Plugin, CLLocationManagerDelegate {
  private let locationManager = CLLocationManager()
  private let speechSynthesizer = AVSpeechSynthesizer()
  private var permissionRequests: [Invoke] = []
  private var positionRequests: [Invoke] = []
  private var siwa: SiwaDelegate?
  private var lastError: String?
  // WKWebView.uiDelegate is weak, so the plugin retains ours for the app's life.
  private var newWindowDelegate: NewWindowToBrowserDelegate?

  // In-memory buffer between drains (~1 s of fixes). Mutated on the main
  // thread only. A hard process kill loses only this window — the accepted
  // torn-tail class; everything drained is already durable in Rust.
  private var buffer: [JsonObject] = []
  private var lastTimestamp: Int64 = 0

  override init() {
    super.init()
    locationManager.delegate = self
  }

  // The webview tuning that makes Ionic feel native (overscroll bounce,
  // keyboard resize + pinning, accessory bar, programmatic focus) lives in
  // tauri-plugin-ionic — this load keeps only the app-specific bits.
  @objc public override func load(webview: WKWebView) {
    // WKWebView opens no window for target=_blank / window.open, so links
    // that request one die on tap — the Apple Maps "Legal" credit lives in a
    // closed shadow root no JS handler can reach. Route those to Safari,
    // wrapping wry's delegate so the file picker (GPX import) and dialogs are
    // untouched.
    let delegate = NewWindowToBrowserDelegate(forwardingTo: webview.uiDelegate)
    newWindowDelegate = delegate
    webview.uiDelegate = delegate
  }

  //
  // Commands
  //

  @objc public func startCapture(_ invoke: Invoke) throws {
    DispatchQueue.main.async {
      guard CLLocationManager.authorizationStatus() == .authorizedWhenInUse
        || CLLocationManager.authorizationStatus() == .authorizedAlways
      else {
        invoke.reject("location permission not granted")
        return
      }

      self.locationManager.desiredAccuracy = kCLLocationAccuracyBest
      self.locationManager.distanceFilter = kCLDistanceFilterNone
      self.locationManager.activityType = .airborne
      self.locationManager.pausesLocationUpdatesAutomatically = false
      self.locationManager.allowsBackgroundLocationUpdates = true
      self.locationManager.showsBackgroundLocationIndicator = true
      self.locationManager.startUpdatingLocation()
      // The screen stays awake while capture runs (the pilot may still
      // lock manually; background location keeps recording). Process-level,
      // so a webview death cannot let the screen sleep mid-flight.
      UIApplication.shared.isIdleTimerDisabled = true
      invoke.resolve()
    }
  }

  // One-shot location for the map's Center-on-me, independent of capture:
  // requestLocation() delivers a single fix (or one failure) to the
  // delegate, which resolves/rejects the pending invoke below.
  @objc public func currentPosition(_ invoke: Invoke) throws {
    DispatchQueue.main.async {
      let status = CLLocationManager.authorizationStatus()
      guard status == .authorizedWhenInUse || status == .authorizedAlways else {
        invoke.reject("location permission not granted")
        return
      }
      self.positionRequests.append(invoke)
      self.locationManager.requestLocation()
    }
  }

  @objc public func stopCapture(_ invoke: Invoke) throws {
    DispatchQueue.main.async {
      self.locationManager.stopUpdatingLocation()
      UIApplication.shared.isIdleTimerDisabled = false
      self.buffer = []
      self.lastTimestamp = 0
      self.lastError = nil
      invoke.resolve()
    }
  }

  // Return-and-clear. Called by the Rust ingest loop at 1 Hz.
  @objc public func drain(_ invoke: Invoke) throws {
    DispatchQueue.main.async {
      var ret: JsonObject = ["fixes": self.buffer]
      if let error = self.lastError {
        ret["error"] = error
      }
      self.buffer = []
      invoke.resolve(ret)
    }
  }

  @objc public func speak(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(SpeakArgs.self)
    DispatchQueue.main.async {
      // Duck the pilot's music for the utterance; deactivating with
      // notification lets it swell back afterward.
      let session = AVAudioSession.sharedInstance()
      try? session.setCategory(.playback, options: [.duckOthers])
      try? session.setActive(true)

      let utterance = AVSpeechUtterance(string: args.text)
      self.speechSynthesizer.speak(utterance)
      invoke.resolve()
    }
  }

  // WKWebView has no download manager, so an anchor-download is a silent
  // no-op — exports leave the app through the system share sheet instead.
  @objc public func shareFile(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ShareFileArgs.self)
    DispatchQueue.main.async {
      do {
        let name = args.name.replacingOccurrences(of: "/", with: "-")
        let url = FileManager.default.temporaryDirectory
          .appendingPathComponent(name)
        try args.content.write(to: url, atomically: true, encoding: .utf8)
        guard
          let root = UIApplication.shared.connectedScenes
            .compactMap({ ($0 as? UIWindowScene)?.keyWindow })
            .first?.rootViewController
        else {
          invoke.reject("no view controller to present from")
          return
        }
        let activity = UIActivityViewController(
          activityItems: [url], applicationActivities: nil)
        // iPad requires a popover anchor; centering matches the dialogs.
        UIUtils.centerPopover(
          rootViewController: root, popoverController: activity)
        root.present(activity, animated: true) { invoke.resolve() }
      } catch {
        invoke.reject(error.localizedDescription)
      }
    }
  }

  @objc override public func checkPermissions(_ invoke: Invoke) {
    DispatchQueue.main.async {
      invoke.resolve(["location": self.authorizationString()])
    }
  }

  @objc override public func requestPermissions(_ invoke: Invoke) {
    DispatchQueue.main.async {
      guard CLLocationManager.locationServicesEnabled() else {
        invoke.reject("Location services are not enabled.")
        return
      }
      if CLLocationManager.authorizationStatus() == .notDetermined {
        self.permissionRequests.append(invoke)
        self.locationManager.requestWhenInUseAuthorization()
      } else {
        invoke.resolve(["location": self.authorizationString()])
      }
    }
  }

  //
  // CLLocationManagerDelegate
  //

  public func locationManager(
    _ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]
  ) {
    lastError = nil
    for location in locations {
      guard location.horizontalAccuracy >= 0 else { continue }
      let fix = convertLocation(location)
      let ts = fix["timestamp"] as! Int64
      // CoreLocation can redeliver a cached fix on watch restart.
      if ts <= lastTimestamp { continue }
      lastTimestamp = ts
      buffer.append(fix)
    }
    // Resolve any one-shot currentPosition requests with the freshest valid
    // fix (independent of the capture dedup above).
    if !positionRequests.isEmpty,
      let location = locations.last(where: { $0.horizontalAccuracy >= 0 })
    {
      let requests = positionRequests
      positionRequests = []
      let fix = convertLocation(location)
      for request in requests { request.resolve(fix) }
    }
  }

  public func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
    // requestLocation() delivers exactly one result, so a one-shot request
    // must be rejected on failure (even a transient one) or its JS promise
    // hangs forever.
    if !positionRequests.isEmpty {
      let requests = positionRequests
      positionRequests = []
      for request in requests { request.reject(error.localizedDescription) }
    }
    if let clError = error as? CLError, clError.code == .locationUnknown {
      // Transient: CoreLocation keeps trying, updates resume on their own.
      return
    }
    Logger.error(error)
    lastError = error.localizedDescription
  }

  public func locationManager(
    _ manager: CLLocationManager, didChangeAuthorization status: CLAuthorizationStatus
  ) {
    let requests = permissionRequests
    permissionRequests = []
    for request in requests {
      request.resolve(["location": authorizationString()])
    }
    if status == .denied || status == .restricted {
      lastError = "location permission denied"
    }
  }

  //
  // Helpers
  //

  private func authorizationString() -> String {
    switch CLLocationManager.authorizationStatus() {
    case .notDetermined:
      return "prompt"
    case .restricted, .denied:
      return "denied"
    case .authorizedAlways, .authorizedWhenInUse:
      return "granted"
    @unknown default:
      return "prompt"
    }
  }

  // CoreLocation reports invalid values as negatives — normalize to
  // absent keys (Rust Option::None) at the source so the accuracy gate
  // upstream never sees a passable -1.
  private func convertLocation(_ location: CLLocation) -> JsonObject {
    var fix: JsonObject = [:]
    fix["timestamp"] = Int64(location.timestamp.timeIntervalSince1970 * 1000)
    fix["latitude"] = location.coordinate.latitude
    fix["longitude"] = location.coordinate.longitude
    fix["horizontalAccuracy"] = location.horizontalAccuracy
    if location.verticalAccuracy > 0 {
      fix["altitude"] = location.altitude
      fix["verticalAccuracy"] = location.verticalAccuracy
    }
    if location.speed >= 0 {
      fix["speed"] = location.speed
    }
    if location.course >= 0 {
      fix["course"] = location.course
    }
    return fix
  }

  //
  // Keychain
  //
  // A dumb key/value shim, like everything else here. The sync credential is
  // derived server-side, cannot be reset by the pilot, and grants remote
  // read/write to the whole account — a bigger blast radius than the flights an
  // app-container compromise already exposes. IndexedDB would also ride along
  // into iCloud and iTunes backups; a Keychain item written ThisDeviceOnly
  // never leaves the device at all. That costs nothing, because the credential
  // is re-derivable from a StoreKit transaction on any device with the Apple
  // Account — so it never needs backing up.

  private func keychainQuery(_ key: String) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "app.wingover.wingover.sync",
      kSecAttrAccount as String: key,
    ]
  }

  @objc public func keychainAvailable(_ invoke: Invoke) throws {
    invoke.resolve(["available": true])
  }

  @objc public func keychainGet(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(KeychainGetArgs.self)
    var query = keychainQuery(args.key)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne

    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    switch status {
    case errSecSuccess:
      guard let data = item as? Data, let value = String(data: data, encoding: .utf8) else {
        invoke.reject("keychain item is not readable utf8")
        return
      }
      invoke.resolve(["value": value])
    case errSecItemNotFound:
      invoke.resolve(["value": nil])
    default:
      invoke.reject("keychain read failed: \(status)")
    }
  }

  @objc public func keychainSet(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(KeychainSetArgs.self)
    // Delete-then-add rather than update: an add over an existing item fails
    // with errSecDuplicateItem, and this must be idempotent — every session
    // rewrites the credential.
    SecItemDelete(keychainQuery(args.key) as CFDictionary)

    var query = keychainQuery(args.key)
    query[kSecValueData as String] = Data(args.value.utf8)
    // AfterFirstUnlock so a relaunch after reboot can still sync; ThisDeviceOnly
    // so it is never in a backup or iCloud Keychain.
    query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly

    let status = SecItemAdd(query as CFDictionary, nil)
    guard status == errSecSuccess else {
      invoke.reject("keychain write failed: \(status)")
      return
    }
    invoke.resolve()
  }

  @objc public func keychainDelete(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(KeychainGetArgs.self)
    let status = SecItemDelete(keychainQuery(args.key) as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      invoke.reject("keychain delete failed: \(status)")
      return
    }
    invoke.resolve()
  }

  //
  // StoreKit
  //
  // Returns the raw signed transaction (jwsRepresentation) verbatim and decides
  // nothing. The server verifies it against Apple's root CAs and is the only
  // authority on entitlement — so an unverified result is still handed over
  // rather than filtered here, because this shim's opinion doesn't count.

  @objc public func storekitProducts(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ProductsArgs.self)
    Task {
      do {
        let products = try await Product.products(for: args.productIds)
        let payload: [JsonObject] = products.map { product in
          [
            "id": product.id,
            "displayName": product.displayName,
            // Apple's own localized price string — never format this ourselves.
            "displayPrice": product.displayPrice,
            "description": product.description,
          ]
        }
        invoke.resolve(["products": payload])
      } catch {
        invoke.reject(error.localizedDescription)
      }
    }
  }

  // How a second device joins and how a reinstall recovers: same Apple Account,
  // same transaction, same account. There is no "restore" button because there
  // is nothing to restore — StoreKit already knows.
  //
  // The fallback is the whole reason this isn't three lines. `currentEntitlements`
  // emits NOTHING for an expired subscription, and a lapsed pilot on a new phone
  // has an empty Keychain by design — so with only that channel, the one door
  // into their own logbook is locked, and the only key on offer is to subscribe
  // again. STEERING: "A lapsed subscription is read-only, never locked out:
  // every flight stays readable, pullable to a new phone, and exportable." The
  // server already honours that (it returns working read-only credentials for a
  // lapsed transaction); it just never gets asked.
  //
  // Transaction.all keeps expired ones. Filter to our subscription and take the
  // NEWEST: `all` also carries every prior renewal, and handing the server a
  // stale transaction would let its monotonic expiresAt write regress a live
  // entitlement. Verification stays the server's job either way — we are the
  // courier, and a courier that drops the letter is worse than one who carries
  // a bad one.
  @objc public func storekitCurrentEntitlement(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(EntitlementArgs.self)
    Task {
      for await result in Transaction.currentEntitlements {
        invoke.resolve(["jws": result.jwsRepresentation])
        return
      }

      var newestJws: String?
      var newestDate = Date.distantPast
      for await result in Transaction.all {
        // Take the payload whether or not it verified: reading a field to sort
        // by is not trusting it, and the server throws out anything whose
        // signature is bad. Pattern-matched rather than .unsafePayloadValue so
        // there is no availability question to get wrong — this file cannot be
        // compiled anywhere but a Mac.
        let transaction: Transaction
        switch result {
        case .verified(let value): transaction = value
        case .unverified(let value, _): transaction = value
        }
        guard args.productIds.contains(transaction.productID) else { continue }
        let stamp = transaction.expirationDate ?? transaction.purchaseDate
        if stamp > newestDate {
          newestDate = stamp
          newestJws = result.jwsRepresentation
        }
      }
      invoke.resolve(["jws": newestJws])
    }
  }

  @objc public func storekitPurchase(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(PurchaseArgs.self)
    Task {
      do {
        guard let product = try await Product.products(for: [args.productId]).first else {
          invoke.reject("no such product: \(args.productId)")
          return
        }
        switch try await product.purchase() {
        case .success(let verification):
          invoke.resolve(["jws": verification.jwsRepresentation])
          // Finish only after handing the JWS over. If the server call then
          // fails, currentEntitlements still returns this transaction, so the
          // next session recovers — nothing is stranded.
          if case .verified(let transaction) = verification {
            await transaction.finish()
          }
        case .userCancelled:
          invoke.reject("cancelled")
        case .pending:
          // Ask to Buy, or SCA. The webhook will land when it resolves.
          invoke.reject("pending")
        @unknown default:
          invoke.reject("unknown purchase result")
        }
      } catch {
        invoke.reject(error.localizedDescription)
      }
    }
  }

  // The StoreKit environment this build runs in — Sandbox for TestFlight,
  // Production for the App Store — from the app's own AppTransaction receipt.
  // Available locally with no subscription and offline, which is the point: the
  // client uses it to refuse replicating credentials minted in the OTHER
  // environment (a TestFlight build over an App Store install, or the reverse)
  // into the wrong account. Pattern-matched like the Transaction reads above —
  // reading .environment isn't trusting the signature. See sync/index.ts.
  @objc public func storekitEnvironment(_ invoke: Invoke) {
    Task {
      do {
        let appTransaction: AppTransaction
        switch try await AppTransaction.shared {
        case .verified(let value): appTransaction = value
        case .unverified(let value, _): appTransaction = value
        }
        invoke.resolve(["environment": appTransaction.environment.rawValue])
      } catch {
        invoke.reject(error.localizedDescription)
      }
    }
  }

  // Apple's own subscription-management sheet, for the CURRENT storefront.
  // This is the difference between "my subscription is missing" and seeing
  // it: the public apps.apple.com page never lists sandbox/TestFlight
  // subscriptions, but this sheet does.
  @objc public func storekitManageSubscriptions(_ invoke: Invoke) throws {
    Task { @MainActor in
      guard
        let scene = UIApplication.shared.connectedScenes
          .compactMap({ $0 as? UIWindowScene })
          .first
      else {
        invoke.reject("no active scene to present from")
        return
      }
      do {
        try await AppStore.showManageSubscriptions(in: scene)
        invoke.resolve()
      } catch {
        invoke.reject(error.localizedDescription)
      }
    }
  }

  //
  // Sign in with Apple
  //
  // No scopes requested: the server derives the account from the token's
  // stable subject, and a name or email would only be data we then have to
  // protect. Requires the applesignin entitlement (wingover_iOS.entitlements)
  // and the capability on the App ID in the developer portal.

  @objc public func signInWithApple(_ invoke: Invoke) throws {
    DispatchQueue.main.async {
      let request = ASAuthorizationAppleIDProvider().createRequest()
      let controller = ASAuthorizationController(authorizationRequests: [request])
      let delegate = SiwaDelegate(invoke: invoke) { [weak self] in self?.siwa = nil }
      self.siwa = delegate
      controller.delegate = delegate
      controller.presentationContextProvider = delegate
      controller.performRequests()
    }
  }
}

@_cdecl("init_plugin_wingover")
func initPlugin() -> Plugin {
  return WingoverPlugin()
}
