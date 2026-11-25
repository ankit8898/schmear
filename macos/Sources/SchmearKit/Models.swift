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

/// The oldest `schmear` this app works with: 0.4.0 added `maxTasks` to `schmear tiers` and `hosts` to the snapshot.
public enum CLIVersion {
    public static let minimum = "0.4.0"
    public static let upgradeCommands = [
        (title: "Upgrade with Homebrew", command: "brew upgrade schmear && schmear init --yes"),
    ]

    private static func parts(_ version: String) -> [Int]? {
        let fields = version.prefix { $0 != "-" && $0 != "+" }.split(separator: ".", omittingEmptySubsequences: false)
        let numbers = fields.compactMap { Int($0) }
        return fields.count == 3 && numbers.count == 3 ? numbers : nil
    }

    /// A CLI before 0.4.0 reports no version. A pre-release suffix is ignored; an unreadable version counts as too old.
    public static func isTooOld(_ version: String?) -> Bool {
        guard let version, let found = parts(version) else { return true }
        return found.lexicographicallyPrecedes(parts(minimum)!)
    }

    /// The popover's message in place of normal content, or nil when the CLI is new enough.
    public static func notice(for version: String?) -> String? {
        guard isTooOld(version) else { return nil }
        return "schmear \(version ?? "older than \(minimum)") is too old for this app; it needs \(minimum) or later."
    }
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

    /// `expiring`: what of `left` expires at the window's reset, absent when undated. `grant` and `purchased` split what
    /// is left; each is absent when the vendor does not report it.
    public struct Usd: Codable, Sendable, Equatable {
        public var left: Double
        public var granted: Double
        public var expiring: Double?
        public var grant: Double?
        public var purchased: Double?
        public var spentMonth: Double?
    }

    public struct Pool: Codable, Sendable, Equatable {
        public var id: String
        public var models: [String]?
        /// A credit pool's Console org name or Google billing account id.
        public var name: String?
        public var windows: [Window]
        /// Set on a credit pool only.
        public var usd: Usd?
        public var pace: Double?
        public var status: String?
    }

    public struct Reading: Codable, Sendable, Equatable {
        public var id: String
        public var skipped: String?
        public var source: String?
        /// The login a credit reading's pools run under.
        public var login: String?
        public var fetchedAt: Double?
        public var warnings: [String]
        public var pools: [Pool]
    }

    /// A subscription reading with the credit readings its account owns, or (`reading` nil) a credit reading no reading owns.
    public struct Account: Sendable, Equatable, Identifiable {
        public var title: String
        public var reading: Reading?
        public var credits: [Reading]

        public var id: String { reading?.id ?? credits[0].id }
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

    public struct Notice: Codable, Sendable, Equatable {
        public var id: String
        public var title: String
        public var body: String
    }

    public struct Host: Codable, Sendable, Equatable, Identifiable {
        public var id: String
        public var status: String

        public var displayName: String {
            switch id {
            case "claude": "Claude Code"
            case "codex": "Codex"
            case "grok": "Grok"
            case "opencode": "OpenCode"
            case "agy": "Antigravity"
            default: id
            }
        }
    }

    public var version: Int
    public var cliVersion: String?
    public var at: Double
    public var driver: String?
    public var hosts: [Host]?
    public var readings: [Reading]
    public var next: [Next]
    public var notOffered: [String]
    /// Absent from a CLI before 0.5.0.
    public var notices: [Notice]?
    public var tasks: [Task]

    public var unhealthyHosts: [Host] {
        (hosts ?? []).filter { $0.status != "ok" }
    }

    public var cliNotice: String? { CLIVersion.notice(for: cliVersion) }

    private static let creditAgents = ["claude-credits": "claude", "gemini-credits": "agy"]

    /// Credit pool `<key>@<n>` belongs to the account `<agent of key>@<n>`; nil for an id that names no credit pool.
    static func creditOwner(_ id: String) -> (account: String, name: String)? {
        guard let at = id.lastIndex(of: "@"), let agent = creditAgents[String(id[..<at])] else { return nil }
        let name = String(id[id.index(after: at)...])
        return ("\(agent)@\(name)", name)
    }

    /// The readings as the popover lists them: each credit reading nested under its owner's reading when present, else after all of them as `<n> · API credits only · runs under <login>`.
    public var accounts: [Account] {
        let owners = readings.map { Snapshot.creditOwner($0.id) }
        var accounts = zip(readings, owners).filter { $1 == nil }.map { Account(title: $0.0.id, reading: $0.0, credits: []) }
        for (credit, owner) in zip(readings, owners) {
            guard let owner else { continue }
            if let i = accounts.firstIndex(where: { $0.reading?.id == owner.account }) {
                accounts[i].credits.append(credit)
            } else {
                let login = credit.login.map { " · runs under \($0)" } ?? ""
                accounts.append(Account(title: "\(owner.name) · API credits only\(login)", reading: nil, credits: [credit]))
            }
        }
        return accounts
    }

    public var needsAttention: Bool {
        cliNotice != nil || !unhealthyHosts.isEmpty || !readings.contains { !$0.pools.isEmpty }
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
