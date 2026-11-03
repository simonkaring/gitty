// macOS measurement helper for scripts/bench/apps.mjs. Compiled on demand with
// `swiftc -O`; prints one JSON document per invocation.
//
//   probe tree <pid>
//     The process, its descendants and every process macOS attributes to it
//     (WebKit and other XPC services have launchd as parent but the app as their
//     "responsible" process). Footprint matches Activity Monitor's Memory column;
//     CPU times include reaped children such as short-lived git processes.
//
//   probe watch <pid> <launchEpochMs> <timeoutMs> <settleMs> <threshold>
//     Waits for the app's first on-screen window, then captures small grayscale
//     thumbnails of it and reports when it last changed visibly before staying
//     unchanged for <settleMs> ("visually complete"). Needs Screen Recording
//     permission for the terminal.
import CoreGraphics
import Darwin
import Foundation
import ScreenCaptureKit

typealias ResponsibleFn = @convention(c) (pid_t) -> pid_t
let responsibleFn: ResponsibleFn? = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_get_pid_responsible_for_pid")
  .map { unsafeBitCast($0, to: ResponsibleFn.self) }

let timebase: mach_timebase_info_data_t = {
  var value = mach_timebase_info_data_t()
  mach_timebase_info(&value)
  return value
}()
func ticksToNs(_ value: UInt64) -> UInt64 { value * UInt64(timebase.numer) / UInt64(timebase.denom) }

struct Proc { let pid: pid_t; let ppid: pid_t; let name: String }

func allProcesses() -> [Proc] {
  let count = proc_listallpids(nil, 0)
  var pids = [pid_t](repeating: 0, count: Int(count) * 2)
  let n = pids.withUnsafeMutableBufferPointer { proc_listallpids($0.baseAddress, Int32($0.count * MemoryLayout<pid_t>.size)) }
  return pids.prefix(Int(n)).compactMap { pid in
    var info = proc_bsdinfo()
    let size = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, Int32(MemoryLayout<proc_bsdinfo>.size))
    guard size == MemoryLayout<proc_bsdinfo>.size else { return nil }
    let name = withUnsafeBytes(of: info.pbi_name) { String(decoding: $0.prefix(while: { $0 != 0 }), as: UTF8.self) }
    return Proc(pid: pid, ppid: pid_t(info.pbi_ppid), name: name)
  }
}

func related(to root: pid_t) -> [Proc] {
  let procs = allProcesses()
  var members: Set<pid_t> = [root]
  var changed = true
  while changed {
    changed = false
    for p in procs where !members.contains(p.pid) {
      if members.contains(p.ppid) || responsibleFn?(p.pid) == root { members.insert(p.pid); changed = true }
    }
  }
  return procs.filter { members.contains($0.pid) }
}

func usage(_ p: Proc) -> [String: Any] {
  var info = rusage_info_v4()
  let ok = withUnsafeMutablePointer(to: &info) {
    $0.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { proc_pid_rusage(p.pid, RUSAGE_INFO_V4, $0) }
  } == 0
  var result: [String: Any] = ["pid": p.pid, "ppid": p.ppid, "name": p.name]
  if ok {
    result["footprint"] = info.ri_phys_footprint
    result["cpuNs"] = ticksToNs(info.ri_user_time + info.ri_system_time)
    result["childCpuNs"] = ticksToNs(info.ri_child_user_time + info.ri_child_system_time)
  }
  return result
}

func printJSON(_ value: Any) {
  let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

func nowMs() -> Double { Date().timeIntervalSince1970 * 1000 }

/// Largest normal-layer on-screen window owned by any process related to root.
func mainWindow(root: pid_t) -> (id: CGWindowID, width: Double, height: Double)? {
  let pids = Set(related(to: root).map { $0.pid })
  guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
  return list.compactMap { w -> (CGWindowID, Double, Double)? in
    guard let owner = w[kCGWindowOwnerPID as String] as? pid_t, pids.contains(owner),
          (w[kCGWindowLayer as String] as? Int) == 0,
          let id = w[kCGWindowNumber as String] as? CGWindowID,
          let bounds = w[kCGWindowBounds as String] as? [String: Double],
          let width = bounds["Width"], let height = bounds["Height"], width >= 300, height >= 200 else { return nil }
    return (id, width, height)
  }.max { $0.1 * $0.2 < $1.1 * $1.2 }.map { (id: $0.0, width: $0.1, height: $0.2) }
}

let thumbWidth = 160, thumbHeight = 100

func thumbnail(_ image: CGImage) -> [UInt8] {
  var pixels = [UInt8](repeating: 0, count: thumbWidth * thumbHeight)
  pixels.withUnsafeMutableBytes { buffer in
    let context = CGContext(data: buffer.baseAddress, width: thumbWidth, height: thumbHeight, bitsPerComponent: 8, bytesPerRow: thumbWidth,
                            space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue)!
    context.interpolationQuality = .medium
    context.draw(image, in: CGRect(x: 0, y: 0, width: thumbWidth, height: thumbHeight))
  }
  return pixels
}

func difference(_ a: [UInt8], _ b: [UInt8]) -> Double {
  guard a.count == b.count else { return 1 }
  var changed = 0
  for i in 0..<a.count where abs(Int(a[i]) - Int(b[i])) > 24 { changed += 1 }
  return Double(changed) / Double(a.count)
}

func watch(root: pid_t, epoch: Double, timeout: Double, settle: Double, threshold: Double) async {
  var windowMs: Double? = nil
  var lastChangeMs: Double? = nil
  var captures = 0
  var changes: [[Double]] = []
  var previous: [UInt8]? = nil
  var windowID: CGWindowID = 0
  var filter: SCContentFilter? = nil
  let config = SCStreamConfiguration()
  config.width = thumbWidth * 2
  config.height = thumbHeight * 2
  config.showsCursor = false
  var failure: String? = nil
  while nowMs() - epoch < timeout {
    guard let window = mainWindow(root: root) else { try? await Task.sleep(nanoseconds: 20_000_000); continue }
    let t = nowMs() - epoch
    if windowMs == nil { windowMs = t; lastChangeMs = t }
    if window.id != windowID {
      windowID = window.id
      previous = nil
      lastChangeMs = t
      changes.append([t, 1])
      do {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        filter = content.windows.first { $0.windowID == window.id }.map { SCContentFilter(desktopIndependentWindow: $0) }
      } catch { filter = nil; failure = "\(error)" }
    }
    if let filter {
      do {
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        let thumb = thumbnail(image)
        captures += 1
        let at = nowMs() - epoch
        if let previous {
          let delta = difference(previous, thumb)
          if delta > threshold { lastChangeMs = at; changes.append([at, delta]) }
        }
        previous = thumb
      } catch { failure = "\(error)" }
    }
    if let last = lastChangeMs, nowMs() - epoch - last >= settle { break }
    try? await Task.sleep(nanoseconds: 50_000_000)
  }
  var result: [String: Any] = ["captures": captures, "changes": changes]
  result["windowMs"] = windowMs
  result["completeMs"] = lastChangeMs
  result["timedOut"] = nowMs() - epoch >= timeout
  result["error"] = failure
  printJSON(result)
}

@main
struct Probe {
  static func main() async {
    let args = CommandLine.arguments
    guard args.count >= 3, let root = pid_t(args[2]) else {
      FileHandle.standardError.write("usage: probe tree <pid> | probe watch <pid> <epochMs> <timeoutMs> <settleMs> <threshold>\n".data(using: .utf8)!)
      exit(2)
    }
    switch args[1] {
    case "tree":
      printJSON(related(to: root).map(usage))
    case "watch":
      await watch(root: root, epoch: Double(args[3])!, timeout: Double(args[4])!, settle: Double(args[5])!, threshold: Double(args[6])!)
    default:
      exit(2)
    }
  }
}
