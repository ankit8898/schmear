// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "Schmear",
    platforms: [.macOS(.v14)],
    targets: [
        .target(name: "SchmearKit"),
        .executableTarget(name: "SchmearBar", dependencies: ["SchmearKit"]),
        .testTarget(
            name: "SchmearKitTests",
            dependencies: ["SchmearKit"],
            resources: [.copy("Fixtures")]
        ),
    ]
)
