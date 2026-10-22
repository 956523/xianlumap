import UIKit
import WebKit
import CoreLocation

class ViewController: UIViewController, WKNavigationDelegate, CLLocationManagerDelegate, WKScriptMessageHandler {
    var webView: WKWebView!
    let locManager = CLLocationManager()

    override func viewDidLoad() {
        super.viewDidLoad()
        let prefs = WKPreferences()
        prefs.javaScriptEnabled = true
        let cfg = WKWebViewConfiguration()
        cfg.preferences = prefs
        // S36 定位桥：document start 在 mainWorld 注入原生标记，
        // web 侧（engine/enroute.js）据此走 __xlmGeo 原生定位，替代被禁的 navigator.geolocation
        let marker = WKUserScript(source: "window.__xlmNative=true;",
                                  injectionTime: .atDocumentStart,
                                  forMainFrameOnly: false)
        cfg.userContentController.addUserScript(marker)
        cfg.userContentController.add(self, name: "xlm")
        webView = WKWebView(frame: view.bounds, configuration: cfg)
        webView.navigationDelegate = self
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        view.addSubview(webView)

        locManager.delegate = self
        if #available(iOS 14.0, *) {
            if locManager.authorizationStatus == .notDetermined { locManager.requestWhenInUseAuthorization() }
        } else {
            if CLLocationManager.authorizationStatus() == .notDetermined { locManager.requestWhenInUseAuthorization() }
        }

        loadRoute(nil)
    }

    // routeId 为 nil 时进选线器首页
    // 开发期指向 Mac 本地服务（en1 局域网 IP，模拟器/同 WiFi 真机可用）；
    // 发版切托管站点 https://xianlumap-dev.ok.kimi.link
    static let baseURL = "http://192.168.1.108:8000/index.html"

    func loadRoute(_ routeId: String?, extras: [URLQueryItem] = []) {
        var comp = URLComponents(string: ViewController.baseURL)!
        comp.queryItems = extras.filter { $0.name != "route" }
        if let r = routeId, !r.isEmpty {
            comp.queryItems = (comp.queryItems ?? []) + [URLQueryItem(name: "route", value: r)]
        }
        webView.load(URLRequest(url: comp.url!))
    }

    // MARK: - JS 桥（S36 行中定位）
    /* web → 原生：window.webkit.messageHandlers.xlm.postMessage({action:"geo",on:true|false})
       行中进入/退出时启停 CLLocationManager（省电同源口径） */
    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              body["action"] as? String == "geo" else { return }
        if body["on"] as? Bool == true {
            locManager.startUpdatingLocation()
        } else {
            locManager.stopUpdatingLocation()
        }
    }

    /* 原生 → web：window.__xlmGeo(lat, lng)
       Double 字面量直接拼接（Swift 插值恒为点号小数，无需转义）；0,0 哨兵坐标丢弃 */
    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let loc = locations.last else { return }
        let lat = loc.coordinate.latitude
        let lng = loc.coordinate.longitude
        if lat == 0 && lng == 0 { return }
        webView?.evaluateJavaScript("window.__xlmGeo&&__xlmGeo(\(lat),\(lng))")
    }

    func locationManager(_ manager: CLLocationManager, didChangeAuthorization status: CLAuthorizationStatus) {}
}
