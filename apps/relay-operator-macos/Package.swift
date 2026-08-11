// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "OracleRelayOperator",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "OracleRelayOperator", targets: ["OracleRelayOperator"]),
    ],
    targets: [
        .executableTarget(
            name: "OracleRelayOperator",
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("UserNotifications"),
            ]
        ),
    ]
)
