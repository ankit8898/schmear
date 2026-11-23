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
    }

    @Test func decodesTiers() throws {
        let t = try TiersDoc.decode(fixture("tiers"))
        #expect(t.source == "config")
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
