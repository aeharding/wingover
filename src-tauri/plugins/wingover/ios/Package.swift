// swift-tools-version:5.9

import PackageDescription

let package = Package(
  name: "tauri-plugin-wingover",
  platforms: [
    .macOS(.v10_15),
    .iOS(.v16),
  ],
  products: [
    .library(
      name: "tauri-plugin-wingover",
      type: .static,
      targets: ["tauri-plugin-wingover"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    .target(
      name: "tauri-plugin-wingover",
      dependencies: [
        .byName(name: "Tauri")
      ],
      path: "Sources")
  ]
)
