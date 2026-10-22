import UIKit

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    var root: ViewController?

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        window = UIWindow(frame: UIScreen.main.bounds)
        root = ViewController()
        window?.rootViewController = root
        window?.makeKeyAndVisible()
        return true
    }

    // xianlumap://route=<id> 直达线路；其余 query 参数原样透传（?enr=1/?sup=1 调试钩子）
    func application(_ app: UIApplication, open url: URL,
                     options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        guard url.scheme == "xianlumap" else { return false }
        let comp = URLComponents(url: url, resolvingAgainstBaseURL: false)
        let route = comp?.queryItems?.first(where: { $0.name == "route" })?.value
        root?.loadRoute(route, extras: comp?.queryItems ?? [])
        return true
    }
}
