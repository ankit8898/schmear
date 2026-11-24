import SchmearKit
import SwiftUI

struct TierEditorView: View {
    let store: Store
    @State private var doc: TiersDoc?
    @State private var tiers: [[TierEntry]] = []
    // Text, not a number: a click on Save need not blur the field, so a formatter would not have committed it.
    @State private var maxTasksText = "50"
    @State private var error: String?
    @State private var message: String?
    @State private var isBusy = false

    init(store: Store, doc: TiersDoc? = nil) {
        self.store = store
        _doc = State(initialValue: doc)
        _tiers = State(initialValue: doc.map { $0.tiers.map { $0.map { TierEntry(spec: $0) } } } ?? [])
        _maxTasksText = State(initialValue: String(doc?.maxTasks ?? 50))
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView { content }
            Divider()
            footer.padding(16)
        }
        .frame(minWidth: 560, minHeight: 420)
        .task { if doc == nil { await load() } }
    }

    /// The scrolling part, separate so `--render-tiers` can draw it without a ScrollView.
    var content: some View {
        VStack(alignment: .leading, spacing: 16) {
            if let doc {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 8) {
                        Text("Tasks per call")
                        TextField("Tasks per call", text: $maxTasksText)
                            .labelsHidden()
                            .frame(width: 60)
                        Stepper("Tasks per call", value: maxTasksStepper, in: 1...999)
                            .labelsHidden()
                    }
                    Text("The most tasks one delegate call can carry.")
                        .font(.callout).foregroundStyle(.secondary)
                }
                Text(doc.source == "config" ? "Using your tiers from config" : "Using the default tiers")
                    .font(.callout).foregroundStyle(.secondary)
            }
            ForEach(tiers.indices, id: \.self) { tierSection($0) }
            if doc != nil {
                Button("Add tier", systemImage: "plus") { tiers.append([TierEntry(key: defaultKey)]) }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    var footer: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let error {
                Label {
                    Text(error).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                } icon: {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                }
            } else if let message {
                Label {
                    Text(message).fixedSize(horizontal: false, vertical: true)
                } icon: {
                    Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                }
            }
            HStack {
                Button("Reset to Defaults") { Task { await reset() } }
                    .disabled(isBusy)
                Spacer()
                if isBusy { ProgressView().controlSize(.small) }
                Button("Save") { Task { await save() } }
                    .keyboardShortcut(.defaultAction)
                    .disabled(!canSave)
            }
        }
        .font(.callout)
    }

    private var defaultKey: String { doc?.laneKeys.first ?? "" }

    /// The limit as typed; nil unless it is a whole number the CLI accepts.
    private var maxTasks: Int? {
        Int(maxTasksText.trimmingCharacters(in: .whitespaces)).flatMap { (1...999).contains($0) ? $0 : nil }
    }

    private var maxTasksStepper: Binding<Int> {
        Binding(get: { maxTasks ?? doc?.maxTasks ?? 50 }, set: { maxTasksText = String($0) })
    }

    private var canSave: Bool {
        doc != nil && maxTasks != nil && !isBusy && !tiers.isEmpty && tiers.allSatisfy { !$0.isEmpty && $0.allSatisfy(\.isComplete) }
    }

    private func tierSection(_ t: Int) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(tierTitle(t)).font(.headline)
                Spacer()
                Button("Move up", systemImage: "arrow.up") { tiers.swapAt(t, t - 1) }
                    .disabled(t == 0)
                Button("Move down", systemImage: "arrow.down") { tiers.swapAt(t, t + 1) }
                    .disabled(t == tiers.count - 1)
                Button("Remove tier", systemImage: "trash") { tiers.remove(at: t) }
            }
            .labelStyle(.iconOnly)
            .buttonStyle(.borderless)
            ForEach($tiers[t]) { $entry in
                EntryRow(entry: $entry, laneKeys: doc?.laneKeys ?? [], offered: doc?.offered[entry.key] ?? []) {
                    tiers[t].removeAll { $0.id == entry.id }
                }
            }
            Button("Add entry", systemImage: "plus") { tiers[t].append(TierEntry(key: defaultKey)) }
                .buttonStyle(.borderless)
                .font(.callout)
        }
        .padding(12)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 8))
    }

    private func tierTitle(_ t: Int) -> String {
        let suffix = tiers.count < 2 ? "" : t == 0 ? " — weakest" : t == tiers.count - 1 ? " — strongest" : ""
        return "Tier \(t + 1)\(suffix)"
    }

    private func load() async {
        do {
            let loaded = try TiersDoc.decode(await Schmear.run(["tiers"]))
            doc = loaded
            tiers = loaded.tiers.map { $0.map { TierEntry(spec: $0) } }
            maxTasksText = String(loaded.maxTasks)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func save() async {
        guard let doc, let maxTasks else { return }
        await write(TierEditorPlan.steps(loaded: doc, tiers: tiers.map { $0.map(\.spec) }, maxTasks: maxTasks))
    }

    private func reset() async {
        await write([.init(["tiers", "reset"]), .init(["max-tasks", "reset"])])
    }

    /// Runs a write sequence; on success reloads the editor and the popover, on failure keeps the edits.
    private func write(_ steps: [TierEditorPlan.Step]) async {
        isBusy = true
        defer { isBusy = false }
        message = nil
        do {
            var outputs: [String] = []
            for step in steps {
                let out = try await Schmear.run(step.args, stdin: step.stdin)
                let trimmed = String(decoding: out, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty { outputs.append(trimmed) }
            }
            await load()
            message = outputs.joined(separator: "\n")
            await store.refresh()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

private struct EntryRow: View {
    @Binding var entry: TierEntry
    let laneKeys: [String]
    let offered: [String]
    let remove: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Picker("Lane", selection: $entry.key) {
                ForEach(laneKeys.contains(entry.key) ? laneKeys : [entry.key] + laneKeys, id: \.self) { Text($0) }
            }
            .labelsHidden()
            .frame(width: 140)
            HStack(spacing: 2) {
                TextField("model", text: $entry.model)
                if !offered.isEmpty {
                    Menu {
                        ForEach(offered, id: \.self) { model in Button(model) { entry.model = model } }
                    } label: {
                        Image(systemName: "chevron.down")
                    }
                    .menuStyle(.borderlessButton)
                    .menuIndicator(.hidden)
                    .fixedSize()
                    .help("Models schmear offers for \(entry.key)")
                }
            }
            TextField("effort", text: $entry.effort)
                .frame(width: 90)
            Button("Remove entry", systemImage: "minus.circle", action: remove)
                .labelStyle(.iconOnly)
                .buttonStyle(.borderless)
        }
    }
}
