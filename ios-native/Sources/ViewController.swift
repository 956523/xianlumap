import UIKit
import WebKit
import CoreLocation

class ViewController: UIViewController, WKNavigationDelegate, CLLocationManagerDelegate {
    var webView: WKWebView!
    let locManager = CLLocationManager()

    override func viewDidLoad() {
        super.viewDidLoad()
        let prefs = WKPreferences()
        prefs.javaScriptEnabled = true
        let cfg = WKWebViewConfiguration()
        cfg.preferences = prefs
        if let www = Bundle.main.resourceURL?.appendingPathComponent("www") {
            
        }
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
    func loadRoute(_ routeId: String?) {
        var comp = URLComponents(string: "https://xianlumap-dev.ok.kimi.link/")!
        if let r = routeId, !r.isEmpty {
            comp.queryItems = [URLQueryItem(name: "route", value: r)]
        }
        webView.load(URLRequest(url: comp.url!))
    }

    func locationManager(_ manager: CLLocationManager, didChangeAuthorization status: CLAuthorizationStatus) {}
}
