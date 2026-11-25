import Foundation
import Testing
@testable import SchmearKit

func fixture(_ name: String) throws -> Data {
    let url = try #require(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures"))
    return try Data(contentsOf: url)
}

@Suite struct ModelsTests {
    @Test func decodesSnapshot() throws {
        let s = try Snapshot.decode(fixture("snapshot"))
        #expect(s.at == 1_700_000_000_000)
        #expect(s.driver == nil)
        #expect(s.readings.count == 2)
        #expect(s.readings[0].warnings == ["usage endpoint is undocumented"])
        #expect(s.readings[0].pools[0].pace == 1.42)
        #expect(s.readings[0].pools[0].windows[1].resetsAt == 1_700_184_800_000)
        #expect(s.readings[0].pools[1].pace == nil)
        #expect(s.readings[0].pools[1].models == ["opus"])
        #expect(s.readings[0].pools[1].windows[0].resetsAt == nil)
        #expect(s.readings[0].pools[0].windows.map(\.projectedUnused) == [0.12, 0])
        #expect(s.readings[0].pools[1].windows[0].projectedUnused == nil)
        #expect(s.readings[1].skipped == "not configured")
        #expect(s.next[1].lane == nil)
        #expect(s.notOffered.count == 1)
        #expect(s.tasks.map(\.status) == ["running", "done", "lost"])
        #expect(s.tasks[1].costUsd == 0.0123)
        #expect(s.tasks[1].endedAt == 1_699_999_280_000)
        #expect(s.hosts == nil)
        #expect(s.unhealthyHosts.isEmpty)
    }

    @Test func decodesSnapshotHosts() throws {
        let s = try Snapshot.decode(fixture("snapshot-hosts"))
        #expect(s.hosts == [
            Snapshot.Host(id: "claude", status: "ok"),
            Snapshot.Host(id: "codex", status: "stale"),
            Snapshot.Host(id: "agy", status: "missing"),
        ])
        #expect(s.unhealthyHosts.map(\.id) == ["codex", "agy"])
        #expect(s.hosts?.map(\.displayName) == ["Claude Code", "Codex", "Antigravity"])
        #expect(Snapshot.Host(id: "grok", status: "ok").displayName == "Grok")
        #expect(
            Snapshot.reconnectedMessage(for: s.unhealthyHosts.map(\.displayName))
                == "Reconnected. Restart Codex, Antigravity to use schmear."
        )
        #expect(Snapshot.reconnectedMessage(for: []) == "Reconnected. Restart your agents to use schmear.")
    }

    @Test func attentionStates() throws {
        let healthy = try Snapshot.decode(fixture("snapshot"))
        let brokenHosts = try Snapshot.decode(fixture("snapshot-hosts"))

        #expect(!Snapshot.needsAttention(installed: true, snapshot: nil))
        #expect(!Snapshot.needsAttention(installed: true, snapshot: healthy))

        #expect(Snapshot.needsAttention(installed: false, snapshot: nil))
        #expect(Snapshot.needsAttention(installed: false, snapshot: healthy))

        #expect(Snapshot.needsAttention(installed: true, snapshot: brokenHosts))

        var allOkHosts = healthy
        allOkHosts.hosts = [Snapshot.Host(id: "claude", status: "ok")]
        #expect(!Snapshot.needsAttention(installed: true, snapshot: allOkHosts))

        var noReadings = healthy
        noReadings.readings = []
        #expect(Snapshot.needsAttention(installed: true, snapshot: noReadings))

        var onlySkipped = healthy
        onlySkipped.readings = [healthy.readings[1]]
        #expect(Snapshot.needsAttention(installed: true, snapshot: onlySkipped))

        var poolLess = healthy
        poolLess.readings = [Snapshot.Reading(id: "claude", skipped: nil, source: nil, fetchedAt: nil, warnings: [], pools: [])]
        #expect(Snapshot.needsAttention(installed: true, snapshot: poolLess))
    }

    @Test func decodesCreditUsd() throws {
        let s = try Snapshot.decode(fixture("snapshot-credits"))
        #expect(s.readings[1].pools[0].usd == Snapshot.Usd(left: 4.2, granted: 5, expiring: 3, grant: 3, purchased: 1.2, spentMonth: 0.8))
        #expect(s.readings[2].pools[0].usd == Snapshot.Usd(left: 300, granted: 300))
        #expect(s.readings[0].pools[0].usd == nil)
    }

    @Test func decodesCreditNamesLoginsAndNotices() throws {
        let s = try Snapshot.decode(fixture("snapshot-credits"))
        #expect(s.readings.map(\.login) == [nil, "claude@default", "agy@default", nil])
        #expect(s.readings.flatMap(\.pools).map(\.name) == [nil, "Acme", "01AB23-CD45EF-678901"])
        #expect(s.notices == [Snapshot.Notice(
            id: "expiring:claude-credits@default:1700481600000",
            title: "$3 of API credit expires Nov 20",
            body: "claude-credits@default (Acme) expires in 3 days. Delegate work to spend it."
        )])
    }

    @Test func olderSnapshotHasNoCreditFieldsOrNotices() throws {
        let s = try Snapshot.decode(fixture("snapshot"))
        #expect(s.notices == nil)
        #expect(s.readings.allSatisfy { $0.login == nil && $0.pools.allSatisfy { $0.name == nil } })
    }

    @Test func creditReadingsNestUnderTheirAccount() throws {
        let accounts = try Snapshot.decode(fixture("snapshot-credits")).accounts
        #expect(accounts.map(\.title) == ["claude@default", "lab · API credits only · runs under agy@default", "side · API credits only"])
        #expect(accounts.map(\.id) == ["claude@default", "gemini-credits@lab", "claude-credits@side"])
        #expect(accounts[0].reading?.id == "claude@default")
        #expect(accounts[0].credits.map(\.id) == ["claude-credits@default"])
        #expect(accounts[1].reading == nil)
        #expect(accounts[2].credits[0].skipped == "Console session side expired.")
    }

    @Test func skippedCreditReadingCountsLikeAnySkipped() throws {
        let s = try Snapshot.decode(fixture("snapshot-credits"))
        #expect(!Snapshot.needsAttention(installed: true, snapshot: s))
        var onlySkipped = s
        onlySkipped.readings = [
            Snapshot.Reading(id: "claude@default", skipped: "no consent", source: nil, fetchedAt: nil, warnings: [], pools: []),
            s.readings[3],
        ]
        #expect(Snapshot.needsAttention(installed: true, snapshot: onlySkipped))
    }

    @Test func cliVersionMinimum() {
        #expect(CLIVersion.isTooOld(nil))
        #expect(CLIVersion.isTooOld("0.3.1"))
        #expect(CLIVersion.isTooOld("garbage"))
        #expect(!CLIVersion.isTooOld("0.4.0"))
        #expect(!CLIVersion.isTooOld("0.10.0"))
        #expect(!CLIVersion.isTooOld("1.0.0"))
        #expect(!CLIVersion.isTooOld("0.4.0-rc.1"))
        #expect(CLIVersion.isTooOld("0.3.9-rc.1"))
    }

    @Test func cliNoticeStates() throws {
        #expect(CLIVersion.notice(for: "0.4.0") == nil)
        #expect(CLIVersion.notice(for: nil) == "schmear older than 0.4.0 is too old for this app; it needs 0.4.0 or later.")
        #expect(CLIVersion.notice(for: "0.3.1") == "schmear 0.3.1 is too old for this app; it needs 0.4.0 or later.")

        var snapshot = try Snapshot.decode(fixture("snapshot"))
        #expect(snapshot.cliVersion == "0.4.0")
        #expect(!Snapshot.needsAttention(installed: true, snapshot: snapshot))
        snapshot.cliVersion = nil
        #expect(Snapshot.needsAttention(installed: true, snapshot: snapshot))
    }

    @Test func decodesTiers() throws {
        let t = try TiersDoc.decode(fixture("tiers"))
        #expect(t.source == "config")
        #expect(t.maxTasks == 12)
        #expect(t.tiers[1] == ["claude:sonnet@high", "codex:gpt-5@medium"])
        #expect(t.laneKeys.count == 3)
        #expect(t.offered["codex"] == ["gpt-5"])
        #expect(t.offered["agy-gemini"] == nil)
    }

    @Test func rejectsOtherVersions() {
        let data = Data(#"{"version": 2}"#.utf8)
        #expect(throws: SchmearError.unsupportedVersion(2)) { try Snapshot.decode(data) }
        #expect(throws: SchmearError.unsupportedVersion(2)) { try TiersDoc.decode(data) }
        #expect(SchmearError.unsupportedVersion(2).localizedDescription.contains("Update the app or schmear"))
    }
}
