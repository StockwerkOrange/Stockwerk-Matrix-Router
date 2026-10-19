// Stockwerk Matrix Router (formerly OMT Viewer Control)
// Publishes N virtual OMT sources ("HOST (Matrix Out 1)" ...). Point any OMT receiver
// (vMix OMT Viewer, Sienna, OBS, omtplayer) at one of them once; switching then happens over
// a line-based TCP protocol or the built-in panel by redirecting that receiver to the chosen
// real source. Video never passes through this program.

using libomtnet;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Diagnostics;
using System.Runtime.InteropServices;

sealed class Config
{
    public string Bind { get; set; } = "0.0.0.0";
    public int TcpPort { get; set; } = 6390;
    public int UiPort { get; set; } = 6391;
    public int Channels { get; set; } = 4;
    public string NamePrefix { get; set; } = "Matrix Out";
    public string[] Routes { get; set; } = Array.Empty<string>();
}

sealed class Client
{
    public TcpClient Tcp;
    public StreamWriter Writer;
    public void Send(IEnumerable<string> lines)
    {
        try
        {
            lock (this)
            {
                foreach (var l in lines) Writer.Write(l + "\r\n");
                Writer.Flush();
            }
        }
        catch { Tcp.Close(); }
    }
}

static class Program
{
    // Single source of truth: <Version> in the csproj (CI overrides it with the release tag).
    static readonly string Version = (System.Reflection.Assembly.GetExecutingAssembly()
        .GetCustomAttributes(typeof(System.Reflection.AssemblyInformationalVersionAttribute), false)
        .FirstOrDefault() as System.Reflection.AssemblyInformationalVersionAttribute)?.InformationalVersion.Split('+')[0] ?? "0.0.0";
    const string AppName = "Stockwerk Matrix Router";
    const int MaxLine = 1024, MaxAddress = 255, MaxClients = 32;

    static Config cfg;
    static string cfgPath;
    static OMTSend[] outs;
    static string[] sources = Array.Empty<string>();
    static readonly List<Client> clients = new();
    static readonly object gate = new();

    static readonly ManualResetEventSlim quit = new();
    static bool restart;
    static int startUiPort;

    static int Main(string[] args)
    {
        bool noWindow = args.Contains("--no-window");
        var pos = args.Where(a => !a.StartsWith("--")).ToArray();
        cfgPath = pos.Length > 0 ? pos[0] : Path.Combine(ConfigDir(), "matrixrouter.json");
        var legacy = Path.Combine(Path.GetDirectoryName(cfgPath), "viewercontrol.json"); // 1.0 name, keeps existing viewer setups
        var src = File.Exists(cfgPath) ? cfgPath : File.Exists(legacy) ? legacy : null;
        cfg = src != null ? JsonSerializer.Deserialize<Config>(File.ReadAllText(src)) : new Config();
        cfg.Channels = Math.Clamp(cfg.Channels, 1, 16);

        startUiPort = cfg.UiPort;
        // The panel port doubles as the single-instance lock: a second start just opens the window.
        var ui = new TcpListener(IPAddress.Loopback, cfg.UiPort);
        try { ui.Start(); }
        catch (SocketException)
        {
            OpenWindow();
            return 0;
        }
        var routes = cfg.Routes;
        Array.Resize(ref routes, cfg.Channels);
        cfg.Routes = routes.Select(r => r ?? "").ToArray();
        Save();

        outs = new OMTSend[cfg.Channels];
        for (int i = 0; i < outs.Length; i++)
        {
            outs[i] = new OMTSend($"{cfg.NamePrefix} {i + 1}", OMTQuality.Default);
            if (cfg.Routes[i] != "") outs[i].SetRedirect(cfg.Routes[i]);
            Console.WriteLine($"Output {i + 1}: {outs[i].Address}  ->  {Show(cfg.Routes[i])}");
        }

        var listener = new TcpListener(IPAddress.Parse(cfg.Bind), cfg.TcpPort);
        listener.Start();
        Console.WriteLine($"TCP control on {cfg.Bind}:{cfg.TcpPort}, panel on {PanelUrl}  (Ctrl+C to quit)");

        Console.CancelKeyPress += (_, e) => { e.Cancel = true; quit.Set(); };
        AppDomain.CurrentDomain.ProcessExit += (_, _) => quit.Set();

        _ = AcceptLoop(listener);
        _ = DiscoveryLoop();
        _ = Panel.Serve(ui);
        if (!noWindow) OpenWindow();
        quit.Wait();

        listener.Stop();
        ui.Stop();
        foreach (var o in outs) o.Dispose();
        if (restart) Relaunch();
        return 0;
    }

    // Next to the program, except inside a macOS .app bundle (must stay unmodified): ~/Library/Application Support.
    static string ConfigDir()
    {
        var dir = AppContext.BaseDirectory;
        if (!dir.Contains(".app/Contents/")) return dir;
        dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "StockwerkMatrixRouter");
        Directory.CreateDirectory(dir);
        return dir;
    }

    static string PanelUrl => $"http://127.0.0.1:{cfg.UiPort}/";

    // Own app window: Edge/Chrome in app mode with a separate profile, else the default browser.
    static void OpenWindow()
    {
        var url = PanelUrl;
        var profile = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "StockwerkMatrixRouter", "window");
        var appArgs = $"--app={url} --user-data-dir=\"{profile}\" --window-size=1180,780 --no-first-run --no-default-browser-check";
        try
        {
            if (OperatingSystem.IsWindows())
            {
                Process.Start(new ProcessStartInfo("msedge", appArgs) { UseShellExecute = true });
                return;
            }
            if (OperatingSystem.IsMacOS())
            {
                foreach (var app in new[] { "Google Chrome", "Microsoft Edge" })
                {
                    var p = Process.Start("open", $"-na \"{app}\" --args {appArgs}");
                    p.WaitForExit(5000);
                    if (p.ExitCode == 0) return;
                }
                Process.Start("open", url);
                return;
            }
            Process.Start(new ProcessStartInfo("xdg-open", url) { UseShellExecute = false });
        }
        catch
        {
            try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); } catch { Console.WriteLine($"Open {url} in a browser."); }
        }
    }

    static void Relaunch()
    {
        var self = Environment.GetCommandLineArgs()[0]; // the dll when hosted by dotnet
        var host = Environment.ProcessPath;
        var tail = $"\"{cfgPath}\"" + (cfg.UiPort == startUiPort ? " --no-window" : ""); // open a window only if the old one can't reconnect
        var args = Path.GetFileNameWithoutExtension(host).Equals("dotnet", StringComparison.OrdinalIgnoreCase) ? $"\"{self}\" {tail}" : tail;
        Process.Start(new ProcessStartInfo(host, args) { UseShellExecute = false, CreateNoWindow = true });
    }

    // ---- state for the panel ------------------------------------------------------

    internal static object State()
    {
        lock (gate)
        {
            return new
            {
                app = AppName,
                version = Version,
                host = Environment.MachineName,
                tcpPort = cfg.TcpPort,
                clients = clients.Count,
                outputs = outs.Select((o, i) => new { n = i + 1, name = o.Address, route = cfg.Routes[i], connections = o.Connections }).ToArray(),
                sources,
                settings = new { cfg.NamePrefix, cfg.Channels, cfg.TcpPort, cfg.UiPort },
            };
        }
    }

    internal static string RouteFromPanel(int ch, string address) =>
        Handle($"SET {ch} {address}".TrimEnd()).FirstOrDefault(); // same validation as TCP; null = ok

    internal static string SaveSettings(string prefix, int channels, int tcpPort, int uiPort)
    {
        prefix = (prefix ?? "").Trim();
        if (prefix.Length is < 1 or > 40 || prefix.Any(c => char.IsControl(c) || c == '(' || c == ')')) return "Name: 1–40 Zeichen, ohne Klammern.";
        if (channels is < 1 or > 16) return "Ausgänge: 1–16.";
        if (tcpPort is < 1024 or > 65535 || uiPort is < 1024 or > 65535 || tcpPort == uiPort) return "Ports: 1024–65535, verschieden.";
        lock (gate)
        {
            cfg.NamePrefix = prefix;
            cfg.TcpPort = tcpPort;
            cfg.UiPort = uiPort;
            var r = cfg.Routes;
            Array.Resize(ref r, channels);
            cfg.Routes = r.Select(x => x ?? "").ToArray();
            cfg.Channels = channels;
            Save();
        }
        return null;
    }

    internal static void Quit(bool andRestart)
    {
        restart = andRestart;
        quit.Set();
    }

    static string Show(string route) => route == "" ? "(none)" : route;

    static void Save()
    {
        try { File.WriteAllText(cfgPath, JsonSerializer.Serialize(cfg, new JsonSerializerOptions { WriteIndented = true })); }
        catch (Exception e) { Console.WriteLine($"Could not save {cfgPath}: {e.Message}"); }
    }

    // ---- discovery ---------------------------------------------------------------

    static async Task DiscoveryLoop()
    {
        var discovery = OMTDiscovery.GetInstance();
        while (true)
        {
            try
            {
                var own = outs.Select(o => o.Address).ToHashSet();
                var now = discovery.GetAddresses().Where(a => !own.Contains(a)).OrderBy(a => a, StringComparer.OrdinalIgnoreCase).ToArray();
                bool changed;
                lock (gate) { changed = !now.SequenceEqual(sources); if (changed) sources = now; }
                if (changed) Broadcast(SourceLines());
            }
            catch (Exception e) { Console.WriteLine($"Discovery: {e.Message}"); }
            await Task.Delay(2000);
        }
    }

    // ---- TCP ---------------------------------------------------------------------

    static async Task AcceptLoop(TcpListener listener)
    {
        while (true)
        {
            TcpClient tcp;
            try { tcp = await listener.AcceptTcpClientAsync(); } catch { return; }
            lock (gate)
            {
                if (clients.Count >= MaxClients) { tcp.Close(); continue; }
            }
            _ = Serve(tcp);
        }
    }

    static async Task Serve(TcpClient tcp)
    {
        tcp.NoDelay = true;
        var stream = tcp.GetStream();
        var c = new Client { Tcp = tcp, Writer = new StreamWriter(stream, new UTF8Encoding(false)) };
        lock (gate) clients.Add(c);
        Console.WriteLine($"Client connected: {tcp.Client.RemoteEndPoint}");
        try
        {
            c.Send(Greeting());
            var reader = new StreamReader(stream, Encoding.UTF8);
            var line = new StringBuilder();
            var buf = new char[512];
            int n;
            while ((n = await reader.ReadAsync(buf, 0, buf.Length)) > 0)
            {
                for (int i = 0; i < n; i++)
                {
                    char ch = buf[i];
                    if (ch == '\n')
                    {
                        var cmd = line.ToString().TrimEnd('\r');
                        line.Clear();
                        if (cmd.Length > 0) c.Send(Handle(cmd));
                    }
                    else if (line.Length >= MaxLine) { c.Send(new[] { "ERR line too long" }); return; }
                    else line.Append(ch);
                }
            }
        }
        catch { }
        finally
        {
            lock (gate) clients.Remove(c);
            tcp.Close();
        }
    }

    static void Broadcast(IEnumerable<string> lines)
    {
        var list = lines.ToList();
        Client[] copy;
        lock (gate) copy = clients.ToArray();
        foreach (var c in copy) c.Send(list);
    }

    static IEnumerable<string> Greeting()
    {
        yield return $"HELLO StockwerkMatrixRouter {Version} {outs.Length}";
        for (int i = 0; i < outs.Length; i++) yield return $"OUT {i + 1} {outs[i].Address}";
        foreach (var l in RouteLines()) yield return l;
        foreach (var l in SourceLines()) yield return l;
    }

    static IEnumerable<string> RouteLines()
    {
        lock (gate) return cfg.Routes.Select((r, i) => $"CH {i + 1} {r}".TrimEnd()).ToList();
    }

    static IEnumerable<string> SourceLines()
    {
        lock (gate) return new[] { $"SOURCES {sources.Length}" }.Concat(sources.Select(s => $"SRC {s}")).ToList();
    }

    // Protocol (one command per line, UTF-8, replies end with CRLF):
    //   SET <ch> <address>   route output <ch> to a source ("HOST (Name)" or omt://host:port)
    //   SET <ch>             clear the route (receiver shows the empty virtual source)
    //   GET                  CH lines for all outputs
    //   LIST                 SOURCES <n> followed by n SRC lines
    //   PING                 PONG
    // Changes are pushed to every connected client as CH / SOURCES lines.
    static IEnumerable<string> Handle(string cmd)
    {
        var parts = cmd.Split(' ', 3);
        switch (parts[0].ToUpperInvariant())
        {
            case "SET":
            case "CLEAR":
                if (parts.Length < 2 || !int.TryParse(parts[1], out int ch) || ch < 1 || ch > outs.Length)
                    return new[] { $"ERR channel must be 1-{outs.Length}" };
                var address = parts.Length > 2 && parts[0].ToUpperInvariant() == "SET" ? parts[2].Trim() : "";
                if (address.Length > MaxAddress || address.Any(char.IsControl)) return new[] { "ERR invalid address" };
                if (outs.Any(o => o.Address == address || o.URL == address)) return new[] { "ERR cannot route an output to itself" };
                Route(ch - 1, address);
                return Array.Empty<string>(); // the CH broadcast is the reply
            case "GET": return RouteLines();
            case "LIST": return SourceLines();
            case "PING": return new[] { "PONG" };
            case "HELP": return new[] { "OK commands: SET <ch> [address] | CLEAR <ch> | GET | LIST | PING" };
            default: return new[] { "ERR unknown command" };
        }
    }

    static void Route(int i, string address)
    {
        lock (gate)
        {
            cfg.Routes[i] = address;
            outs[i].SetRedirect(address == "" ? null : address);
            Save();
        }
        Console.WriteLine($"Output {i + 1} -> {Show(address)}");
        Broadcast(new[] { $"CH {i + 1} {address}".TrimEnd() });
    }
}
