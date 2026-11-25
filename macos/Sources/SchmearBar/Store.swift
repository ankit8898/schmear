import Foundation
import Observation
import SchmearKit
import UserNotifications

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
            let snapshot = try Snapshot.decode(await Schmear.run(["usage", "--json"]))
            self.snapshot = snapshot
            error = nil
            installState = .installed
            await post(snapshot.notices ?? [])
        } catch SchmearError.notInstalled {
            snapshot = nil
            error = nil
            installState = .missing(hasNpm: await Schmear.hasCommand("npm"))
        } catch {
            self.error = error.localizedDescription
            installState = .installed
        }
    }

    private static let postedKey = "postedNotices"

    /// Posts each notice whose id is not remembered and remembers it once posted; ids leave the memory when their notice leaves the snapshot, so a notice that returns posts again.
    private func post(_ notices: [Snapshot.Notice]) async {
        let defaults = UserDefaults.standard
        var posted = Set(defaults.stringArray(forKey: Self.postedKey) ?? []).intersection(notices.map(\.id))
        let unseen = notices.filter { !posted.contains($0.id) }
        // Prompts only the first time; while denied, nothing posts and each refresh asks the stored answer again.
        if !unseen.isEmpty, (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])) == true {
            let center = UNUserNotificationCenter.current()
            for notice in unseen {
                let content = UNMutableNotificationContent()
                content.title = notice.title
                content.body = notice.body
                let request = UNNotificationRequest(identifier: notice.id, content: content, trigger: nil)
                if (try? await center.add(request)) != nil { posted.insert(notice.id) }
            }
        }
        defaults.set(Array(posted), forKey: Self.postedKey)
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
