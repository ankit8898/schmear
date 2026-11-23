import AppKit
import SchmearKit
import ServiceManagement
import SwiftUI

struct PopoverView: View {
    let store: Store
    @State private var contentHeight: CGFloat = 0

    /// A MenuBarExtra window takes the ScrollView's ideal height, which is near zero, so the content's measured height sets it.
    var body: some View {
        ScrollView {
            content.onGeometryChange(for: CGFloat.self) { $0.size.height } action: { contentHeight = $0 }
        }
        .frame(width: 360, height: min(contentHeight, 640))
    }

    var content: some View {
        VStack(alignment: .leading, spacing: 14) {
            header
            if let error = store.error {
                ErrorBanner(message: error, dataAge: store.snapshot.map { Format.relative($0.at, now: store.now) })
            }
            if let snapshot = store.snapshot {
                Divider()
                subscriptions(snapshot)
                Divider()
                nextByTier(snapshot)
                Divider()
                delegations(snapshot)
            }
            Divider()
            FooterView()
        }
        .padding(16)
        .frame(width: 360, alignment: .leading)
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            Text("schmear").font(.headline)
            if let snapshot = store.snapshot {
                Text("updated \(Format.relative(snapshot.at, now: store.now))")
                    .font(.caption).foregroundStyle(.secondary).monospacedDigit()
            }
            Spacer()
            Button {
                Task { await store.refresh() }
            } label: {
                if store.isRefreshing {
                    ProgressView().controlSize(.mini)
                } else {
                    Image(systemName: "arrow.clockwise")
                }
            }
            .buttonStyle(.borderless)
            .disabled(store.isRefreshing)
            .help("Refresh")
            .accessibilityLabel(store.isRefreshing ? "Refreshing" : "Refresh")
        }
    }

    private func subscriptions(_ snapshot: Snapshot) -> some View {
        Section("Subscriptions") {
            if !snapshot.readings.isEmpty, snapshot.readings.allSatisfy({ $0.skipped == "not configured" }) {
                Text("No subscriptions set up. Run `schmear init` in a terminal.")
                    .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            } else {
                ForEach(snapshot.readings, id: \.id) { reading in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(reading.id).font(.callout.weight(.semibold))
                        if let skipped = reading.skipped {
                            Text(skipped).font(.caption).foregroundStyle(.secondary)
                        } else {
                            let lone = reading.pools.count == 1 && reading.pools[0].id == reading.id
                            ForEach(reading.pools, id: \.id) { PoolView(pool: $0, showsId: !lone, now: store.now) }
                            ForEach(reading.warnings, id: \.self) { warning in
                                Label(warning, systemImage: "exclamationmark.triangle")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
        }
    }

    private func nextByTier(_ snapshot: Snapshot) -> some View {
        Section("Next task by tier") {
            Grid(alignment: .leading, horizontalSpacing: 8, verticalSpacing: 4) {
                ForEach(snapshot.next, id: \.tier) { next in
                    GridRow {
                        Text("Tier \(next.tier)").monospacedDigit()
                        Text("→").foregroundStyle(.secondary)
                        Text(next.lane.map { lane in next.effort.map { "\(lane) (\($0))" } ?? lane } ?? "none")
                            .foregroundStyle(next.lane == nil ? .secondary : .primary)
                            .lineLimit(1).truncationMode(.middle)
                    }
                }
            }
            .font(.callout)
            if !snapshot.notOffered.isEmpty {
                Text("Not offered: " + snapshot.notOffered.joined(separator: ", "))
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func delegations(_ snapshot: Snapshot) -> some View {
        let running = snapshot.tasks.filter { $0.status == "running" }
        let rest = snapshot.tasks.filter { $0.status != "running" }.sorted { $0.startedAt > $1.startedAt }
        let tasks = Array((running.sorted { $0.startedAt > $1.startedAt } + rest).prefix(10))
        return Section("Delegations") {
            if tasks.isEmpty {
                Text("No delegations in the last 24 hours.").font(.callout).foregroundStyle(.secondary)
            } else {
                ForEach(tasks) { TaskRow(task: $0, now: store.now) }
            }
        }
    }

}

private struct Section<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content

    init(_ title: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.caption.weight(.semibold)).foregroundStyle(.secondary).textCase(.uppercase)
            content
        }
    }
}

private struct FooterView: View {
    @Environment(\.openWindow) private var openWindow
    @State private var opensAtLogin = false
    @State private var loginError: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Button("Edit Tiers…") {
                    openWindow(id: "tiers")
                    NSApp.activate()
                }
                Spacer()
                Toggle("Open at Login", isOn: Binding(get: { opensAtLogin }, set: setOpensAtLogin))
                    .toggleStyle(.checkbox).controlSize(.small)
                Spacer()
                Button("Quit") { NSApp.terminate(nil) }
            }
            .buttonStyle(.borderless)
            if let loginError {
                Text(loginError).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
        }
        .onAppear { opensAtLogin = SMAppService.mainApp.status == .enabled }
    }

    private func setOpensAtLogin(_ on: Bool) {
        do {
            if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
            opensAtLogin = on
            loginError = nil
        } catch {
            loginError = error.localizedDescription
        }
    }
}

private struct ErrorBanner: View {
    let message: String
    let dataAge: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Label {
                Text(message).fixedSize(horizontal: false, vertical: true)
            } icon: {
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
            }
            .font(.callout)
            if let dataAge {
                Text("Showing data from \(dataAge).").font(.caption).foregroundStyle(.secondary).monospacedDigit()
            }
        }
    }
}

private struct PoolView: View {
    let pool: Snapshot.Pool
    let showsId: Bool
    let now: Date

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                if showsId { Text(pool.id).font(.callout) }
                if let models = pool.models, !models.isEmpty {
                    Text(models.joined(separator: ", ")).font(.caption).foregroundStyle(.secondary)
                }
                Spacer(minLength: 8)
                Text("pace \(Format.pace(pool.pace))").font(.caption).foregroundStyle(.secondary).monospacedDigit()
                if let status = pool.status { StatusLabel(status: status) }
            }
            .lineLimit(1)
            ForEach(Array(pool.windows.enumerated()), id: \.offset) { _, window in
                HStack(spacing: 8) {
                    RemainingBar(remaining: window.remaining)
                    Text(Format.windowLine(window, now: now)).font(.caption).monospacedDigit()
                }
            }
        }
    }
}

private struct StatusLabel: View {
    let status: String

    var body: some View {
        let (symbol, color, text): (String, Color, String) =
            if status == "ok" { ("checkmark.circle.fill", .green, "ok") }
            else if status.hasPrefix("out: ") { ("xmark.circle", .red, String(status.dropFirst(5))) }
            else if status.hasPrefix("skipped: ") { ("minus.circle", .secondary, String(status.dropFirst(9))) }
            else { ("questionmark.circle", .secondary, status) }
        HStack(spacing: 3) {
            Image(systemName: symbol).foregroundStyle(color)
            Text(text)
        }
        .font(.caption)
    }
}

private struct RemainingBar: View {
    let remaining: Double

    var body: some View {
        Capsule().fill(.quaternary)
            .overlay(alignment: .leading) {
                GeometryReader { geo in
                    Capsule().fill(Color.accentColor)
                        .frame(width: geo.size.width * min(max(remaining, 0), 1))
                }
            }
            .frame(width: 72, height: 4)
            .accessibilityLabel("\(Int((remaining * 100).rounded()))% left")
    }
}

private struct TaskRow: View {
    let task: Snapshot.Task
    let now: Date

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            symbol.frame(width: 16)
            VStack(alignment: .leading, spacing: 2) {
                Text(task.description).font(.callout).lineLimit(1).truncationMode(.tail)
                Text(details).font(.caption).foregroundStyle(.secondary).monospacedDigit().lineLimit(1)
            }
        }
        .help(task.cwd)
    }

    private var details: String {
        ([task.lane, "tier \(task.tier)", Format.elapsed(task, now: now)] + [task.costUsd.map(Format.cost)])
            .compactMap { $0 }.joined(separator: " · ")
    }

    @ViewBuilder private var symbol: some View {
        switch task.status {
        case "running": ProgressView().controlSize(.mini)
        case "done": Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
        case "failed": Image(systemName: "xmark.octagon.fill").foregroundStyle(.red)
        case "lost": Image(systemName: "questionmark.circle.fill").foregroundStyle(.orange)
        case "cancelled": Image(systemName: "slash.circle").foregroundStyle(.secondary)
        default: Image(systemName: "minus.circle").foregroundStyle(.secondary)
        }
    }
}
