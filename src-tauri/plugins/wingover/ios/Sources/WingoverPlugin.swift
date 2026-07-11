import AVFoundation
import CoreLocation
import Foundation
import Tauri
import UIKit

class SpeakArgs: Decodable {
  let text: String
}

class ShareFileArgs: Decodable {
  let name: String
  let content: String
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
  private var lastError: String?

  // In-memory buffer between drains (~1 s of fixes). Mutated on the main
  // thread only. A hard process kill loses only this window — the accepted
  // torn-tail class; everything drained is already durable in Rust.
  private var buffer: [JsonObject] = []
  private var lastTimestamp: Int64 = 0

  override init() {
    super.init()
    locationManager.delegate = self
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
  }

  public func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
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
}

@_cdecl("init_plugin_wingover")
func initPlugin() -> Plugin {
  return WingoverPlugin()
}
