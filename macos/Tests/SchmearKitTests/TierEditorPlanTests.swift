import Foundation
import Testing
@testable import SchmearKit

@Suite struct TierEditorPlanTests {
    private func doc(source: String) -> TiersDoc {
        TiersDoc(
            version: 1, source: source, maxTasks: 50,
            tiers: [["claude:haiku@medium"], ["claude:sonnet@high", "codex:gpt-5@medium"]],
            defaults: [["claude:haiku@medium"]], laneKeys: ["claude", "codex"], offered: [:])
    }

    @Test func onlyTheLimitChangedOnDefaults() {
        let d = doc(source: "default")
        #expect(TierEditorPlan.steps(loaded: d, tiers: d.tiers, maxTasks: 8) == [.init(["max-tasks", "8"])])
    }

    @Test func editedTiersAreSet() throws {
        let d = doc(source: "default")
        let edited = [["claude:haiku@low"], d.tiers[1]]
        let json = try JSONEncoder().encode(edited)
        #expect(TierEditorPlan.steps(loaded: d, tiers: edited, maxTasks: 50) == [.init(["tiers", "set"], stdin: json)])
        #expect(TierEditorPlan.steps(loaded: d, tiers: edited, maxTasks: 8).map(\.args)
            == [["max-tasks", "8"], ["tiers", "set"]])
    }

    @Test func nothingChanged() {
        let d = doc(source: "default")
        #expect(TierEditorPlan.steps(loaded: d, tiers: d.tiers, maxTasks: 50).isEmpty)
    }

    @Test func customSourceUnchanged() {
        let d = doc(source: "config")
        #expect(TierEditorPlan.steps(loaded: d, tiers: d.tiers, maxTasks: 50).isEmpty)
    }
}
