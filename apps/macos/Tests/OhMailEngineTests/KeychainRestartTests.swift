import Foundation
import XCTest
@testable import OhMailEngine

/// **A PASSWORD TYPED ONCE SURVIVES A RESTART — the acceptance for the per-install key.**
///
/// Not a unit test of key material. Every case here starts a real engine on a real on-disk mirror,
/// against a real mail server that really checks passwords, stops it the way the shell stops it,
/// and stands a SECOND engine up on the same directory with **no password anywhere in its
/// environment**. That second launch is the whole subject: the key comes back out of the Keychain,
/// the engine decrypts the password it sealed on the first launch, and the mailbox opens with
/// nobody typing anything.
///
/// ── WHY THE SERVER HAS TO BE ONE THAT CHECKS PASSWORDS ────────────────────────────────────
///
/// The development mail server this suite usually reaches accepts EVERY password. Against it, any
/// assertion of the form "the right password matters" passes whether or not the code is right — a
/// precedence test in this project once passed for weeks with its rule inverted, and only mutating
/// the source showed it. So these tests dial the server on ``imapPort``, which has a real password
/// database, and **skip** rather than run against one that does not. The wrong-password case is
/// only written because that server can refuse.
///
/// ── HOW "THE MAILBOX OPENED" IS ESTABLISHED ───────────────────────────────────────────────
///
/// By asking the server, with a SECOND, independent IMAP client — never by asking the engine where
/// it thinks it is. The engine announces itself before it dials, so reaching `serving` says nothing
/// about a login. What it does after an authenticated login is create its own folder tree in the
/// user's mailbox, and that tree is visible to any other client. So the tree is **deleted between
/// the two launches** and the assertion is that it came back: only a launch that logged in could
/// have put it there, and the launch that did is the one that carried no password.
///
/// The counterfactual is what stops that from being a coincidence. A third launch under a
/// DIFFERENT key must NOT bring the tree back — otherwise something other than the sealed
/// credential is opening the mailbox, and the whole slice would be theatre.
final class KeychainRestartTests: XCTestCase {
    /// The mail server with a real password database. The one this suite reaches by default accepts
    /// anything, and nothing here can be proven against that.
    private let imapHost = "127.0.0.1"
    private let imapPort = 3144
    private let imapPassword = "testpass"

    private var runID: String!
    private var address: String!
    private var directory: URL!
    private var dataDirectory: URL!
    private var keychainService: String!
    private var store: KeychainKeyStore!
    private var node: String!
    private var wrapper: URL!
    private var setVariables: [String] = []

    // MARK: - The machine this can run on

    /// The workspace the engine is built in. `OHMAIL_TEST_WORKSPACE` names it; otherwise it is five
    /// levels above this file. A checkout of the client alone has neither, which is the ordinary
    /// case for anyone reading this, and every test here skips.
    private static var workspaceRoot: URL {
        if let named = ProcessInfo.processInfo.environment["OHMAIL_TEST_WORKSPACE"], !named.isEmpty {
            return URL(fileURLWithPath: named)
        }
        return URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // the test directory
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // the client
            .deletingLastPathComponent()   // the apps directory
            .deletingLastPathComponent()   // the workspace
    }

    /// Where the engine's entry point sits in that workspace, and the directory its own dependencies
    /// resolve from — both assembled from components rather than written as one path, because a
    /// checkout of the client alone does not contain them and a literal would read as a link nobody
    /// can follow.
    private static var engineDirectory: URL {
        ["apps", "sidecar"].reduce(workspaceRoot) { $0.appendingPathComponent($1) }
    }
    private static var defaultEngineEntry: URL {
        ["src", "main.ts"].reduce(engineDirectory) { $0.appendingPathComponent($1) }
    }

    override func setUpWithError() throws {
        node = try nodePath()
        try requireAKeychain()
        try requireAServerThatChecksPasswords()

        runID = UUID().uuidString.prefix(8).lowercased()
        // A user nothing else has touched. The server creates the mailbox on first login, so a fresh
        // name is a fresh mailbox and no assertion here can be satisfied by another run's leftovers.
        address = "kek-\(runID!)@example.test"
        keychainService = "io.ohmail.test.restart.\(UUID().uuidString)"
        store = KeychainKeyStore(service: keychainService)

        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("ohmail-keychain-restart-\(runID!)")
        dataDirectory = directory.appendingPathComponent("mirror")
        try FileManager.default.createDirectory(at: dataDirectory, withIntermediateDirectories: true)
        wrapper = try engineWrapper()

        // The mailbox variables go in THIS process's environment, because that is where the engine
        // reads them from: the plan composes only the data directory and the key, and the child
        // inherits everything else. **`OHMAIL_IMAP_PASS` is deliberately never set** — the password
        // is typed over the bridge, which is what the shell will do, and a launch that carried one
        // would prove nothing about a launch that does not.
        set("OHMAIL_IMAP_HOST", imapHost)
        set("OHMAIL_IMAP_PORT", String(imapPort))
        set("OHMAIL_IMAP_SECURE", "0")
        set("OHMAIL_IMAP_USER", address)
        set("CI", "true")
    }

    override func tearDownWithError() throws {
        for name in setVariables { unsetenv(name) }
        setVariables = []
        // Through `security(1)`: one of these tests runs a separate shell that mints the item
        // itself, and an item belonging to another binary cannot be deleted from here.
        if let keychainService { forgetKeychainService(keychainService) }
        if let directory { try? FileManager.default.removeItem(at: directory) }
    }

    private func set(_ name: String, _ value: String) {
        setenv(name, value, 1)
        setVariables.append(name)
    }

    private func requireAKeychain() throws {
        let probe = KeychainKeyStore(service: "io.ohmail.test.reachable.\(UUID().uuidString)")
        defer { forgetKeychainService(probe.service) }
        do {
            _ = try probe.kek()
        } catch {
            throw XCTSkip("no keychain is reachable from this process: \(error)")
        }
    }

    /// Dial the server and insist it REFUSES a wrong password before running anything.
    ///
    /// This is the skip condition and it is written the strict way round on purpose: "something
    /// answered on that port" would be satisfied by the permissive server, and every assertion below
    /// would then pass without meaning anything.
    private func requireAServerThatChecksPasswords() throws {
        let refused: Bool
        do {
            refused = try imap("""
            try { await connect("not-the-password"); say("accepted"); }
            catch { say("refused"); }
            """, user: "probe-\(UUID().uuidString.prefix(8))@example.test",
                 password: "unused", connectFirst: false) == "refused"
        } catch {
            throw XCTSkip("no mail server answering on \(imapHost):\(imapPort): \(error)")
        }
        guard refused else {
            throw XCTSkip("the mail server on \(imapHost):\(imapPort) accepts every password, so "
                          + "nothing here about a password could fail")
        }
    }

    /// A wrapper named the way the shipped app names its engine, so the plan finds it the same way.
    private func engineWrapper() throws -> URL {
        let entry = ProcessInfo.processInfo.environment["OHMAIL_TEST_ENGINE"]
            .map { URL(fileURLWithPath: $0) } ?? Self.defaultEngineEntry
        guard FileManager.default.fileExists(atPath: entry.path) else {
            throw XCTSkip("no engine at \(entry.path); set OHMAIL_TEST_ENGINE to run this against one")
        }
        let root = Self.workspaceRoot
        guard FileManager.default.fileExists(
            atPath: root.appendingPathComponent("node_modules").appendingPathComponent("tsx").path) else {
            throw XCTSkip("the workspace's node dependencies are not installed, so the engine cannot start")
        }
        let wrapper = directory.appendingPathComponent(ENGINE_FILE_STEM)
        try Data("""
        #!/bin/sh
        cd "\(root.path)"
        exec "\(node!)" --import tsx "\(entry.path)"

        """.utf8).write(to: wrapper)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: wrapper.path)
        return wrapper
    }

    // MARK: - One launch of the shell

    private struct Failure: Error, CustomStringConvertible {
        let description: String
        init(_ description: String) { self.description = description }
    }

    /// What the plan decided, before anything was started. The key is read out of it because it is
    /// the value every later assertion is about — including the one that it is written nowhere else.
    private func planALaunch() throws -> (launch: EngineLaunch, key: String) {
        var environment = ProcessInfo.processInfo.environment
        environment[ENGINE_PATH_VAR] = wrapper.path
        environment[DATA_DIR_VAR] = dataDirectory.path
        // Nothing hands the key over. That is the point: the keystore is the only source, and a
        // variable left here would be the thing that made the test pass.
        environment.removeValue(forKey: KEK_VAR)

        let plan = EngineProcess.plan(
            environment: environment,
            executableDirectory: directory,
            dataDirectoryFallback: dataDirectory,
            keys: KeyProviderDefault(environment: [KeychainKeyStore.serviceVariable: keychainService]))
        guard case .spawn(let launch) = plan else {
            throw Failure("the plan refused to start the engine: \(plan)")
        }
        guard let key = launch.environment.first(where: { $0.name == KEK_VAR })?.value else {
            throw Failure("the launch carried no \(KEK_VAR)")
        }
        return (launch, key)
    }

    /// Start, wait for the engine's own `ready`, and hand back a bridge to it.
    private func serve(_ launch: EngineLaunch, file: StaticString = #filePath,
                       line: UInt = #line) throws -> (EngineProcess, EngineTransport, EngineReady) {
        let engine = EngineProcess(launch: launch)
        let transport = EngineTransport(engine: engine)
        engine.start()
        // Generous: a first launch builds the mirror and runs every migration.
        waitFor("the engine to announce itself", within: 180, file: file, line: line) {
            if case .serving = engine.status { return true }
            if case .failed = engine.status { return true }
            return false
        }
        guard case .serving = engine.status, let ready = engine.ready else {
            engine.stop()
            throw Failure("the engine did not reach serving: \(engine.status)")
        }
        return (engine, transport, ready)
    }

    private func stop(_ engine: EngineProcess, file: StaticString = #filePath, line: UInt = #line) {
        engine.stop()
        XCTAssertEqual(engine.status, .stopped, file: file, line: line)
        XCTAssertEqual(engine.lastExit?.code, 0, "the engine did not leave cleanly", file: file, line: line)
    }

    // MARK: - The bridge

    private func get(_ path: String, _ transport: EngineTransport) async throws -> (Int, [String: Any]) {
        var request = URLRequest(url: URL(string: "http://sidecar" + path)!)
        request.httpMethod = "GET"
        let response = try await transport.response(for: request)
        let json = (try? JSONSerialization.jsonObject(with: response.body)) as? [String: Any] ?? [:]
        return (response.status, json)
    }

    /// **Enter the password the way the shell will** — over the bridge, through the route the hosted
    /// client uses. Not a direct write into the mirror: credential entry is one code path for both,
    /// and it is the path that tries the password against the server before storing it.
    private func enterPassword(_ password: String, mailbox: String, session: Secret,
                               _ transport: EngineTransport) async throws -> (Int, String) {
        var request = URLRequest(url: URL(string: "http://sidecar/mailboxes/\(mailbox)")!)
        request.httpMethod = "PATCH"
        request.setValue("Bearer \(session.expose())", forHTTPHeaderField: "authorization")
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "imap": [
                "host": imapHost, "port": imapPort, "secure": false,
                "user": address!, "pass": password,
            ],
        ])
        let response = try await transport.response(for: request)
        return (response.status, String(decoding: response.body, as: UTF8.self))
    }

    // MARK: - The second IMAP client

    /// Run a fragment against the mail server through an independent client, and hand back what it
    /// printed.
    ///
    /// A SECOND client, and not the engine's own: the folders on the user's mailbox are the fact,
    /// and asking the code under test where it thinks it put something proves nothing about the
    /// server. `connect(pass)` and `say(text)` are in scope; `client` is the connected client.
    @discardableResult
    private func imap(_ body: String, user: String? = nil, password: String? = nil,
                      connectFirst: Bool = true) throws -> String {
        let script = """
        import { ImapFlow } from "imapflow";
        const out = [];
        const say = (t) => out.push(String(t));
        let client = null;
        const connect = async (pass) => {
          client = new ImapFlow({
            host: \(quoted(imapHost)), port: \(imapPort), secure: false,
            auth: { user: \(quoted(user ?? address)), pass },
            logger: false, emitLogs: false,
          });
          await client.connect();
          return client;
        };
        try {
          if (\(connectFirst ? "true" : "false")) await connect(\(quoted(password ?? imapPassword)));
          \(body)
        } finally {
          if (client && client.usable) await client.logout().catch(() => {});
          process.stdout.write(out.join("\\n"));
        }
        """
        let run = Process()
        run.executableURL = URL(fileURLWithPath: node)
        run.arguments = ["--input-type=module", "-e", script]
        // The engine's own directory, because that is where its dependencies resolve from — an
        // `--eval` script resolves against the working directory.
        run.currentDirectoryURL = Self.engineDirectory
        let out = Pipe()
        let err = Pipe()
        run.standardOutput = out
        run.standardError = err
        try run.run()
        let printed = out.fileHandleForReading.readDataToEndOfFile()
        let complaints = err.fileHandleForReading.readDataToEndOfFile()
        run.waitUntilExit()
        guard run.terminationStatus == 0 else {
            throw Failure("the second IMAP client failed: \(String(decoding: complaints, as: UTF8.self))")
        }
        return String(decoding: printed, as: UTF8.self)
    }

    private func quoted(_ value: String) -> String {
        String(decoding: (try? JSONSerialization.data(withJSONObject: [value]))
            .map { $0.dropFirst().dropLast() } ?? Data(), as: UTF8.self)
    }

    /// Every folder the app made in the user's mailbox, as the SERVER reports them.
    private func appFolders() throws -> [String] {
        let listed = try imap("""
        for (const box of await client.list()) if (box.path.startsWith("ohmail")) say(box.path);
        """)
        return listed.split(separator: "\n").map(String.init).sorted()
    }

    /// Remove them. Deepest first, because a server refuses to delete a folder that still has
    /// children.
    private func deleteAppFolders() throws {
        try imap("""
        const boxes = (await client.list()).map((b) => b.path).filter((p) => p.startsWith("ohmail"));
        boxes.sort((a, b) => b.split("/").length - a.split("/").length || b.localeCompare(a));
        for (const path of boxes) { try { await client.mailboxDelete(path); } catch (e) { say("kept " + path); } }
        """)
    }

    private func waitForAppFolders(_ what: String, within: TimeInterval) throws -> [String] {
        let deadline = Date().addingTimeInterval(within)
        var seen: [String] = []
        while Date() < deadline {
            seen = try appFolders()
            if !seen.isEmpty { return seen }
            Thread.sleep(forTimeInterval: 1)
        }
        return seen
    }

    // MARK: - The journey

    /// **Launch, type the password, quit, relaunch: the mailbox opens and nobody is asked again.**
    ///
    /// Then the two cases that decide whether that means anything — a third launch under a
    /// different key, which must NOT open it, and re-entering the password, which must.
    func testAPasswordTypedOnceSurvivesARestartAndALostKeyIsOnlyAPrompt() async throws {
        // ── LAUNCH ONE. Nothing is stored, and nothing carries a password. ────────────────────
        let first = try planALaunch()
        XCTAssertTrue(KeychainKeyStore.isKeyShaped(first.key),
                      "the key the shell composed is not 64 hex characters")
        XCTAssertEqual(try store.kek(), first.key, "the composed key is the one in the Keychain")

        let (engine1, bridge1, ready1) = try serve(first.launch)
        let mailbox = ready1.mailboxID
        let (health1, healthBody1) = try await get("/health", bridge1)
        XCTAssertEqual(health1, 200)
        let fingerprint = try XCTUnwrap((healthBody1["kek"] as? [String: Any])?["fingerprint"] as? String,
                                        "the engine published no key identity: \(healthBody1)")

        let (entered, enteredBody) = try await enterPassword(imapPassword, mailbox: mailbox,
                                                             session: ready1.sessionToken, bridge1)
        XCTAssertEqual(entered, 200, "the password was refused: \(enteredBody)")
        stop(engine1)

        // ── BETWEEN THE LAUNCHES. Take the app's folders away, so their return can only be the
        //    work of a launch that logged in after this point. ─────────────────────────────────
        try deleteAppFolders()
        XCTAssertEqual(try appFolders(), [], "the app's folders survived a delete, so their presence "
                                             + "later would prove nothing")

        // ── LAUNCH TWO. No password anywhere. This is the whole slice. ────────────────────────
        let second = try planALaunch()
        XCTAssertEqual(second.key, first.key, "the Keychain handed back a different key on relaunch")
        XCTAssertNil(ProcessInfo.processInfo.environment["OHMAIL_IMAP_PASS"],
                     "a password in the environment would open the mailbox on its own")

        let (engine2, bridge2, _) = try serve(second.launch)
        let (health2, healthBody2) = try await get("/health", bridge2)
        XCTAssertEqual(health2, 200)
        XCTAssertEqual((healthBody2["kek"] as? [String: Any])?["fingerprint"] as? String, fingerprint,
                       "the relaunched install is running on a different key")

        let reopened = try waitForAppFolders("the relaunched install to log in", within: 120)
        XCTAssertFalse(reopened.isEmpty,
                       "the relaunched install never authenticated: the server shows no folders of "
                       + "ours, so the stored password was not opened by the stored key")
        stop(engine2)

        // ── LAUNCH THREE, UNDER A DIFFERENT KEY. ─────────────────────────────────────────────
        //
        // Without this the test would pass for a mailbox that opens for some reason other than the
        // sealed credential — a password cached in the mirror, a server that stopped asking. A key
        // that cannot open the stored row must leave the mailbox shut.
        try deleteAppFolders()
        XCTAssertTrue(try store.forget())
        let third = try planALaunch()
        XCTAssertNotEqual(third.key, first.key, "the Keychain returned the key that was just deleted")

        let (engine3, bridge3, ready3) = try serve(third.launch)
        let (health3, healthBody3) = try await get("/health", bridge3)
        XCTAssertEqual(health3, 200, "an install that cannot open its own credential still serves the mirror")
        XCTAssertNotEqual((healthBody3["kek"] as? [String: Any])?["fingerprint"] as? String, fingerprint,
                          "the key ring did not change when the key did")
        XCTAssertEqual(try waitForAppFolders("nothing", within: 20), [],
                       "the mailbox opened under a key that cannot decrypt the stored password")

        // ── AND THE PROMPT IS ALL IT COSTS. The password is typed again, and the mailbox opens. ─
        let (again, againBody) = try await enterPassword(imapPassword, mailbox: ready3.mailboxID,
                                                         session: ready3.sessionToken, bridge3)
        XCTAssertEqual(again, 200, "re-entering the password after losing the key was refused: \(againBody)")
        stop(engine3)

        let fourth = try planALaunch()
        XCTAssertEqual(fourth.key, third.key)
        let (engine4, _, _) = try serve(fourth.launch)
        XCTAssertFalse(try waitForAppFolders("the mailbox to open again", within: 120).isEmpty,
                       "a lost key was not recoverable by re-entering the password")
        stop(engine4)

        // ── AND THE KEY IS NOWHERE ON DISK. ──────────────────────────────────────────────────
        try assertTheKeyIsNotOnDisk(first.key, control: "the first install's key")
        try assertTheKeyIsNotOnDisk(third.key, control: "the replacement key")
    }

    /// **A wrong password is refused by the server, not stored and apologised for later.**
    ///
    /// This assertion is only written because the server on ``imapPort`` can refuse one. Against the
    /// permissive development server it could not fail, and a test that cannot fail is worse than no
    /// test — it reads as coverage.
    func testAWrongPasswordIsRefusedByTheServer() async throws {
        let launch = try planALaunch()
        let (engine, bridge, ready) = try serve(launch.launch)
        defer { engine.stop() }

        let (status, body) = try await enterPassword("definitely-not-\(imapPassword)",
                                                     mailbox: ready.mailboxID,
                                                     session: ready.sessionToken, bridge)
        XCTAssertNotEqual(status, 200, "a password the server rejects was accepted and stored: \(body)")
        XCTAssertTrue(body.contains("auth"),
                      "the refusal does not say the server rejected the credentials: \(body)")
        XCTAssertFalse(body.contains("definitely-not-"), "the refusal quoted the password back: \(body)")

        // And the right one, through the same route, is accepted — so the refusal above is about the
        // password rather than about the route being broken.
        let (accepted, acceptedBody) = try await enterPassword(imapPassword, mailbox: ready.mailboxID,
                                                               session: ready.sessionToken, bridge)
        XCTAssertEqual(accepted, 200, "the correct password was refused too: \(acceptedBody)")
        stop(engine)
    }

    // MARK: - Where the key is not

    /// **Nothing this app writes contains the key** — asked of the bytes on disk, not of a type.
    ///
    /// Redaction on the type that holds a secret is not the same claim: a value can be printed by
    /// something that walks its parent instead. So this greps the mirror the engine built and the
    /// directory a Mac app keeps its state in, for the key itself.
    ///
    /// The control is what makes it evidence. A file containing the key is planted, found, and
    /// removed — so a scan that finds nothing afterwards is a scan that would have found something.
    private func assertTheKeyIsNotOnDisk(_ key: String, control: String,
                                         file: StaticString = #filePath, line: UInt = #line) throws {
        let canary = dataDirectory.appendingPathComponent("scan-canary.txt")
        try Data("a file that really does contain it: \(key)\n".utf8).write(to: canary)
        XCTAssertFalse(try grep(key, under: dataDirectory).isEmpty,
                       "the scan cannot find the key even when it is there, so finding nothing "
                       + "proves nothing (\(control))", file: file, line: line)
        try FileManager.default.removeItem(at: canary)

        for place in [dataDirectory!, directory!] + appStateDirectories() {
            let hits = try grep(key, under: place)
            XCTAssertEqual(hits, [], "\(control) was written to disk under \(place.path)",
                           file: file, line: line)
        }
    }

    /// Everything this app keeps outside its mirror: its own directory under Application Support —
    /// which is where the shell writes `config.json` — and its preferences.
    ///
    /// Scoped to the app's own state rather than the whole of Application Support, which on a real
    /// machine is tens of gigabytes belonging to other software. What matters is what THIS app
    /// writes; a key found under somebody else's application would not be this app's doing.
    private func appStateDirectories() -> [URL] {
        let library = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library")
        var places: [URL] = []
        for parent in ["Application Support", "Preferences", "Caches", "Containers"] {
            let root = library.appendingPathComponent(parent)
            let children = (try? FileManager.default.contentsOfDirectory(atPath: root.path)) ?? []
            for child in children where child.lowercased().contains("ohmail") {
                places.append(root.appendingPathComponent(child))
            }
        }
        return places
    }

    /// Every file under `root` containing `needle`.
    ///
    /// `/usr/bin/grep` by absolute path and `-a`: a shell's `grep` here can be a wrapper that skips
    /// any file it decides is binary, and a mirror full of database pages is exactly that — a scan
    /// that silently skipped every file it should have read would report the same empty list as a
    /// clean one.
    private func grep(_ needle: String, under root: URL) throws -> [String] {
        guard FileManager.default.fileExists(atPath: root.path) else { return [] }
        let run = Process()
        run.executableURL = URL(fileURLWithPath: "/usr/bin/grep")
        run.arguments = ["-a", "-r", "-l", "-F", needle, root.path]
        let out = Pipe()
        run.standardOutput = out
        run.standardError = FileHandle.nullDevice
        try run.run()
        let found = out.fileHandleForReading.readDataToEndOfFile()
        run.waitUntilExit()
        // 0 = found, 1 = nothing found, anything else = the scan itself failed.
        guard run.terminationStatus <= 1 else {
            throw Failure("the scan of \(root.path) failed with status \(run.terminationStatus)")
        }
        return String(decoding: found, as: UTF8.self)
            .split(separator: "\n").map(String.init)
    }

    /// Anything that looks like a key: 64 hexadecimal characters in a row.
    private func keyShapedRuns(in text: String) -> [String] {
        let pattern = try? NSRegularExpression(pattern: "[0-9a-fA-F]{64}")
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        return (pattern?.matches(in: text, range: range) ?? []).compactMap {
            Range($0.range, in: text).map { String(text[$0]) }
        }
    }

    /// **The key never reaches a whole process's output, across a launch and a quit.**
    ///
    /// The in-process assertions above cannot see this: a test bundle shares its streams with every
    /// other test in the run. This starts the engine-only shell, lets it run and quit by itself, and
    /// reads every byte it wrote to both streams — the ones a crash report and a support bundle
    /// pick up.
    ///
    /// ── IT DOES NOT ASK THE KEYCHAIN WHAT THE KEY IS, AND IT MUST NOT ─────────────────────────
    ///
    /// The shell that runs here is a DIFFERENT BINARY from this test bundle, and the keychain ties
    /// an item to the program that created it: this process reading the item that one minted stops
    /// on an authorization dialog and never returns. The first version of this test did exactly
    /// that and wedged the whole run. So it looks for the SHAPE instead — sixty-four hex characters
    /// in a row, which is what a key is and what nothing else in this output is — and the scanner is
    /// controlled against a string that really is one.
    ///
    /// The item that shell minted is left behind. It is named for this run alone and nothing will
    /// ever read it again; removing it is refused, for the same reason reading it would have
    /// prompted.
    func testTheKeyNeverReachesAWholeProcessesOutput() throws {
        let bundle = Bundle(for: type(of: self)).bundleURL.deletingLastPathComponent()
        let shell = bundle.appendingPathComponent("ohmail-engine-probe")
        guard FileManager.default.isExecutableFile(atPath: shell.path) else {
            throw XCTSkip("the engine-only shell was not built beside the test bundle")
        }

        let run = Process()
        run.executableURL = shell
        run.arguments = [wrapper.path]
        var environment = ProcessInfo.processInfo.environment
        environment[DATA_DIR_VAR] = dataDirectory.path
        environment[KeychainKeyStore.serviceVariable] = keychainService
        environment.removeValue(forKey: KEK_VAR)
        environment["OHMAIL_PROBE_QUIT_AFTER_MS"] = "300"
        run.environment = environment

        let out = Pipe()
        let err = Pipe()
        run.standardOutput = out
        run.standardError = err
        try run.run()
        let printed = String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        let logged = String(decoding: err.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        run.waitUntilExit()

        // The shell reached `serving`, which means it composed a key for the engine — so there was
        // something to leak, and this capture is of a run that had it.
        XCTAssertTrue(printed.contains("serving "),
                      "this run never got as far as serving, so finding nothing in it proves "
                      + "nothing:\n\(printed)\n\(logged)")
        XCTAssertEqual(run.terminationStatus, 0, "the shell quit cleanly")

        // The scanner works: given output that really does contain a key, it says so.
        let canary = String(repeating: "abcdef01", count: 8)
        XCTAssertEqual(keyShapedRuns(in: printed + "\n" + canary), [canary],
                       "the scan cannot find a key even when one is there")

        XCTAssertEqual(keyShapedRuns(in: printed), [],
                       "something key-shaped reached the shell's report:\n\(printed)")
        XCTAssertEqual(keyShapedRuns(in: logged), [],
                       "something key-shaped reached the shell's log:\n\(logged)")
    }
}
