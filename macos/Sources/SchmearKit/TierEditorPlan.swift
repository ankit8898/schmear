import Foundation

/// What a tier-editor Save must run: only the parts that differ from the loaded doc, so an
/// untouched default list is never written into config.
public enum TierEditorPlan {
    public struct Step: Equatable, Sendable {
        public var args: [String]
        public var stdin: Data?

        public init(_ args: [String], stdin: Data? = nil) {
            self.args = args
            self.stdin = stdin
        }
    }

    public static func steps(loaded: TiersDoc, tiers: [[String]], maxTasks: Int) -> [Step] {
        var steps: [Step] = []
        if maxTasks != loaded.maxTasks {
            steps.append(Step(["max-tasks", String(maxTasks)]))
        }
        if tiers != loaded.tiers, let json = try? JSONEncoder().encode(tiers) {
            steps.append(Step(["tiers", "set"], stdin: json))
        }
        return steps
    }
}
