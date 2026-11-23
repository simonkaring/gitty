param(
    [Parameter(Mandatory=$true)][string]$Exe,
    [Parameter(Mandatory=$true)][string]$Repo,
    [Parameter(Mandatory=$true)][string]$CompareNames,
    [int]$ObserveSeconds = 8,
    [int]$IdleSeconds = 10,
    [int]$TimeoutSeconds = 30
)

$ErrorActionPreference = 'Stop'
$names = $CompareNames -split ','
if (Get-Process -Name $names -ErrorAction SilentlyContinue) {
    throw 'Close Gitty and GitCraft before benchmarking. No running apps were closed.'
}
if (-not [Environment]::UserInteractive) { throw 'Run from an unlocked interactive Windows desktop.' }

Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Runtime.InteropServices;

public static class BenchWindow {
    [StructLayout(LayoutKind.Sequential)]
    private struct Rect { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] private static extern bool GetClientRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] private static extern bool ClientToScreen(IntPtr hwnd, ref Point point);
    [DllImport("user32.dll")] private static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out int value, int size);

    public static bool Visible(IntPtr hwnd) {
        int cloaked;
        return hwnd != IntPtr.Zero && IsWindowVisible(hwnd) && !IsIconic(hwnd)
            && (DwmGetWindowAttribute(hwnd, 14, out cloaked, 4) != 0 || cloaked == 0);
    }

    public static int[] Capture(IntPtr hwnd) {
        if (!Visible(hwnd)) return null;
        Rect rect;
        Point origin = new Point(0, 0);
        if (!GetClientRect(hwnd, out rect) || !ClientToScreen(hwnd, ref origin)) return null;
        int width = rect.Right, height = rect.Bottom;
        if (width < 100 || height < 100) return null;
        // Reject samples with an obstructed center or corner (child WebView windows are OK).
        foreach (int x in new[] { 24, width / 2, width - 24 })
            foreach (int y in new[] { 24, height / 2, height - 24 })
                if (GetAncestor(WindowFromPoint(new Point(origin.X + x, origin.Y + y)), 2) != hwnd) return null;
        try {
            using (var image = new Bitmap(width, height))
            using (var graphics = Graphics.FromImage(image))
            using (var sample = new Bitmap(96, 64))
            using (var downscale = Graphics.FromImage(sample)) {
                graphics.CopyFromScreen(origin, Point.Empty, image.Size);
                downscale.DrawImage(image, 0, 0, sample.Width, sample.Height);
                var pixels = new int[sample.Width * sample.Height];
                for (int y = 0; y < sample.Height; y++)
                    for (int x = 0; x < sample.Width; x++)
                        pixels[y * sample.Width + x] = sample.GetPixel(x, y).ToArgb();
                return pixels;
            }
        } catch (System.ComponentModel.Win32Exception) { return null; }
    }

    public static double Changed(int[] previous, int[] current) {
        int changed = 0;
        for (int i = 0; i < current.Length; i++) {
            int a = previous[i], b = current[i];
            if (Math.Abs(((a >> 16) & 255) - ((b >> 16) & 255)) > 12
                || Math.Abs(((a >> 8) & 255) - ((b >> 8) & 255)) > 12
                || Math.Abs((a & 255) - (b & 255)) > 12) changed++;
        }
        return changed / (double)current.Length;
    }
}
'@
[void][BenchWindow]::SetProcessDPIAware()

function Read-Family($root) {
    $root.Refresh()
    if ($root.HasExited) { throw "Benchmark app exited: $($root.ExitCode)" }
    $processes = Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,Name,PrivatePageCount,WorkingSetSize,UserModeTime,KernelModeTime
    $byParent = $processes | Group-Object ParentProcessId -AsHashTable -AsString
    $members = [Collections.Generic.List[object]]::new()
    $queue = [Collections.Generic.Queue[object]]::new()
    $rootEntry = @($processes | Where-Object { $_.ProcessId -eq $root.Id })
    if ($rootEntry.Count -ne 1) { throw 'Benchmark process missing from Windows process snapshot.' }
    $queue.Enqueue($rootEntry[0])
    while ($queue.Count) {
        $entry = $queue.Dequeue()
        $members.Add([pscustomobject]@{
            pid = $entry.ProcessId
            name = $entry.Name
            identity = "$($entry.ProcessId):$($entry.CreationDate.Ticks)"
            privateBytes = [long]$entry.PrivatePageCount
            workingSetBytes = [long]$entry.WorkingSetSize
            cpu100ns = [long]$entry.UserModeTime + [long]$entry.KernelModeTime
        })
        foreach ($descendant in $byParent[[string]$entry.ProcessId]) {
            # Windows can retain a parent PID after that parent exits and the PID is reused.
            if ($descendant -and $descendant.CreationDate -ge $entry.CreationDate -and $descendant.ProcessId -ne $entry.ProcessId) {
                $queue.Enqueue($descendant)
            }
        }
    }
    return $members.ToArray()
}

$info = [Diagnostics.ProcessStartInfo]::new()
$info.FileName = $Exe
# The only argument is an absolute repo path. Double trailing separators before the closing quote.
$info.Arguments = '"' + ($Repo -replace '(\\+)$', '$1$1') + '"'
$info.WorkingDirectory = Split-Path -Parent $Exe
$info.UseShellExecute = $false
$app = [Diagnostics.Process]::new()
$app.StartInfo = $info
$started = $false
try {
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $started = $app.Start()
    if (-not $started) { throw "Could not start $Exe" }
    do {
        $app.Refresh()
        if ($app.HasExited) { throw "App exited before showing a window: $($app.ExitCode)" }
        $hwnd = $app.MainWindowHandle
        if ([BenchWindow]::Visible($hwnd)) { break }
        Start-Sleep -Milliseconds 25
    } while ($clock.Elapsed.TotalSeconds -lt $TimeoutSeconds)
    if (-not [BenchWindow]::Visible($hwnd)) { throw "No visible app window after ${TimeoutSeconds}s: $Exe" }
    $windowMs = $clock.ElapsedMilliseconds
    $changes = [Collections.Generic.List[long]]::new()
    $previous = $null
    $captures = 0
    $missed = 0
    $lastCapture = $null
    while ($clock.ElapsedMilliseconds -lt ($windowMs + 1000 * $ObserveSeconds)) {
        $app.Refresh()
        if ($app.HasExited) { throw "App exited while observing its window: $($app.ExitCode)" }
        $sample = [BenchWindow]::Capture($app.MainWindowHandle)
        if ($null -eq $sample) {
            $missed++
            $previous = $null
        } else {
            $captures++
            $lastCapture = $clock.ElapsedMilliseconds
            if ($null -eq $previous -or [BenchWindow]::Changed($previous, $sample) -gt 0.003) {
                if ($null -ne $previous) { $changes.Add($lastCapture) }
                $previous = $sample
            }
        }
        Start-Sleep -Milliseconds 100
    }
    $settledMs = $null
    if ($missed -eq 0 -and $changes.Count -gt 0 -and ($lastCapture - $changes[$changes.Count - 1]) -ge 2000) {
        $settledMs = $changes[$changes.Count - 1]
    }
    $before = @(Read-Family $app)
    $idleStart = $clock.Elapsed.TotalSeconds
    Start-Sleep -Seconds $IdleSeconds
    $after = @(Read-Family $app)
    $elapsed = $clock.Elapsed.TotalSeconds - $idleStart
    $beforeByIdentity = @{}
    foreach ($proc in $before) { $beforeByIdentity[$proc.identity] = $proc.cpu100ns }
    $common = @($after | Where-Object { $beforeByIdentity.ContainsKey($_.identity) })
    $idleCpu = $null
    if ($common.Count -eq $before.Count -and $common.Count -eq $after.Count) {
        $delta = ($common | ForEach-Object { $_.cpu100ns - $beforeByIdentity[$_.identity] } | Measure-Object -Sum).Sum
        if ($delta -ge 0) { $idleCpu = 100 * $delta / ($elapsed * 1e7) }
    }
    [pscustomobject]@{
        windowMs = $windowMs
        visualSettledMs = $settledMs
        capturedFrames = $captures
        missedFrames = $missed
        visualChangesMs = $changes.ToArray()
        memory = @{
            privateBytes = ($before | Measure-Object privateBytes -Sum).Sum
            workingSetBytes = ($before | Measure-Object workingSetBytes -Sum).Sum
        }
        idleCpuPercent = $idleCpu
        idleSeconds = $elapsed
        processes = $before
        processesAfterIdle = $after
    } | ConvertTo-Json -Depth 5 -Compress
} finally {
    if ($started -and -not $app.HasExited) {
        [void]$app.CloseMainWindow()
        if (-not $app.WaitForExit(5000)) {
            try { $app.Kill() } catch [InvalidOperationException] { if (-not $app.HasExited) { throw } }
            [void]$app.WaitForExit(5000)
        }
    }
    $app.Dispose()
}
