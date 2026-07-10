import CoreLocation
import Foundation
import Tauri
import UIKit

class FixesSinceArgs: Decodable {
  let ts: Int64
}

// Native capture + durable buffer. All flight semantics live in JS; this
// plugin only guarantees no fix captured while the app process lives is
// lost to a webview reload, and fixes survive an app crash via the JSONL
// session file (torn tail = a couple of points, accepted by design).
class WingoverLocationPlugin: Plugin, CLLocationManagerDelegate {
  private let locationManager = CLLocationManager()
  private var watching = false
  private var permissionRequests: [Invoke] = []
  private var lastError: String?

  // Session buffer: JSON-ready fix dicts plus parallel timestamps for
  // cheap cursor filtering. Mutated on the main thread only.
  private var fixes: [JsonObject] = []
  private var timestamps: [Int64] = []
  private var fileHandle: FileHandle?

  override init() {
    super.init()
    locationManager.delegate = self
  }

  private var sessionFileURL: URL {
    let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("wingover-location", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir.appendingPathComponent("session.jsonl")
  }

  //
  // Commands
  //

  @objc public func startWatch(_ invoke: Invoke) throws {
    DispatchQueue.main.async {
      guard CLLocationManager.authorizationStatus() == .authorizedWhenInUse
        || CLLocationManager.authorizationStatus() == .authorizedAlways
      else {
        invoke.reject("location permission not granted")
        return
      }

      self.hydrateFromFileIfNeeded()

      self.locationManager.desiredAccuracy = kCLLocationAccuracyBest
      self.locationManager.distanceFilter = kCLDistanceFilterNone
      self.locationManager.activityType = .airborne
      self.locationManager.pausesLocationUpdatesAutomatically = false
      self.locationManager.allowsBackgroundLocationUpdates = true
      self.locationManager.showsBackgroundLocationIndicator = true
      self.locationManager.startUpdatingLocation()
      self.watching = true
      invoke.resolve()
    }
  }

  @objc public func fixesSince(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(FixesSinceArgs.self)
    DispatchQueue.main.async {
      // timestamps is sorted (CoreLocation delivers in order; hydrate
      // preserves file order) — binary-search the cursor.
      var lo = 0
      var hi = self.timestamps.count
      while lo < hi {
        let mid = (lo + hi) / 2
        if self.timestamps[mid] <= args.ts { lo = mid + 1 } else { hi = mid }
      }
      var ret: JsonObject = ["fixes": Array(self.fixes[lo...])]
      if let error = self.lastError {
        ret["error"] = error
      }
      invoke.resolve(ret)
    }
  }

  @objc public func stopWatch(_ invoke: Invoke) throws {
    DispatchQueue.main.async {
      self.locationManager.stopUpdatingLocation()
      self.watching = false
      self.fixes = []
      self.timestamps = []
      self.lastError = nil
      try? self.fileHandle?.close()
      self.fileHandle = nil
      try? FileManager.default.removeItem(at: self.sessionFileURL)
      invoke.resolve()
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
      if let last = timestamps.last, ts <= last { continue }
      fixes.append(fix)
      timestamps.append(ts)
      appendToFile(fix)
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
  // absent keys (JS null) at the source so the accuracy gate upstream
  // never sees a passable -1.
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

  private func appendToFile(_ fix: JsonObject) {
    guard let data = try? JSONSerialization.data(withJSONObject: fix) else { return }
    if fileHandle == nil {
      let url = sessionFileURL
      if !FileManager.default.fileExists(atPath: url.path) {
        FileManager.default.createFile(atPath: url.path, contents: nil)
      }
      fileHandle = try? FileHandle(forWritingTo: url)
      _ = try? fileHandle?.seekToEnd()
    }
    // Best-effort: a torn final line on hard crash loses a couple of
    // points, which is within the accepted loss budget.
    try? fileHandle?.write(contentsOf: data + Data("\n".utf8))
  }

  private func hydrateFromFileIfNeeded() {
    guard fixes.isEmpty, fileHandle == nil,
      let data = try? Data(contentsOf: sessionFileURL)
    else { return }
    for line in data.split(separator: UInt8(ascii: "\n")) {
      guard
        let fix = (try? JSONSerialization.jsonObject(with: Data(line))) as? JsonObject,
        let ts = fixTimestamp(fix)
      else { continue }  // torn tail line
      if let last = timestamps.last, ts <= last { continue }
      fixes.append(fix)
      timestamps.append(ts)
    }
  }

  private func fixTimestamp(_ fix: JsonObject) -> Int64? {
    if let n = fix["timestamp"] as? Int64 { return n }
    if let n = fix["timestamp"] as? NSNumber { return n.int64Value }
    return nil
  }
}

@_cdecl("init_plugin_wingover_location")
func initPlugin() -> Plugin {
  return WingoverLocationPlugin()
}
