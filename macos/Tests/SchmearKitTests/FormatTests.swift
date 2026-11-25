import Foundation
import Testing
@testable import SchmearKit

@Suite struct FormatTests {
    let now = Date(timeIntervalSince1970: 1_700_000_000)
    func ms(_ secondsFromNow: Double) -> Double { (now.timeIntervalSince1970 + secondsFromNow) * 1000 }

    @Test func relativeTimes() {
        #expect(Format.relative(ms(-180), now: now) == "3m ago")
        #expect(Format.relative(ms(-10), now: now) == "just now")
        #expect(Format.relative(ms(-7200), now: now) == "2h ago")
        #expect(Format.relative(ms(2 * 86400 + 3 * 3600), now: now) == "in 2d 3h")
        #expect(Format.relative(ms(5400), now: now) == "in 1h 30m")
        #expect(Format.relative(ms(0), now: now) == "now")
        #expect(Format.relative(ms(59), now: now) == "now")
        #expect(Format.relative(ms(-59), now: now) == "just now")
        #expect(Format.relative(ms(61), now: now) == "in 1m")
        #expect(Format.relative(ms(-61), now: now) == "1m ago")
    }

    @Test func windowLines() {
        let w = Snapshot.Window(kind: "period", remaining: 0.37, resetsAt: ms(2 * 86400 + 3 * 3600), periodHours: 168)
        #expect(Format.windowLine(w, now: now) == "7d · 37% left · resets in 2d 3h")
        let short = Snapshot.Window(kind: "short", remaining: 0.5, resetsAt: nil, periodHours: 5)
        #expect(Format.windowLine(short, now: now) == "5h · 50% left · resets —")
        let past = Snapshot.Window(kind: "short", remaining: 1, resetsAt: ms(-180), periodHours: 5)
        #expect(Format.windowLine(past, now: now) == "5h · 100% left · resets 3m ago")
        var projected = w
        projected.projectedUnused = 0.124
        #expect(Format.windowLine(projected, now: now) == "7d · 37% left · resets in 2d 3h · ~12% unused")
        projected.projectedUnused = 0.004
        #expect(Format.windowLine(projected, now: now) == "7d · 37% left · resets in 2d 3h")
        projected.projectedUnused = 0
        #expect(Format.windowLine(projected, now: now) == "7d · 37% left · resets in 2d 3h")
    }

    @Test func creditLines() throws {
        let pools = try Snapshot.decode(fixture("snapshot-credits")).readings.flatMap(\.pools)
        #expect(Format.creditLine(pools[0]) == nil)
        #expect(Format.creditLine(pools[1]) == "$4.20 of $5 left · expires Nov 20")
        #expect(Format.creditLine(pools[2]) == "$300 of $300 left")
        var overdrawn = pools[2]
        overdrawn.usd = Snapshot.Usd(left: -0.5, granted: 12.345)
        #expect(Format.creditLine(overdrawn) == "$0 of $12.35 left")
    }

    @Test func creditTitlesAndDetails() throws {
        let pools = try Snapshot.decode(fixture("snapshot-credits")).readings.flatMap(\.pools)
        #expect(Format.creditTitle(pools[1]) == "Acme")
        #expect(Format.creditTitle(pools[2]) == "billing 01AB23-CD45EF-678901")
        #expect(Format.creditTitle(pools[0]) == "API credits")
        #expect(
            Format.creditDetail(pools[1], login: "claude@default")
                == "$3 grant + $1.20 purchased · $0.80 spent this month · runs under claude@default"
        )
        #expect(Format.creditDetail(pools[1], login: nil) == "$3 grant + $1.20 purchased · $0.80 spent this month")
        var partial = pools[1]
        partial.usd = Snapshot.Usd(left: 4.2, granted: 5, purchased: 1.2)
        #expect(Format.creditDetail(partial, login: nil) == "$1.20 purchased")
        #expect(Format.creditDetail(pools[2], login: nil) == nil)
        #expect(Format.creditDetail(pools[2], login: "agy@default") == "runs under agy@default")
    }

    @Test func pace() {
        #expect(Format.pace(1.4249) == "1.42")
        #expect(Format.pace(nil) == "—")
    }

    @Test func taskElapsed() throws {
        let tasks = try Snapshot.decode(fixture("snapshot")).tasks
        #expect(Format.elapsed(tasks[0], now: now) == "running 4m")
        #expect(Format.elapsed(tasks[1], now: now) == "done 12m ago")
        #expect(Format.elapsed(tasks[2], now: now) == "lost 2h 46m ago")
        var noQuota = tasks[1]
        noQuota.status = "no_quota"
        #expect(Format.elapsed(noQuota, now: now) == "no quota 12m ago")
    }

    @Test func cost() {
        #expect(Format.cost(0.0123) == "$0.0123")
        #expect(Format.cost(0) == "$0.0000")
    }
}
