// 山海一线 App 图标生成器：CoreGraphics 矢量绘制 → 1024/180/167/152/120 PNG
import AppKit

let S = CGSize(width: 1024, height: 1024)
func draw(_ size: CGSize, _ path: String) {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size.width), pixelsHigh: Int(size.height),
                               bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                               colorSpaceName: .calibratedRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let ink = NSColor(white: 0.06, alpha: 1)
    ink.setStroke()
    // 山：折线（和 logo.js 同形）
    let m = NSBezierPath()
    m.lineWidth = size.width * 0.055
    m.lineCapStyle = .round; m.lineJoinStyle = .round
    let pts = [(0.10,0.52),(0.31,0.27),(0.46,0.42),(0.60,0.19),(0.77,0.37),(0.90,0.52)]
    m.move(to: CGPoint(x: pts[0].0*size.width, y: pts[0].1*size.height))
    for p in pts.dropFirst() { m.line(to: CGPoint(x: p.0*size.width, y: p.1*size.height)) }
    m.stroke()
    // 海：两道波
    for (yy, alpha) in [(0.63,1.0),(0.74,0.85)] {
        let w = NSBezierPath()
        w.lineWidth = size.width * 0.045; w.lineCapStyle = .round
        ink.withAlphaComponent(alpha).setStroke()
        let x0 = 0.16*size.width, seg = 0.185*size.width, y = yy*size.height, amp = 0.045*size.height
        w.move(to: CGPoint(x: x0, y: y))
        for i in 0..<4 {
            let cx = x0 + CGFloat(i)*seg + seg/2, ex = x0 + CGFloat(i+1)*seg
            w.curve(to: CGPoint(x: ex, y: y), controlPoint1: CGPoint(x: cx, y: y+amp), controlPoint2: CGPoint(x: cx, y: y+amp))
        }
        w.stroke()
    }
    NSGraphicsContext.restoreGraphicsState()
    let data = rep.representation(using: .png, properties: [:])!
    try! data.write(to: URL(fileURLWithPath: path))
}
let here = FileManager.default.currentDirectoryPath + "/Sources/Assets.xcassets/AppIcon.appiconset"
draw(S, here + "/icon-1024.png")
for sz in [180, 167, 152, 120] { draw(CGSize(width: sz, height: sz), here + "/icon-\(sz).png") }
print("icons regenerated")
