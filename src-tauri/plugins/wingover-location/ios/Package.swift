// swift-tools-version:5.9

import PackageDescription

let package = Package(
  name: "wingover-location",
  platforms: [
    .macOS(.v10_15),
    .iOS(.v16),
  ],
  products: [
    .library(
      name: "wingover-location",
      type: .static,
      targets: ["wingover-location"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    .target(
      name: "wingover-location",
      dependencies: [
        .byName(name: "Tauri")
      ],
      path: "Sources")
  ]
)
