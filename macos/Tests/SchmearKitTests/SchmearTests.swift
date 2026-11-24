import Foundation
import Testing
@testable import SchmearKit

@Suite struct SchmearTests {
    func sh(_ script: String) -> Schmear {
        Schmear(executable: "/bin/sh", prefix: ["-c", script, "schmear"])
    }

    @Test func returnsStdout() async throws {
        let out = try await sh(#"printf '%s' "$1""#).execute(["hello world"])
        #expect(String(decoding: out, as: UTF8.self) == "hello world")
    }

    @Test func passesStdin() async throws {
        let out = try await sh("cat").execute([], stdin: Data(#"{"a":1}"#.utf8))
        #expect(String(decoding: out, as: UTF8.self) == #"{"a":1}"#)
    }

    @Test func largeOutputDoesNotDeadlock() async throws {
        let out = try await sh("head -c 1000000 /dev/zero").execute([])
        #expect(out.count == 1_000_000)
    }

    @Test func nonZeroExitThrowsTrimmedStderr() async {
        await #expect(throws: SchmearError.command("schmear: tier 1 is empty")) {
            try await sh("echo 'schmear: tier 1 is empty' >&2; exit 1").execute([])
        }
    }

    @Test func exit127IsNotInstalled() async {
        await #expect(throws: SchmearError.notInstalled) { try await sh("exit 127").execute([]) }
    }

    @Test func envWithoutSchmearOnPathIsNotInstalled() async {
        let env = Schmear(executable: "/usr/bin/env", prefix: ["schmear"], environment: ["PATH": "/nonexistent"])
        await #expect(throws: SchmearError.notInstalled) { try await env.execute([]) }
    }

    @Test func launchUsesTheGivenEnvironment() async throws {
        let sh = Schmear(executable: "/bin/sh", prefix: ["-c", #"printf '%s' "$XDG_CONFIG_HOME""#], environment: ["XDG_CONFIG_HOME": "/cfg"])
        #expect(String(decoding: try await sh.execute([]), as: UTF8.self) == "/cfg")
    }

    @Test func loginEnvironmentIsTheEntriesAfterTheLastMarker() {
        func env(_ text: String) -> [String: String]? { Schmear.loginEnvironment(from: Data(text.utf8)) }
        #expect(env("motd\nstale=1\0\0__SCHMEAR_ENV__\0PATH=/a:/b\0HOME=/h\0") == ["PATH": "/a:/b", "HOME": "/h"])
        #expect(env("\0__SCHMEAR_ENV__\0PATH=/a\0OPTS=a=b\0MULTI=x\ny\0") == ["PATH": "/a", "OPTS": "a=b", "MULTI": "x\ny"])
        #expect(env("PATH=/a\0") == nil)
        #expect(env("\0__SCHMEAR_ENV__\0HOME=/h\0") == nil)
        #expect(env("\0__SCHMEAR_ENV__\0HOME=/h\0CMD=printf __SCHMEAR_ENV__\0PATH=/a\0") == ["HOME": "/h", "CMD": "printf __SCHMEAR_ENV__", "PATH": "/a"])
        #expect(env("") == nil)
    }

    @Test func timeoutTerminatesHungStubAndRecovers() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        let marker = dir.appendingPathComponent("ran")
        let stub = dir.appendingPathComponent("schmear")
        let script = """
        #!/bin/sh
        if [ ! -e "\(marker.path)" ]; then
            : > "\(marker.path)"
            exec sleep 60
        fi
        printf '%s' "$*"
        """
        try script.write(to: stub, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: stub.path)

        let runner = Schmear(executable: stub.path, prefix: [], timeout: 0.2)
        await #expect(throws: SchmearError.timedOut(["usage", "--json"], 0.2)) {
            try await runner.execute(["usage", "--json"])
        }
        #expect(
            SchmearError.timedOut(["usage", "--json"], 180).localizedDescription
                == "schmear usage --json timed out after 180 s"
        )

        let out = try await runner.execute(["usage", "--json"])
        #expect(String(decoding: out, as: UTF8.self) == "usage --json")
    }
}
