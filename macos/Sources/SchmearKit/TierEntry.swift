import Foundation

public struct TierEntry: Identifiable, Equatable, Sendable {
    public let id = UUID()
    public var key: String
    public var model: String
    public var effort: String

    /// `"key:model@effort"`; the key ends at the first `:`, the effort starts after the last `@`.
    public init(spec: String) {
        let colon = spec.firstIndex(of: ":") ?? spec.endIndex
        key = String(spec[..<colon])
        let rest = colon < spec.endIndex ? spec[spec.index(after: colon)...] : ""
        let at = rest.lastIndex(of: "@") ?? rest.endIndex
        model = String(rest[..<at])
        effort = at < rest.endIndex ? String(rest[rest.index(after: at)...]) : ""
    }

    public init(key: String) {
        self.key = key
        model = ""
        effort = ""
    }

    public var spec: String { "\(key):\(model)@\(effort)" }
    public var isComplete: Bool { ![key, model, effort].contains { $0.trimmingCharacters(in: .whitespaces).isEmpty } }
}
