import Foundation
import Observation
import SchmearKit

@MainActor @Observable final class Store {
    private(set) var snapshot: Snapshot?
    private(set) var error: String?
    private(set) var isRefreshing = false
    private(set) var now: Date

    init(snapshot: Snapshot? = nil, now: Date = Date()) {
        self.snapshot = snapshot
        self.now = now
    }

    var runningCount: Int { snapshot?.tasks.filter { $0.status == "running" }.count ?? 0 }

    /// Pace > 1 means quota expires unused unless spent faster: the cue to delegate.
    var underspent: Bool {
        snapshot?.readings.contains { $0.pools.contains { ($0.pace ?? 0) > 1 } } ?? false
    }

    func poll() async {
        while !Task.isCancelled {
            await refresh()
            try? await Task.sleep(for: .seconds(60))
        }
    }

    func refresh() async {
        now = Date()
        guard !isRefreshing else { return }
        isRefreshing = true
        defer {
            isRefreshing = false
            now = Date()
        }
        do {
            snapshot = try Snapshot.decode(await Schmear.run(["usage", "--json"]))
            error = nil
        } catch SchmearError.notInstalled {
            snapshot = nil
            error = SchmearError.notInstalled.localizedDescription
        } catch {
            self.error = error.localizedDescription
        }
    }
}
