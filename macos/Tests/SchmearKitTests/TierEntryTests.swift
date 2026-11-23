import Testing
@testable import SchmearKit

@Suite struct TierEntryTests {
    @Test func parsesPlainSpec() {
        let e = TierEntry(spec: "claude:sonnet@high")
        #expect((e.key, e.model, e.effort) == ("claude", "sonnet", "high"))
        #expect(e.isComplete)
    }

    @Test func modelMayContainAtAndColon() {
        let e = TierEntry(spec: "agy:models/gemini@2:preview@medium")
        #expect((e.key, e.model, e.effort) == ("agy", "models/gemini@2:preview", "medium"))
    }

    @Test func missingEffort() {
        let e = TierEntry(spec: "claude:sonnet")
        #expect((e.key, e.model, e.effort) == ("claude", "sonnet", ""))
        #expect(!e.isComplete)
    }

    @Test func missingColon() {
        let e = TierEntry(spec: "claude")
        #expect((e.key, e.model, e.effort) == ("claude", "", ""))
        #expect(!e.isComplete)
    }

    @Test func specRoundTrips() {
        #expect(TierEntry(spec: "codex:gpt-5@medium").spec == "codex:gpt-5@medium")
        #expect(TierEntry(key: "codex").spec == "codex:@")
    }

    @Test func blankPartsAreIncomplete() {
        #expect(!TierEntry(spec: "claude: @high").isComplete)
    }
}
