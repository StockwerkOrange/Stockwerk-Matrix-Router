# Stockwerk Matrix Router

Macht **jeden OMT-Viewer umschaltbar** – auch solche ohne eigene Fernsteuerung (vMix OMT Viewer, Sienna OMT Video Monitor, OBS-Plugin, omtplayer). Bedienung über das eigene App-Fenster (Kreuzschiene), per Companion oder per TCP. Früherer Name: *OMT Viewer Control*.

## So funktioniert es

Der Router meldet 4 virtuelle OMT-Quellen im Netz an:

```
<RECHNERNAME> (Matrix Out 1)
<RECHNERNAME> (Matrix Out 2)
…
```

Im Viewer wählst du **einmalig** einen Ausgang als Quelle. Danach schaltest du im Router-Fenster, in Companion oder per TCP um – der Router leitet den Viewer über die Redirect-Funktion des OMT-Protokolls auf die echte Quelle um. Der Viewer verbindet sich direkt mit der Kamera, das Video läuft **nicht** durch den Router.

„Schwarz“ löscht die Route: der Viewer zeigt dann die leere virtuelle Quelle.

## Installation (Windows)

1. Einmalig die kostenlose **.NET 8 Runtime** von Microsoft installieren. Fehlt sie, bietet der Router beim Start den Download an.
2. ZIP entpacken (ganzen Ordner behalten) und **„Stockwerk Matrix Router.exe“** starten.
3. Beim ersten Start die Windows-Firewall-Abfrage für *dotnet* mit „Zulassen“ (privates Netz) bestätigen – nötig für TCP 6390 und die OMT-Ports 6400–6600.

Das Router-Fenster öffnet sich als eigene App (Microsoft Edge im App-Modus, ohne Browser-Leisten).

- **Fenster schließen** lässt den Router weiterlaufen. Erneutes Starten der .exe öffnet nur das Fenster wieder.
- **Beenden** im Fenster stoppt den Router. Die Viewer bleiben auf ihrer letzten Quelle.
- **Autostart:** Verknüpfung auf die .exe in `shell:startup` legen. Mit dem Zusatz `--no-window` im Verknüpfungsziel startet er ohne Fenster.

macOS / Linux: `./start-mac-linux.sh` (öffnet das Fenster in Chrome/Edge im App-Modus oder im Standardbrowser).

### Umstieg von OMT Viewer Control 1.0

Neuen Ordner neben den alten legen und `viewercontrol.json` aus dem alten Ordner hineinkopieren. Der Router übernimmt daraus Name, Ports und Routen – die Viewer müssen nicht neu eingestellt werden.

## Einstellungen

Im Fenster unter **Einstellungen**: Name der Ausgänge, Anzahl (1–16), TCP-Port für Companion, Port des Fensters. Gespeichert wird in `matrixrouter.json` neben dem Programm, zusammen mit den aktuellen Routen. Nach einem Neustart sind die letzten Routen wieder aktiv.

## TCP-Protokoll

Eine Zeile pro Befehl (UTF-8, `\n` oder `\r\n`), Port 6390. Testbar mit `telnet <ip> 6390`.

| Befehl | Wirkung |
| --- | --- |
| `SET <n> <quelle>` | Ausgang n auf Quelle schalten – `HOST (Name)` oder `omt://host:port` |
| `SET <n>` / `CLEAR <n>` | Route löschen (Schwarz) |
| `GET` | aktuelle Routen (`CH`-Zeilen) |
| `LIST` | gefundene Quellen (`SOURCES <anzahl>`, dann je eine `SRC`-Zeile) |
| `PING` | `PONG` |

Beim Verbinden und bei jeder Änderung – auch aus dem Fenster – schickt der Router an alle verbundenen Clients:

```
HELLO StockwerkMatrixRouter 1.1.0 4
OUT 1 REGIE-PC (Matrix Out 1)
CH 1 CAM2 (Camera 2)
SOURCES 2
SRC CAM1 (Camera 1)
SRC CAM2 (Camera 2)
```

Fehler kommen als `ERR <text>`.

## Hinweise

- TCP-Steuerung ohne Passwort – nur im Produktionsnetz betreiben. Das Fenster ist nur vom eigenen Rechner aus erreichbar.
- Nicht parallel mit dem vMix OMT Matrix Router dieselben Viewer umleiten – die Umschaltungen überschreiben sich.
- Gesteuert wird die Quellenwahl; Vollbild, Mute und Tally bleiben beim Viewer.

## Selbst bauen

```
dotnet publish StockwerkMatrixRouter.csproj -c Release -p:UseAppHost=false -o dist
x86_64-w64-mingw32-windres launcher/res.rc -O coff -o res.o
x86_64-w64-mingw32-gcc -municode -mwindows -O2 -s launcher/launcher.c res.o -o "dist/Stockwerk Matrix Router.exe"
```

Test (Linux, .NET 8 SDK): `test/run-linux-test.sh`

## Lizenz

MIT (siehe `../LICENSE`). Enthält [libomtnet](https://github.com/openmediatransport/libomtnet) (MIT, Open Media Transport Contributors), siehe `libomtnet/LICENSE.txt`.
