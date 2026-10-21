import Foundation
import Network

final class MiniServer {
    private let listener: NWListener
    private let root: URL

    init?(root: URL) {
        self.root = root.standardizedFileURL
        guard let port = NWEndpoint.Port(rawValue: 8123) else { return nil }
        do { listener = try NWListener(using: .tcp, on: port) } catch { return nil }
    }

    func start() {
        let sem = DispatchSemaphore(value: 0)
        listener.stateUpdateHandler = { st in
            if st == .ready { sem.signal() }
        }
        listener.newConnectionHandler = { [weak self] conn in
            conn.start(queue: .global())
            self?.handle(conn)
        }
        listener.start(queue: .global())
        _ = sem.wait(timeout: .now() + 3)
    }

    private func handle(_ conn: NWConnection) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, _, _ in
            guard let self = self, let data = data, let req = String(data: data, encoding: .utf8) else { conn.cancel(); return }
            let line = req.components(separatedBy: "\r\n").first ?? ""
            let parts = line.split(separator: " ")
            guard parts.count >= 2 else { conn.cancel(); return }
            var path = String(parts[1])
            if path.hasPrefix("http://"), let u = URL(string: path) { path = u.path }
            if path == "/" { path = "/index.html" }
            let clean = self.root.appendingPathComponent(path).standardizedFileURL.path
            guard clean.hasPrefix(self.root.path) else { self.respond(conn, 403, Data()); return }
            var isDir: ObjCBool = false
            let fm = FileManager.default
            guard fm.fileExists(atPath: clean, isDirectory: &isDir), !isDir.boolValue,
                  let body = fm.contents(atPath: clean) else { self.respond(conn, 404, Data()); return }
            let ext = (clean as NSString).pathExtension.lowercased()
            let mime = ["html": "text/html; charset=utf-8", "js": "application/javascript", "css": "text/css",
                        "svg": "image/svg+xml", "json": "application/json", "png": "image/png",
                        "webmanifest": "application/manifest+json"][ext] ?? "application/octet-stream"
            let head = "HTTP/1.1 200 OK\r\nContent-Type: \(mime)\r\nContent-Length: \(body.count)\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n"
            var resp = Data(head.utf8); resp.append(body)
            conn.send(content: resp, completion: .contentProcessed { _ in conn.cancel() })
        }
    }

    private func respond(_ conn: NWConnection, _ code: Int, _ body: Data) {
        let head = "HTTP/1.1 \(code)\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n"
        var resp = Data(head.utf8); resp.append(body)
        conn.send(content: resp, completion: .contentProcessed { _ in conn.cancel() })
    }
}
