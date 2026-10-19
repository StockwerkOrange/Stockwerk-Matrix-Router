// Minimal local HTTP server for the router panel (loopback only).
// Hand-rolled on TcpListener so it needs no URL reservation or admin rights on Windows.

using System;
using System.Collections.Generic;
using System.IO;
using System.Net.Sockets;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;

static class Panel
{
    const int MaxHeader = 16 * 1024, MaxBody = 8 * 1024;
    static readonly byte[] Page = LoadPage();

    static byte[] LoadPage()
    {
        using var s = Assembly.GetExecutingAssembly().GetManifestResourceStream("panel.html");
        using var m = new MemoryStream();
        s.CopyTo(m);
        return m.ToArray();
    }

    public static async Task Serve(TcpListener listener)
    {
        while (true)
        {
            TcpClient c;
            try { c = await listener.AcceptTcpClientAsync(); } catch { return; }
            _ = Handle(c);
        }
    }

    static async Task Handle(TcpClient client)
    {
        using (client)
        {
            try
            {
                client.ReceiveTimeout = 5000;
                var stream = client.GetStream();
                var buf = new List<byte>();
                var chunk = new byte[4096];
                int headerEnd = -1;
                while (headerEnd < 0)
                {
                    int n = await stream.ReadAsync(chunk).AsTask().WaitAsync(TimeSpan.FromSeconds(5));
                    if (n == 0) return;
                    buf.AddRange(chunk[..n]);
                    headerEnd = IndexOf(buf, "\r\n\r\n"u8);
                    if (headerEnd < 0 && buf.Count > MaxHeader) return;
                }
                var head = Encoding.ASCII.GetString(buf.GetRange(0, headerEnd).ToArray()).Split("\r\n");
                var line = head[0].Split(' ');
                if (line.Length < 2) return;
                string method = line[0], path = line[1];
                var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                foreach (var h in head[1..])
                {
                    int i = h.IndexOf(':');
                    if (i > 0) headers[h[..i].Trim()] = h[(i + 1)..].Trim();
                }

                // DNS-rebinding guard: only answer requests addressed to this machine's loopback.
                headers.TryGetValue("Host", out var host);
                var port = ((System.Net.IPEndPoint)client.Client.LocalEndPoint).Port;
                if (host != $"127.0.0.1:{port}" && host != $"localhost:{port}") { await Send(stream, 403, "text/plain", "Forbidden"u8.ToArray()); return; }

                int length = headers.TryGetValue("Content-Length", out var cl) && int.TryParse(cl, out var l) ? l : 0;
                if (length < 0 || length > MaxBody) { await Send(stream, 413, "text/plain", "Too large"u8.ToArray()); return; }
                while (buf.Count < headerEnd + 4 + length)
                {
                    int n = await stream.ReadAsync(chunk).AsTask().WaitAsync(TimeSpan.FromSeconds(5));
                    if (n == 0) return;
                    buf.AddRange(chunk[..n]);
                }
                var body = Encoding.UTF8.GetString(buf.GetRange(headerEnd + 4, length).ToArray());

                if (method == "GET" && path == "/") { await Send(stream, 200, "text/html; charset=utf-8", Page); return; }
                if (method == "GET" && path == "/api/state") { await Json(stream, Program.State()); return; }

                // State-changing calls need a custom header: browsers cannot send it cross-site without a preflight we never grant.
                if (method != "POST" || !headers.ContainsKey("X-Matrix-Router")) { await Send(stream, 404, "text/plain", "Not found"u8.ToArray()); return; }
                using var doc = JsonDocument.Parse(body.Length == 0 ? "{}" : body);
                var j = doc.RootElement;
                switch (path)
                {
                    case "/api/route":
                        var err = Program.RouteFromPanel(j.GetProperty("ch").GetInt32(), j.TryGetProperty("address", out var a) ? a.GetString() ?? "" : "");
                        await Json(stream, new { ok = err == null, error = err?.Replace("ERR ", "") });
                        return;
                    case "/api/settings":
                        var e = Program.SaveSettings(j.GetProperty("namePrefix").GetString(), j.GetProperty("channels").GetInt32(),
                            j.GetProperty("tcpPort").GetInt32(), j.GetProperty("uiPort").GetInt32());
                        await Json(stream, new { ok = e == null, error = e });
                        return;
                    case "/api/quit":
                        await Json(stream, new { ok = true });
                        Program.Quit(j.TryGetProperty("restart", out var r) && r.GetBoolean());
                        return;
                }
                await Send(stream, 404, "text/plain", "Not found"u8.ToArray());
            }
            catch (Exception ex) when (ex is JsonException or KeyNotFoundException or InvalidOperationException or FormatException)
            {
                try { await Send(client.GetStream(), 400, "text/plain", "Bad request"u8.ToArray()); } catch { }
            }
            catch { }
        }
    }

    static int IndexOf(List<byte> data, ReadOnlySpan<byte> pattern)
    {
        for (int i = 0; i + pattern.Length <= data.Count; i++)
        {
            int k = 0;
            while (k < pattern.Length && data[i + k] == pattern[k]) k++;
            if (k == pattern.Length) return i;
        }
        return -1;
    }

    static Task Json(NetworkStream s, object o) =>
        Send(s, 200, "application/json", JsonSerializer.SerializeToUtf8Bytes(o, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase }));

    static async Task Send(NetworkStream s, int code, string type, byte[] body)
    {
        var head = $"HTTP/1.1 {code} {(code == 200 ? "OK" : "Error")}\r\nContent-Type: {type}\r\nContent-Length: {body.Length}\r\n" +
                   "Cache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nX-Frame-Options: DENY\r\n" +
                   "Content-Security-Policy: default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'\r\n" +
                   "Connection: close\r\n\r\n";
        await s.WriteAsync(Encoding.ASCII.GetBytes(head));
        await s.WriteAsync(body);
    }
}
