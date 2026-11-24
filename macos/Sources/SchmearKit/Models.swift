import Foundation

public enum SchmearError: Error, LocalizedError, Equatable {
    case unsupportedVersion(Int)
    case command(String)
    case notInstalled
    case timedOut([String], TimeInterval)

    public var errorDescription: String? {
        switch self {
        case .unsupportedVersion(let v):
            return "schmear returned data version \(v), which this app does not understand. Update the app or schmear."
        case .command(let stderr):
            return stderr
        case .notInstalled:
            return "schmear is not installed."
        case .timedOut(let args, let seconds):
            let cmd = (["schmear"] + args).joined(separator: " ")
            let secs = seconds.rounded() == seconds ? "\(Int(seconds))" : "\(seconds)"
            return "\(cmd) timed out after \(secs) s"
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

    public struct Host: Codable, Sendable, Equatable, Identifiable {
        public var id: String
        public var status: String

        public var displayName: String {
            switch id {
            case "claude": "Claude Code"
            case "codex": "Codex"
            case "grok": "Grok"
            case "agy": "Antigravity"
            default: id
            }
        }
    }

    public var version: Int
    public var at: Double
    public var driver: String?
    public var hosts: [Host]?
    public var readings: [Reading]
    public var next: [Next]
    public var notOffered: [String]
    public var tasks: [Task]

    public var unhealthyHosts: [Host] {
        (hosts ?? []).filter { $0.status != "ok" }
    }

    public var needsAttention: Bool {
        !unhealthyHosts.isEmpty || !readings.contains { !$0.pools.isEmpty }
    }

    public static func needsAttention(installed: Bool, snapshot: Snapshot?) -> Bool {
        !installed || (snapshot?.needsAttention ?? false)
    }

    public static func reconnectedMessage(for hostNames: [String]) -> String {
        let target = hostNames.isEmpty ? "your agents" : hostNames.joined(separator: ", ")
        return "Reconnected. Restart \(target) to use schmear."
    }

    public static func decode(_ data: Data) throws -> Snapshot {
        try decodeVersioned(Snapshot.self, from: data)
    }
}

/// `schmear tiers`. Tier entries are `"key:model@effort"` strings.
public struct TiersDoc: Codable, Sendable, Equatable {
    public var version: Int
    public var source: String
    public var maxTasks: Int
    public var tiers: [[String]]
    public var defaults: [[String]]
    public var laneKeys: [String]
    public var offered: [String: [String]]

    public static func decode(_ data: Data) throws -> TiersDoc {
        try decodeVersioned(TiersDoc.self, from: data)
    }
}
