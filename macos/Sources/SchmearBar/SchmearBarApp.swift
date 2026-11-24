import AppKit
import SchmearKit
import SwiftUI

@main enum Entry {
    @MainActor static func main() throws {
        let args = Array(CommandLine.arguments.dropFirst())
        let paths = args.dropFirst().filter { $0 != "--dark" }
        let dark = args.contains("--dark")
        if args.first == "--render" {
            try render(paths, usage: "--render <snapshot.json> <out.png> [--dark]", dark: dark) {
                let snapshot = try Snapshot.decode($0)
                return PopoverView(store: Store(snapshot: snapshot, now: Date(timeIntervalSince1970: snapshot.at / 1000 + 120)))
                    .content
            }
        } else if args.first == "--render-tiers" {
            try render(paths, usage: "--render-tiers <tiers.json> <out.png> [--dark]", dark: dark) {
                let editor = TierEditorView(store: Store(), doc: try TiersDoc.decode($0))
                return VStack(spacing: 0) {
                    editor.content
                    Divider()
                    editor.footer.padding(16)
                }
                .frame(width: 560)
            }
        } else {
            SchmearBarApp.main()
        }
    }

    /// Review-only: draws the view built from the JSON at `paths[0]` as a 2x PNG at `paths[1]`.
    @MainActor private static func render<V: View>(
        _ paths: [String], usage: String, dark: Bool, view: (Data) throws -> V
    ) throws {
        guard paths.count == 2 else {
            FileHandle.standardError.write(Data("usage: SchmearBar \(usage)\n".utf8))
            exit(2)
        }
        let renderer = ImageRenderer(content: try view(Data(contentsOf: URL(fileURLWithPath: paths[0])))
            .background(.background)
            .environment(\.colorScheme, dark ? .dark : .light))
        renderer.scale = 2
        guard let image = renderer.cgImage,
              let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])
        else { throw CocoaError(.fileWriteUnknown) }
        try png.write(to: URL(fileURLWithPath: paths[1]))
    }
}

struct SchmearBarApp: App {
    @State private var store: Store

    init() {
        let store = Store()
        _store = State(initialValue: store)
        Task { await store.poll() }
    }

    var body: some Scene {
        MenuBarExtra {
            PopoverView(store: store)
        } label: {
            HStack(spacing: 2) {
                Image(systemName: iconName)
                if store.runningCount > 0 { Text("\(store.runningCount)").monospacedDigit() }
            }
            .accessibilityLabel(menuBarLabel)
        }
        .menuBarExtraStyle(.window)
        Window("schmear Tiers", id: "tiers") { TierEditorView(store: store) }
    }

    private var iconName: String {
        if store.needsAttention { return "exclamationmark.triangle" }
        return store.underspent ? "square.stack.3d.up.fill" : "square.stack.3d.up"
    }

    private var menuBarLabel: String {
        var parts = ["schmear"]
        if store.needsAttention { parts.append("needs attention") }
        if store.runningCount > 0 { parts.append("\(store.runningCount) running") }
        if store.underspent { parts.append("quota to spend") }
        return parts.joined(separator: ", ")
    }
}
