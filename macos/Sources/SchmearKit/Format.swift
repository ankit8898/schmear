import Foundation

/// Pure display strings. Epoch-ms inputs; `now` is injected so the output is testable.
public enum Format {
    static func duration(_ seconds: Double) -> String {
        let minutes = Int(seconds / 60)
        if minutes < 1 { return "<1m" }
        if minutes < 60 { return "\(minutes)m" }
        let hours = minutes / 60
        if hours < 24 {
            let m = minutes % 60
            return m == 0 ? "\(hours)h" : "\(hours)h \(m)m"
        }
        let h = hours % 24
        return h == 0 ? "\(hours / 24)d" : "\(hours / 24)d \(h)h"
    }

    /// "3m ago", "in 2d 3h".
    public static func relative(_ epochMs: Double, now: Date) -> String {
        let delta = epochMs / 1000 - now.timeIntervalSince1970
        if delta >= 0 { return delta < 60 ? "now" : "in \(duration(delta))" }
        return -delta < 60 ? "just now" : "\(duration(-delta)) ago"
    }

    public static func windowLabel(_ w: Snapshot.Window) -> String {
        let h = Int(w.periodHours.rounded())
        return h < 24 || h % 24 != 0 ? "\(h)h" : "\(h / 24)d"
    }

    /// "7d · 37% left · resets in 2d 3h · ~12% unused"
    public static func windowLine(_ w: Snapshot.Window, now: Date) -> String {
        let resets = w.resetsAt.map { "resets " + relative($0, now: now) } ?? "resets —"
        var unused = ""
        if let p = w.projectedUnused, p >= 0.005 { unused = " · ~\(Int((p * 100).rounded()))% unused" }
        return "\(windowLabel(w)) · \(Int((w.remaining * 100).rounded()))% left · \(resets)\(unused)"
    }

    private static let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

    static func dollars(_ usd: Double) -> String {
        let cents = (usd * 100).rounded()
        return cents.truncatingRemainder(dividingBy: 100) == 0 ? "$\(Int(cents / 100))" : String(format: "$%.2f", cents / 100)
    }

    /// "$4.20 of $5 left · $3 expires Nov 20" (no amount when all of it expires, no "of $5" when nothing is granted);
    /// nil for a pool with no balance.
    public static func creditLine(_ pool: Snapshot.Pool) -> String? {
        guard let usd = pool.usd else { return nil }
        let amount = usd.expiring.flatMap { usd.left - $0 >= 0.005 ? "\(dollars($0)) " : nil } ?? ""
        let expires = pool.windows.first?.resetsAt.map { ms in
            let d = Calendar.current.dateComponents([.month, .day], from: Date(timeIntervalSince1970: ms / 1000))
            return " · \(amount)expires \(months[d.month! - 1]) \(d.day!)"
        } ?? ""
        let of = usd.granted > 0 ? " of \(dollars(usd.granted))" : ""
        return "\(dollars(max(0, usd.left)))\(of) left\(expires)"
    }

    /// "Acme · $3 grant + $1.20 purchased · $0.80 spent this month" (Google: "billing <account id>"), omitting unknown parts; nil when all are.
    public static func creditDetail(_ pool: Snapshot.Pool) -> String? {
        let split = [pool.usd?.grant.map { "\(dollars($0)) grant" }, pool.usd?.purchased.map { "\(dollars($0)) purchased" }]
            .compactMap { $0 }.joined(separator: " + ")
        let parts = [
            pool.name.map { pool.id.hasPrefix("gemini-credits@") ? "billing \($0)" : $0 },
            split.isEmpty ? nil : split,
            pool.usd?.spentMonth.map { "\(dollars($0)) spent this month" },
        ].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    public static func pace(_ pace: Double?) -> String {
        pace.map { String(format: "%.2f", $0) } ?? "—"
    }

    /// "running 4m", "done 12m ago".
    public static func elapsed(_ task: Snapshot.Task, now: Date) -> String {
        if task.status == "running" {
            return "running " + duration(now.timeIntervalSince1970 - task.startedAt / 1000)
        }
        let word = task.status.replacingOccurrences(of: "_", with: " ")
        return "\(word) \(relative(task.endedAt ?? task.startedAt, now: now))"
    }

    public static func cost(_ usd: Double) -> String {
        String(format: "$%.4f", usd)
    }
}
