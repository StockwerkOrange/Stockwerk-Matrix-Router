# 4 Out OMT Matrix

Kreuzschiene für [Open Media Transport (OMT)](https://github.com/openmediatransport): macht **jeden OMT-Viewer fernsteuerbar** – auch den vMix OMT Viewer, Sienna OMT Video Monitor oder OBS, die selbst keine Fernsteuerung haben. Dazu ein Bitfocus-Companion-Modul für Stream-Deck-Bedienung. Früher: *Stockwerk Matrix Router*. Nicht zu verwechseln mit dem *OMT Matrix Router* aus den vMix OMT Tools.

*English: A crosspoint router for Open Media Transport. It publishes virtual OMT sources and redirects any viewer watching one of them to the source you pick, controllable from its own panel, via TCP or with the included Bitfocus Companion module (which also controls OMT Mini and omtplayer).*

## Inhalt

| Ordner | Was |
| --- | --- |
| [`router/`](router/) | Die App: virtuelle Ausgänge, Kreuzschienen-Fenster, TCP-Steuerung (Port 6390). Windows, macOS, Linux mit .NET 8. |
| [`companion-module/`](companion-module/) | Companion-Modul **omt-monitor** für Companion 4.0+: 4 Out OMT Matrix, [OMT Mini](https://github.com/ForesterMW/omt-mini) und [omtplayer](https://github.com/openmediatransport/omtplayer). |

## Prinzip

```
Kamera ──OMT──┐
Folien ──OMT──┼──▶ Viewer (vMix OMT Viewer, Sienna, OBS …)
Grafik ──OMT──┘        ▲ zeigt einmalig "REGIE-PC (Matrix Out 1)"
                       │ wird per OMT-Redirect umgeleitet
          4 Out OMT Matrix ◀── Fenster / Companion / TCP
```

Das Video läuft direkt von der Quelle zum Viewer, nicht durch den Router.

## Schnellstart

1. **Router:** passendes ZIP aus den [Releases](../../releases) laden – keine weitere Installation nötig:
   - Windows: `4OutOMTMatrix-windows-x64.zip` → `4 Out OMT Matrix.exe`
   - Mac: `4OutOMTMatrix-macos-apple-silicon.zip` (M1–M4) oder `…-macos-intel.zip` → `4 Out OMT Matrix.app`
   - `…-portable.zip` läuft überall, braucht aber die .NET 8 Runtime.

   Details: [router/README.md](router/README.md).
2. Im Viewer einmalig `RECHNERNAME (Matrix Out 1)` als Quelle wählen.
3. **Companion:** `omt-monitor-x.y.z.tgz` aus den Releases unter *Modules › Import module package* laden, Verbindung „OMT Monitor“ anlegen, Gerät *4 Out OMT Matrix (TCP)*, IP des Router-Rechners, Port 6390.

## Selbst bauen

```
# Router (.NET 8 SDK, für den Windows-Starter zusätzlich mingw-w64)
cd router && dotnet publish 4OutOMTMatrix.csproj -c Release -p:UseAppHost=false -o dist

# Companion-Modul (Node 22)
cd companion-module && npm ci && npm test && npm run package
```

## Lizenz

[MIT](LICENSE). Enthält [libomtnet](https://github.com/openmediatransport/libomtnet) (MIT, Open Media Transport Contributors), siehe `router/libomtnet/LICENSE.txt`.
OMT, vMix, Sienna und Bitfocus Companion sind Projekte bzw. Marken ihrer jeweiligen Inhaber; dieses Projekt ist unabhängig davon.
