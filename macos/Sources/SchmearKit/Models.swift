import Foundation

public enum SchmearError: Error, LocalizedError, Equatable {
    case unsupportedVersion(Int)
    case command(String)
    case notInstalled

    public var errorDescription: String? {
        switch self {
        case .unsupportedVersion(let v):
            "schmear returned data version \(v), which this app does not understand. Update the app or schmear."
        case .command(let stderr): stderr
        case .notInstalled: "schmear is not installed."
        }
    }
}

private struct VersionProbe: Decodable { let version: Int }

private func decodeVersioned<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
    let decoder = JSONDecoder()
    let version = try decoder.decode(VersionProbe.self, from: data).version
    guard version == 1 else { throw SchmearError.unsupportedVersion(version) }
    return try decoder.decode(type, from: data)
}

/// `schmear usage --json`. Times are epoch milliseconds.
public struct Snapshot: Codable, Sendable, Equatable {
    public struct Window: Codable, Sendable, Equatable {
        public var kind: String
        public var remaining: Double
        public var resetsAt: Double?
        public var periodHours: Double
        public var projectedUnused: Double?
    }

    public struct Pool: Codable, Sendable, Equatable {
        public var id: String
        public var models: [String]?
        public var windows: [Window]
        public var pace: Double?
        public var status: String?
    }

    public struct Reading: Codable, Sendable, Equatable {
        public var id: String
        public var skipped: String?
        public var source: String?
        public var fetchedAt: Double?
        public var warnings: [String]
        public var pools: [Pool]
    }

    public struct Next: Codable, Sendable, Equatable {
        public var tier: Int
        public var lane: String?
        public var effort: String?
    }

    public struct Task: Codable, Sendable, Equatable, Identifiable {
        public var id: String
        public var driver: String?
        public var description: String
        public var tier: Int
        public var cwd: String
        public var lane: String?
        public var effort: String?
        public var status: String
        public var costUsd: Double?
        public var startedAt: Double
        public var endedAt: Double?
    }

    public var version: Int
    public var at: Double
    public var driver: String?
    public var readings: [Reading]
    public var next: [Next]
    public var notOffered: [String]
    public var tasks: [Task]

    public static func decode(_ data: Data) throws -> Snapshot {
        try decodeVersioned(Snapshot.self, from: data)
    }
}

/// `schmear tiers`. Tier entries are `"key:model@effort"` strings.
public struct TiersDoc: Codable, Sendable, Equatable {
    public var version: Int
    public var source: String
    public var tiers: [[String]]
    public var defaults: [[String]]
    public var laneKeys: [String]
    public var offered: [String: [String]]

    public static func decode(_ data: Data) throws -> TiersDoc {
        try decodeVersioned(TiersDoc.self, from: data)
    }
}
