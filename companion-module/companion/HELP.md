# OMT Monitor

Control Open Media Transport (OMT) monitor apps, modelled on the NDI Studio Monitor module.

## Supported devices

| Device | Setup | Default port |
| --- | --- | --- |
| **OMT Mini** (Windows, github.com/ForesterMW/omt-mini) | Enable the web control panel under **Settings > Web**. It has **no password** – keep it on a trusted network. | 7400 |
| **omtplayer** (Raspberry Pi 5, github.com/openmediatransport/omtplayer) | Runs its web interface automatically. | 8080 |
| **16 Out OMT Matrix** (TCP, works with *any* OMT viewer) | Run the 16 Out OMT Matrix app on a computer in the network. In the viewer (vMix OMT Viewer, Sienna, OBS …) select `HOST (Matrix Out 1)` once. | 6390 |

Sources, feedbacks and variables are polled at the configured interval (default 1 s). Source dropdowns and presets update automatically when sources appear or disappear.

## OMT Mini

**Viewer slots:** OMT Mini replaces a viewer window when its source changes. The module therefore numbers viewers by screen position (top to bottom, then left to right): *Viewer 1* is the top-left one. A switch keeps the window position, so the slot stays the same.

### Actions
* **Viewer: set source** – switch the viewer in a slot; opens a new viewer if the slot is empty; *None* closes it
* **Viewer: open new viewer**
* **Window: close**
* **Window: maximize / restore / minimize / toggle maximize** (viewer or multiview)
* **Window: move / resize**
* **Multiview: open**, **layout** (2x2, 3x2, 3x3, 4x3, 4x4, 1+5, 1+7), **set tile source**
* **Add source by address**
* **Custom command (JSON)** – raw body for `POST /api/command`, e.g. `{"kind":"state","id":1,"state":"maximize"}`

### Feedbacks
* Viewer shows source (specific slot or any viewer)
* Multiview tile shows source
* Window is maximized / Window exists
* Multiview layout is

### Variables
`host`, `version`, `viewer_count`, `multiview_open`, `multiview_layout`,
`viewer1_source` / `viewer1_host` / `viewer1_name` … up to viewer 8, `tile1` … `tile16`

## omtplayer

* Action **Set source**, feedback **Source is active**, presets per source
* Variables `source`, `source_host`, `source_name`

## 16 Out OMT Matrix

Makes viewers without their own remote control switchable (formerly *Stockwerk Matrix Router* / *OMT Viewer Control*). The router app publishes virtual sources and redirects every viewer watching one of them to the source you pick (OMT redirect). Video goes directly from the source to the viewer. The connection is a persistent TCP link, so changes appear instantly.

* Action **Route output to source** (*None* clears the route), **Send raw command**
* Feedback **Output is routed to source**
* Presets per output and source
* Variables `version`, `out1_name` (virtual source to select in the viewer), `out1_source`, `out1_host`, `out1_source_name` … per output

## Not available (compared to NDI Studio Monitor)

Overlay (PiP / alpha), audio mute, recording and true full screen are not exposed by any OMT monitor's remote interface, so they cannot be controlled. *Maximize* is the closest to full screen in OMT Mini. Sienna's OMT Video Monitor (macOS) and the vMix OMT Viewer have no remote interface of their own – use the 16 Out OMT Matrix for source switching.
