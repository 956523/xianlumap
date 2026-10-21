import Foundation
import WebKit

// WKURLSchemeHandler：拦截 http://localhost/* → 安装包 www 目录；
// 其余 http(s) 请求（高德瓦片/JS API 等）→ URLSession 透明代理。
// 与 Capacitor 同构的正规机制：无 socket、无 ATS 问题、localhost = 安全上下文（定位/SW 可用）。
final class LocalSchemeHandler: NSObject, WKURLSchemeHandler {
    private let root: URL
    private let session = URLSession(configuration: .default)

    init(root: URL) { self.root = root }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        let url = urlSchemeTask.request.url!
        if url.host == "localhost" || url.host == "127.0.0.1" {
            serveLocal(url, task: urlSchemeTask)
        } else {
            proxy(url, task: urlSchemeTask)
        }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        urlSchemeTask.didFailWithError(NSError(domain: "cancelled", code: -999))
    }

    private func serveLocal(_ url: URL, task: WKURLSchemeTask) {
        var path = url.path
        if path == "/" { path = "/index.html" }
        let clean = root.appendingPathComponent(path).standardizedFileURL.path
        var isDir: ObjCBool = false
        guard clean.hasPrefix(root.standardizedFileURL.path),
              FileManager.default.fileExists(atPath: clean, isDirectory: &isDir), !isDir.boolValue,
              let body = FileManager.default.contents(atPath: clean) else {
            task.didFailWithError(NSError(domain: "local404", code: 404, userInfo: [NSLocalizedDescriptionKey: "not found: \(path)"]))
            return
        }
        let ext = (clean as NSString).pathExtension.lowercased()
        let mime = ["html": "text/html; charset=utf-8", "js": "application/javascript", "css": "text/css",
                    "svg": "image/svg+xml", "json": "application/json", "png": "image/png",
                    "webmanifest": "application/manifest+json"][ext] ?? "application/octet-stream"
        let resp = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1",
                                   headerFields: ["Content-Type": mime, "Content-Length": "\(body.count)", "Cache-Control": "no-store"])
        task.didReceive(resp!)
        task.didReceive(body)
        task.didFinish()
    }

    private func proxy(_ url: URL, task: WKURLSchemeTask) {
        var req = URLRequest(url: url)
        req.httpMethod = task.request.httpMethod
        req.allHTTPHeaderFields = task.request.allHTTPHeaderFields
        let dataTask = session.dataTask(with: req) { data, resp, error in
            if let error = error { task.didFailWithError(error); return }
            if let resp = resp {
                task.didReceive(resp)
                if let data = data { task.didReceive(data) }
                task.didFinish()
            }
        }
        dataTask.resume()
    }
}
