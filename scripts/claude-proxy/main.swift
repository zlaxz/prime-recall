import Foundation

import Cocoa

// ============================================================
// Claude Proxy — Headless macOS GUI app
//
// Runs as a background app (no dock icon, no menu bar, no windows).
// Has GUI session context → Keychain access → claude -p works.
// Listens on localhost:3211 for HTTP POST requests.
//
// POST /claude  { "prompt": "...", "timeout": 300, "args": ["--resume", "UUID"] }
// Returns:      { "result": "...", "session_id": "..." }
//
// Install: compile + launchd plist with RunAtLoad
// ============================================================

class ProxyDelegate: NSObject, NSApplicationDelegate {
    var server: HTTPServer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Ignore SIGPIPE globally — prevents crash when HTTP clients disconnect
        signal(SIGPIPE, SIG_IGN)
        server = HTTPServer(port: 3211)
        server?.start()
        print("[claude-proxy] Listening on http://localhost:3211")
    }
}

class HTTPServer {
    let port: UInt16
    var socket: Int32 = -1

    init(port: UInt16) { self.port = port }

    func start() {
        socket = Darwin.socket(AF_INET, SOCK_STREAM, 0)
        var opt: Int32 = 1
        setsockopt(socket, SOL_SOCKET, SO_REUSEADDR, &opt, socklen_t(MemoryLayout<Int32>.size))

        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = port.bigEndian
        addr.sin_addr.s_addr = INADDR_LOOPBACK.bigEndian

        withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                bind(socket, sa, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        listen(socket, 10)

        DispatchQueue.global().async { [weak self] in
            while let self = self {
                var clientAddr = sockaddr_in()
                var clientLen = socklen_t(MemoryLayout<sockaddr_in>.size)
                let client = withUnsafeMutablePointer(to: &clientAddr) { ptr in
                    ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                        accept(self.socket, sa, &clientLen)
                    }
                }
                if client >= 0 {
                    DispatchQueue.global().async { self.handleClient(client) }
                }
            }
        }
    }

    func handleClient(_ fd: Int32) {
        var buf = [UInt8](repeating: 0, count: 1_000_000)
        let n = read(fd, &buf, buf.count)
        guard n > 0 else { close(fd); return }

        let raw = String(bytes: buf[..<n], encoding: .utf8) ?? ""

        // Parse HTTP request — extract body after \r\n\r\n
        guard let bodyStart = raw.range(of: "\r\n\r\n") else {
            sendResponse(fd, status: 400, body: "{\"error\":\"bad request\"}")
            return
        }
        let body = String(raw[bodyStart.upperBound...])

        // Health check
        if raw.hasPrefix("GET /health") {
            sendResponse(fd, status: 200, body: "{\"status\":\"ok\"}")
            return
        }

        // Route: POST /prime — Direct conversational interface to Prime
        if raw.hasPrefix("POST /prime") || raw.hasPrefix("POST /cos") {
            guard let data = body.data(using: .utf8),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let message = json["message"] as? String else {
                sendResponse(fd, status: 400, body: "{\"error\":\"missing message\"}")
                return
            }

            let sessionId = json["session_id"] as? String
            let timeout = json["timeout"] as? Int ?? 300  // 5 min default for strategic questions with tool use

            // Build args: always use MCP, allow enough turns for tool calls + response
            var args = ["-p", "--output-format", "json", "--max-turns", "50"]

            // Resume existing session or start fresh
            if let sid = sessionId, !sid.isEmpty {
                args += ["--resume", sid]
            }

            // Load MCP config
            let mcpConfig = NSHomeDirectory() + "/.claude/.mcp.json"
            if FileManager.default.fileExists(atPath: mcpConfig) {
                args += ["--mcp-config", mcpConfig]
            }

            // System prompt for Prime identity
            let primePrompt = sessionId != nil ? message :
                """
                You are Prime — Zach Stock's AI Chief of Staff. You run on a Mac Mini with 8K+ knowledge items, entity graph, and strategic intelligence cycle.

                You have direct access to the entire business intelligence system via tools. When Zach asks about business, projects, or people:
                1. Call the relevant tool (prime_briefing, prime_entity, prime_simulate, prime_shadow_board, prime_ripple, prime_search, prime_ask)
                2. Present the intelligence clearly and directly
                3. Only add strategic analysis when asked to think deeper

                STRATEGIC QUESTIONS (when Zach says "think about this", "what should I do", or asks about decisions with stakes):
                Don't commit to one frame. Instead:
                1. Name 2-3 ways to see this problem. Hold them simultaneously.
                2. Note where they CONFLICT. The conflict is often the insight.
                3. Pull data from Prime tools to see which frame the evidence supports.
                4. If the tension itself is the valuable insight, say that. Don't resolve it artificially.
                5. Ask: "Where's your gut on this?" — one sentence from Zach should resolve it.

                SIMPLE QUESTIONS ("what time is my meeting", "who emailed me") get direct answers. No multi-frame overhead.

                You are not Claude acting as Prime. You ARE Prime — the accumulated intelligence, persistent memory, and strategic reasoning of this system.

                Zach says: \(message)
                """

            let proc = Process()
            proc.executableURL = URL(fileURLWithPath: "/opt/homebrew/bin/claude")
            proc.arguments = args
            proc.environment = ProcessInfo.processInfo.environment

            let stdinPipe = Pipe()
            let stdoutPipe = Pipe()
            let stderrPipe = Pipe()
            proc.standardInput = stdinPipe
            proc.standardOutput = stdoutPipe
            proc.standardError = stderrPipe

            do {
                try proc.run()
                stdinPipe.fileHandleForWriting.write(primePrompt.data(using: .utf8)!)
                stdinPipe.fileHandleForWriting.closeFile()

                let deadline = DispatchTime.now() + .seconds(timeout)
                let sem = DispatchSemaphore(value: 0)
                DispatchQueue.global().async { proc.waitUntilExit(); sem.signal() }

                if sem.wait(timeout: deadline) == .timedOut {
                    proc.terminate()
                    sendResponse(fd, status: 504, body: "{\"error\":\"timeout\"}")
                    return
                }

                let stdout = stdoutPipe.fileHandleForReading.readDataToEndOfFile()
                let output = String(data: stdout, encoding: .utf8) ?? ""

                if let jsonData = output.data(using: .utf8),
                   let envelope = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any] {
                    let result = envelope["result"] as? String ?? output
                    let newSessionId = envelope["session_id"] as? String ?? sessionId ?? ""
                    let responseJSON = try! JSONSerialization.data(withJSONObject: [
                        "content": result,
                        "session_id": newSessionId,
                    ])
                    sendResponse(fd, status: 200, body: String(data: responseJSON, encoding: .utf8)!)
                } else {
                    sendResponse(fd, status: 200, body: "{\"content\":\"\(output.prefix(5000))\",\"session_id\":\"\"}")
                }
            } catch {
                sendResponse(fd, status: 500, body: "{\"error\":\"\(error.localizedDescription)\"}")
            }
            return
        }

        // Route: POST /claude — Raw claude -p call (for dream pipeline)
        guard raw.hasPrefix("POST /claude") else {
            // List sessions
            if raw.hasPrefix("GET /sessions") {
                sendResponse(fd, status: 200, body: "{\"note\":\"session management via /cos endpoint\"}")
                return
            }
            sendResponse(fd, status: 404, body: "{\"error\":\"not found. Use POST /cos for COS chat, POST /claude for raw calls.\"}")
            return
        }

        // Parse JSON body
        guard let data = body.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let prompt = json["prompt"] as? String else {
            sendResponse(fd, status: 400, body: "{\"error\":\"missing prompt\"}")
            return
        }

        let timeout = json["timeout"] as? Int ?? 300
        let extraArgs = json["args"] as? [String] ?? []
        let isBackground = json["background"] as? Bool ?? false

        // Build claude -p command
        // Allow enough turns for tool use (web search, MCP calls)
        let maxTurns = (extraArgs.contains("--max-turns")) ? [] : ["--max-turns", "50"]
        var args = ["-p", "--output-format", "json"] + maxTurns + extraArgs

        // Load MCP config if available
        let mcpConfig = NSHomeDirectory() + "/.claude/.mcp.json"
        if FileManager.default.fileExists(atPath: mcpConfig) {
            args += ["--mcp-config", mcpConfig]
        }

        // Background mode: spawn claude, respond immediately with 202, don't wait
        if isBackground {
            let proc = Process()
            proc.executableURL = URL(fileURLWithPath: "/opt/homebrew/bin/claude")
            proc.arguments = args
            proc.environment = ProcessInfo.processInfo.environment

            let stdinPipe = Pipe()
            proc.standardInput = stdinPipe
            proc.standardOutput = FileHandle.nullDevice
            proc.standardError = FileHandle.nullDevice

            do {
                try proc.run()
                stdinPipe.fileHandleForWriting.write(prompt.data(using: .utf8)!)
                stdinPipe.fileHandleForWriting.closeFile()
                print("[claude-proxy] Background agent spawned (pid \(proc.processIdentifier))")
                sendResponse(fd, status: 202, body: "{\"status\":\"spawned\",\"pid\":\(proc.processIdentifier)}")
            } catch {
                sendResponse(fd, status: 500, body: "{\"error\":\"\(error.localizedDescription)\"}")
            }
            return
        }

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/opt/homebrew/bin/claude")
        proc.arguments = args
        proc.environment = ProcessInfo.processInfo.environment

        let stdinPipe = Pipe()
        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        proc.standardInput = stdinPipe
        proc.standardOutput = stdoutPipe
        proc.standardError = stderrPipe

        do {
            try proc.run()
            stdinPipe.fileHandleForWriting.write(prompt.data(using: .utf8)!)
            stdinPipe.fileHandleForWriting.closeFile()

            // Wait with timeout
            let deadline = DispatchTime.now() + .seconds(timeout)
            let sem = DispatchSemaphore(value: 0)
            DispatchQueue.global().async {
                proc.waitUntilExit()
                sem.signal()
            }

            if sem.wait(timeout: deadline) == .timedOut {
                proc.terminate()
                sendResponse(fd, status: 504, body: "{\"error\":\"timeout after \(timeout)s\"}")
                return
            }

            let stdout = stdoutPipe.fileHandleForReading.readDataToEndOfFile()
            let output = String(data: stdout, encoding: .utf8) ?? ""

            // Try to parse JSON envelope
            if let jsonData = output.data(using: .utf8),
               let envelope = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any] {
                let result = envelope["result"] as? String ?? output
                let sessionId = envelope["session_id"] as? String ?? ""
                let responseJSON = try! JSONSerialization.data(withJSONObject: [
                    "result": result,
                    "session_id": sessionId,
                    "exit_code": proc.terminationStatus
                ])
                sendResponse(fd, status: 200, body: String(data: responseJSON, encoding: .utf8)!)
            } else {
                // Raw text response
                let escaped = output.replacingOccurrences(of: "\\", with: "\\\\")
                    .replacingOccurrences(of: "\"", with: "\\\"")
                    .replacingOccurrences(of: "\n", with: "\\n")
                sendResponse(fd, status: 200, body: "{\"result\":\"\(escaped)\",\"session_id\":\"\",\"exit_code\":\(proc.terminationStatus)}")
            }
        } catch {
            sendResponse(fd, status: 500, body: "{\"error\":\"\(error.localizedDescription)\"}")
        }
    }

    func sendResponse(_ fd: Int32, status: Int, body: String) {
        let statusText = status == 200 ? "OK" : status == 202 ? "Accepted" : status == 400 ? "Bad Request" : status == 404 ? "Not Found" : status == 504 ? "Gateway Timeout" : "Error"
        let response = "HTTP/1.1 \(status) \(statusText)\r\nContent-Type: application/json\r\nContent-Length: \(body.utf8.count)\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n\(body)"
        write(fd, response, response.utf8.count)
        close(fd)
    }
}

// ── Launch as headless GUI app ──
let app = NSApplication.shared
let delegate = ProxyDelegate()
app.delegate = delegate
app.setActivationPolicy(.prohibited)  // No dock icon, no menu bar
app.run()
