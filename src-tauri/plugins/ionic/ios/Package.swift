// swift-tools-version:5.9

import PackageDescription

let package = Package(
  name: "tauri-plugin-ionic",
  platforms: [
    .macOS(.v10_15),
    .iOS(.v16),
  ],
  products: [
    .library(
      name: "tauri-plugin-ionic",
      type: .static,
      targets: ["tauri-plugin-ionic"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    .target(
      name: "tauri-plugin-ionic",
      dependencies: [
        .byName(name: "Tauri")
      ],
      path: "Sources")
  ]
)
