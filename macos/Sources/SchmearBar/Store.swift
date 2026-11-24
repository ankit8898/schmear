import Foundation
import Observation
import SchmearKit

@MainActor @Observable final class Store {
    enum InstallState: Equatable {
        case installed
        case missing(hasNpm: Bool)
    }

    private(set) var snapshot: Snapshot?
    private(set) var error: String?
    private(set) var installState: InstallState = .installed
    private(set) var isRefreshing = false
    private(set) var isReconnecting = false
    private(set) var reconnectError: String?
    private(set) var reconnectedHint: String?
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

    var cliNotice: String? { snapshot?.cliNotice }

    var needsAttention: Bool {
        Snapshot.needsAttention(installed: installState == .installed, snapshot: snapshot)
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
            installState = .installed
        } catch SchmearError.notInstalled {
            snapshot = nil
            error = nil
            installState = .missing(hasNpm: await Schmear.hasCommand("npm"))
        } catch {
            self.error = error.localizedDescription
            installState = .installed
        }
    }

    func reconnect() async {
        guard !isReconnecting else { return }
        let names = snapshot?.unhealthyHosts.map(\.displayName) ?? []
        isReconnecting = true
        reconnectError = nil
        defer { isReconnecting = false }
        do {
            _ = try await Schmear.run(["init", "--yes"])
            reconnectedHint = Snapshot.reconnectedMessage(for: names)
            await refresh()
        } catch {
            reconnectError = error.localizedDescription
        }
    }

    func dismissReconnectedHint() {
        reconnectedHint = nil
    }
}
