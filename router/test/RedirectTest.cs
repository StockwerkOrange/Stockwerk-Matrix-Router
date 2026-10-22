// End-to-end check: real libomtnet senders + a real OMTReceive (stand-in for a viewer)
// switched through 4 Out OMT Matrix over TCP and its panel API. Run via run-linux-test.sh.
using libomtnet;
using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net.Sockets;
using System.Threading;

static class RedirectTest
{
    static Process proc;
    static void Check(bool ok, string what) { Console.WriteLine((ok ? "PASS " : "FAIL ") + what); if (!ok) { proc?.Kill(); Environment.Exit(1); } }
    // Real viewers call Receive() in a loop; that loop is what drives reconnects in libomtnet.
    static void Pump(OMTReceive rx) => new Thread(() => { var f = new OMTMediaFrame(); try { while (true) rx.Receive(OMTFrameType.Video, 100, ref f); } catch { } }) { IsBackground = true }.Start();
    static bool WaitFor(Func<bool> cond, int ms = 10000) { var sw = Stopwatch.StartNew(); while (sw.ElapsedMilliseconds < ms) { if (cond()) return true; Thread.Sleep(100); } return cond(); }

    static int Main(string[] args)
    {
        var server = new libomtnet.OMTDiscoveryServer(new System.Net.IPEndPoint(System.Net.IPAddress.Any, 6399));
        server.StartServer();
        var camA = new OMTSend("Camera A", OMTQuality.Default);
        var camB = new OMTSend("Camera B", OMTQuality.Default);

        var cfg = Path.Combine(Path.GetTempPath(), "vc-test.json");
        File.Delete(cfg);
        proc = Process.Start(new ProcessStartInfo("dotnet", $"{args[0]} {cfg} --no-window") { UseShellExecute = false });
        TcpClient tcp = null;
        Check(WaitFor(() => { try { tcp = new TcpClient("127.0.0.1", 6390); return true; } catch { return false; } }), "control program listening");
        var r = new StreamReader(tcp.GetStream());
        var w = new StreamWriter(tcp.GetStream()) { AutoFlush = true, NewLine = "\r\n" };
        var lines = new System.Collections.Concurrent.ConcurrentQueue<string>();
        new Thread(() => { string l; try { while ((l = r.ReadLine()) != null) lines.Enqueue(l); } catch { } }) { IsBackground = true }.Start();

        Check(WaitFor(() => lines.Any(l => l.StartsWith("HELLO 4OutOMTMatrix"))), "greeting");
        var out1 = lines.First(l => l.StartsWith("OUT 1 ")).Substring(6);
        Check(WaitFor(() => lines.Any(l => l == "SRC " + camA.Address), 30000), "discovery lists Camera A");
        Check(!lines.Any(l => l.StartsWith("SRC ") && l.Contains("Matrix Out")), "own outputs not listed");

        // The "viewer": an ordinary receiver pointed once at output 1.
        var viewer = new OMTReceive(out1, OMTFrameType.Video | OMTFrameType.Metadata, OMTPreferredVideoFormat.UYVY, OMTReceiveFlags.None);
        Pump(viewer);
        Thread.Sleep(1500);

        w.WriteLine("SET 1 " + camA.Address);
        Check(WaitFor(() => lines.Contains("CH 1 " + camA.Address)), "CH broadcast after SET");
        Check(WaitFor(() => camA.Connections > 0), "viewer connected to Camera A");

        w.WriteLine("SET 1 " + camB.URL);
        Check(WaitFor(() => camB.Connections > 0), "viewer switched to Camera B (omt:// URL)");
        Check(WaitFor(() => camA.Connections == 0), "viewer left Camera A");

        w.WriteLine("SET 1 " + camA.Address);
        Check(WaitFor(() => camA.Connections > 0 && camB.Connections == 0), "viewer switched back to Camera A");

        int before = camA.Connections;
        var late = new OMTReceive(out1, OMTFrameType.Video | OMTFrameType.Metadata, OMTPreferredVideoFormat.UYVY, OMTReceiveFlags.None);
        Pump(late);
        Check(WaitFor(() => camA.Connections > before), "viewer opened later follows existing route");

        // Panel API (what the app window uses)
        var http = new System.Net.Http.HttpClient { BaseAddress = new Uri("http://127.0.0.1:6391") };
        var st = http.GetStringAsync("/api/state").Result;
        Check(st.Contains("\"route\":\"" + camA.Address + "\"") && st.Contains("\"connections\":"), "panel state shows route");
        var page = http.GetAsync("/").Result;
        Check(page.IsSuccessStatusCode && page.Content.ReadAsStringAsync().Result.Contains("4 Out OMT Matrix"), "panel page served");
        System.Net.Http.HttpResponseMessage Post(string path, string json, bool header)
        {
            var m = new System.Net.Http.HttpRequestMessage(System.Net.Http.HttpMethod.Post, path) { Content = new System.Net.Http.StringContent(json) };
            if (header) m.Headers.Add("X-Matrix-Router", "1");
            return http.SendAsync(m).Result;
        }
        Check((int)Post("/api/route", "{\"ch\":1,\"address\":\"" + camB.Address + "\"}", false).StatusCode == 404, "panel POST without header refused");
        Check(camA.Connections > 0, "refused POST changed nothing");
        var evil = new System.Net.Http.HttpRequestMessage(System.Net.Http.HttpMethod.Get, "/api/state");
        evil.Headers.Host = "attacker.example:6391";
        Check((int)http.SendAsync(evil).Result.StatusCode == 403, "foreign Host header refused");
        Check(Post("/api/route", "{\"ch\":1,\"address\":\"" + camB.Address + "\"}", true).Content.ReadAsStringAsync().Result.Contains("\"ok\":true"), "panel route accepted");
        Check(WaitFor(() => camB.Connections > 0 && camA.Connections == 0), "panel switched viewer to Camera B");
        Check(WaitFor(() => lines.Contains("CH 1 " + camB.Address)), "panel change pushed to TCP clients");
        Check(Post("/api/route", "{\"ch\":9,\"address\":\"x\"}", true).Content.ReadAsStringAsync().Result.Contains("\"ok\":false"), "panel rejects bad channel");
        Post("/api/route", "{\"ch\":1,\"address\":\"" + camA.Address + "\"}", true);
        Check(WaitFor(() => camA.Connections > 0 && camB.Connections == 0), "panel switched back to Camera A");

        // Second start while running: exits at once (single instance via the panel port).
        var second = Process.Start(new ProcessStartInfo("dotnet", $"{args[0]} {cfg} --no-window") { UseShellExecute = false });
        Check(second.WaitForExit(15000) && second.ExitCode == 0, "second instance exits");

        // Control program restart: route restored from file, viewer keeps following.
        tcp.Close(); proc.Kill(); proc.WaitForExit();
        Thread.Sleep(1500);
        Check(camA.Connections > 0, "viewer stays on its camera while the router is down");
        Thread.Sleep(3000); // realistic restart gap (mDNS goodbye must land before the new announcement)
        proc = Process.Start(new ProcessStartInfo("dotnet", $"{args[0]} {cfg} --no-window") { UseShellExecute = false });
        Check(WaitFor(() => { try { tcp = new TcpClient("127.0.0.1", 6390); return true; } catch { return false; } }), "restarted");
        r = new StreamReader(tcp.GetStream()); w = new StreamWriter(tcp.GetStream()) { AutoFlush = true, NewLine = "\r\n" };
        var rr = r; new Thread(() => { string l; try { while ((l = rr.ReadLine()) != null) lines.Enqueue(l); } catch { } }) { IsBackground = true }.Start();
        Check(WaitFor(() => lines.Count(l => l == "CH 1 " + camA.Address) >= 2), "route restored after restart");
        Thread.Sleep(3000); // let the viewer's side channel find the restarted output
        w.WriteLine("SET 1 " + camB.Address);
        Check(WaitFor(() => camB.Connections > 0 && camA.Connections == 0, 20000), "switching works after restart");

        w.WriteLine("SET 1");
        Check(WaitFor(() => camB.Connections == 0), "clear: viewer left the camera");

        w.WriteLine("SET 7 x"); w.WriteLine("SET 2 " + out1); w.WriteLine("BOGUS");
        Check(WaitFor(() => lines.Count(l => l.StartsWith("ERR ")) == 3), "invalid commands rejected");
        Check(File.ReadAllText(cfg).Contains("\"Routes\""), "routes persisted");

        proc.Kill();
        camA.Dispose(); camB.Dispose();
        Console.WriteLine("all checks passed");
        return 0;
    }
}
