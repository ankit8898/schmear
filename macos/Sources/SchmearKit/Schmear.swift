import Foundation

private final class Capture: @unchecked Sendable {
    var data = Data()
}

private actor LoginEnvironment {
    private var task: Task<[String: String], Error>?

    func get() async throws -> [String: String] {
        if let task { return try await task.value }
        let task = Task { try await Schmear.readLoginEnvironment() }
        self.task = task
        do { return try await task.value } catch {
            self.task = nil
            throw error
        }
    }

    func clear() { task = nil }
}

private let environmentCache = LoginEnvironment()

/// Runs the `schmear` CLI with the environment of the user's interactive login shell: a GUI app does not inherit it.
public struct Schmear: Sendable {
    let executable: String
    let prefix: [String]
    let environment: [String: String]?

    init(executable: String, prefix: [String], environment: [String: String]? = nil) {
        self.executable = executable
        self.prefix = prefix
        self.environment = environment
    }

    public static func run(_ args: [String], stdin: Data? = nil) async throws -> Data {
        let env = try await environmentCache.get()
        do {
            return try await Schmear(executable: "/usr/bin/env", prefix: ["schmear"], environment: env)
                .execute(args, stdin: stdin)
        } catch SchmearError.notInstalled {
            await environmentCache.clear()
            throw SchmearError.notInstalled
        }
    }

    public static func hasCommand(_ name: String) async -> Bool {
        guard let path = (try? await environmentCache.get())?["PATH"] else { return false }
        return isOnPath(name, path: path)
    }

    static func isOnPath(_ name: String, path: String) -> Bool {
        let fm = FileManager.default
        for dir in path.split(separator: ":") {
            let candidate = "\(dir)/\(name)"
            var isDir: ObjCBool = false
            if fm.fileExists(atPath: candidate, isDirectory: &isDir),
               !isDir.boolValue,
               fm.isExecutableFile(atPath: candidate) {
                return true
            }
        }
        return false
    }

    // NUL-framed because an env value can hold the marker text (a GitHub runner's does) but never a NUL.
    private static let marker = Data("\0__SCHMEAR_ENV__\0".utf8)

    /// `env -0` output after the last NUL-framed marker; rc files may print before it. Nil without a marker or a PATH.
    static func loginEnvironment(from output: Data) -> [String: String]? {
        guard let range = output.range(of: marker, options: .backwards) else { return nil }
        var env: [String: String] = [:]
        for entry in output[range.upperBound...].split(separator: 0) {
            let text = String(decoding: entry, as: UTF8.self)
            guard let eq = text.firstIndex(of: "=") else { continue }
            env[String(text[..<eq])] = String(text[text.index(after: eq)...])
        }
        return env["PATH"] == nil ? nil : env
    }

    fileprivate static func readLoginEnvironment() async throws -> [String: String] {
        let shell = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
        let (status, out, err) = try await Schmear(
            executable: shell, prefix: ["-ilc", "printf '\\0__SCHMEAR_ENV__\\0'; exec /usr/bin/env -0"]
        ).capture([])
        guard status == 0, let env = loginEnvironment(from: out) else {
            throw SchmearError.command("could not read the environment from \(shell) -ilc: \(trimmed(err))")
        }
        return env
    }

    func execute(_ args: [String], stdin: Data? = nil) async throws -> Data {
        let (status, out, err) = try await capture(args, stdin: stdin)
        switch status {
        case 0: return out
        case 127: throw SchmearError.notInstalled
        default: throw SchmearError.command(Self.trimmed(err))
        }
    }

    private static func trimmed(_ data: Data) -> String {
        String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func capture(_ args: [String], stdin: Data? = nil) async throws -> (Int32, Data, Data) {
        try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global().async {
                continuation.resume(with: Result { try self.launch(args, stdin: stdin) })
            }
        }
    }

    private func launch(_ args: [String], stdin: Data?) throws -> (Int32, Data, Data) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = prefix + args
        if let environment { process.environment = environment }
        let inPipe = Pipe(), outPipe = Pipe(), errPipe = Pipe()
        process.standardInput = inPipe
        process.standardOutput = outPipe
        process.standardError = errPipe
        try process.run()

        // Drain both pipes while the child runs so a large snapshot cannot fill one and block it.
        let out = Capture(), err = Capture()
        let group = DispatchGroup()
        for (handle, capture) in [(outPipe.fileHandleForReading, out), (errPipe.fileHandleForReading, err)] {
            group.enter()
            DispatchQueue.global().async {
                capture.data = handle.readDataToEndOfFile()
                group.leave()
            }
        }
        if let stdin { try? inPipe.fileHandleForWriting.write(contentsOf: stdin) }
        try? inPipe.fileHandleForWriting.close()
        group.wait()
        process.waitUntilExit()
        return (process.terminationStatus, out.data, err.data)
    }
}
