// End-to-end check: real module code against mock OMT Mini + omtplayer servers.
// Run: node test/test.js
const assert = require('node:assert/strict')
const http = require('node:http')
const Module = require('node:module')
const api = require('../src/api')

// ---- mock OMT Mini ----
let nextId = 100
const mini = {
	host: 'PLAYOUT-PC',
	version: '1.4.0',
	sources: [
		{ name: 'CAM1 (Camera 1)', address: 'omt://10.0.0.11:6400' },
		{ name: 'CAM2 (Camera 2)', address: 'omt://10.0.0.12:6400' },
	],
	windows: [],
	multiview_layout: 0,
	multiview_tiles: [],
	multiview_open: false,
}
const viewer = (address, x, y) => ({ id: nextId++, kind: 'viewer', title: '', address, x, y, width: 960, height: 540, minimized: false, maximized: false })
function miniApply(c) {
	const i = mini.windows.findIndex((w) => w.id === c.id)
	switch (c.kind) {
		case 'open': mini.windows.push(viewer(c.address, 50 * mini.windows.length, 0)); break
		case 'source': { const old = mini.windows.splice(i, 1)[0]; mini.windows.push(viewer(c.address, old.x, old.y)); break }
		case 'close': mini.windows.splice(i, 1); break
		case 'state': mini.windows[i].maximized = c.state === 'maximize'; break
		case 'layout': mini.multiview_layout = c.index; break
		case 'tile': mini.multiview_tiles[c.index] = c.address; break
		case 'openmv': mini.multiview_open = true; mini.windows.push({ id: 1, kind: 'multiview', x: 0, y: 600, width: 1, height: 1 }); break
		default: return false
	}
	return true
}

// ---- mock omtplayer ----
let playerCurrent = 'CAM1 (Camera 1)'
const playerAll = ['CAM1 (Camera 1)', 'CAM2 (Camera 2)']
const playerPage = () =>
	`<select name="cboSource"><option value="${playerCurrent}" selected>${playerCurrent}</option>\n` +
	playerAll.filter((a) => a !== playerCurrent).map((a) => `<option value="${a}">${a}</option>`).join('\n') + '</select>'

const server = http.createServer((req, res) => {
	let body = ''
	req.on('data', (d) => (body += d))
	req.on('end', () => {
		if (req.url === '/api/state') return res.end(JSON.stringify(mini))
		if (req.url === '/api/command') return res.end(JSON.stringify({ ok: miniApply(JSON.parse(body)) }))
		if (req.url === '/') {
			if (req.method === 'POST') {
				const f = new URLSearchParams(body)
				if (f.has('cmdChange')) playerCurrent = f.get('cboSource')
			}
			return res.end(playerPage())
		}
		res.statusCode = 404
		res.end()
	})
})


// ---- mock 4 Out OMT Matrix (TCP) ----
const net = require('node:net')
const vcRoutes = ['', '', '', '']
const vcSources = ['CAM1 (Camera 1)', 'CAM2 (Camera 2)']
const vcClients = new Set()
const vcServer = net.createServer((sock) => {
	vcClients.add(sock)
	sock.on('close', () => vcClients.delete(sock))
	sock.write(['HELLO 4OutOMTMatrix 1.1.0 4', ...vcRoutes.map((_, i) => `OUT ${i + 1} PC (Matrix Out ${i + 1})`),
		...vcRoutes.map((r, i) => `CH ${i + 1} ${r}`.trimEnd()), `SOURCES ${vcSources.length}`, ...vcSources.map((s) => `SRC ${s}`)].join('\r\n') + '\r\n')
	let buf = ''
	sock.on('data', (d) => {
		buf += d
		let nl
		while ((nl = buf.indexOf('\n')) >= 0) {
			const m = /^SET (\d)(?: (.*))?$/.exec(buf.slice(0, nl).replace(/\r$/, ''))
			buf = buf.slice(nl + 1)
			if (!m) { sock.write('ERR unknown command\r\n'); continue }
			vcRoutes[m[1] - 1] = m[2] || ''
			for (const c of vcClients) c.write(`CH ${m[1]} ${vcRoutes[m[1] - 1]}`.trimEnd() + '\r\n')
		}
	})
})

// ---- fake Companion host ----
const real = require('@companion-module/base')
let Instance
class FakeBase {
	constructor() { this.vars = {}; this.logs = [] }
	setActionDefinitions(d) { this.actions = d }
	setFeedbackDefinitions(d) { this.feedbacks = d }
	setVariableDefinitions(d) { this.varDefs = d }
	setPresetDefinitions(d) { this.presets = d }
	setVariableValues(v) { Object.assign(this.vars, v) }
	checkFeedbacks() {}
	updateStatus(s, m) { this.status = s; this.statusMsg = m }
	log(l, m) { this.logs.push(`${l}: ${m}`) }
}
const origLoad = Module._load
Module._load = function (req, ...rest) {
	if (req === '@companion-module/base') return { ...real, InstanceBase: FakeBase, runEntrypoint: (c) => (Instance = c) }
	return origLoad.call(this, req, ...rest)
}
require('../src/main')

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const fb = (inst, id, options) => inst.feedbacks[id].callback({ options })
const act = async (inst, id, options) => { await inst.actions[id].callback({ options }); await wait(400) }

async function main() {
	// pure helpers
	assert.deepEqual(api.splitName('CAM1 (Camera 1)'), { host: 'CAM1', name: 'Camera 1' })
	assert.deepEqual(api.parsePlayerPage('<option value="A &amp; B" selected>x</option><option value="C">'), {
		current: 'A & B',
		sources: [{ id: 'A & B', label: 'A & B' }, { id: 'C', label: 'C' }],
	})

	await new Promise((r) => server.listen(0, '127.0.0.1', r))
	const port = server.address().port
	const [cam1, cam2] = mini.sources.map((s) => s.address)

	// ---- OMT Mini ----
	const m = new Instance()
	await m.init({ device: 'omtmini', host: '127.0.0.1', port, interval: 200 })
	await wait(300)
	assert.equal(m.status, real.InstanceStatus.Ok)
	assert.equal(m.actions.viewer_source.options[1].choices.length, 3) // None + 2 sources
	assert.ok(Object.keys(m.presets).length > 5)

	await act(m, 'viewer_source', { slot: '1', source: cam1 }) // no viewer yet -> opens
	assert.equal(mini.windows.length, 1)
	assert.equal(m.vars.viewer1_name, 'Camera 1')
	assert.equal(fb(m, 'viewer_source', { slot: '1', source: cam1 }), true)

	await act(m, 'viewer_source', { slot: '1', source: cam2 }) // switch keeps slot despite new id
	assert.equal(mini.windows.length, 1)
	assert.equal(m.vars.viewer1_source, 'CAM2 (Camera 2)')
	assert.equal(fb(m, 'viewer_source', { slot: '0', source: cam2 }), true)

	await act(m, 'window_state', { target: '1', state: 'toggle' })
	assert.equal(fb(m, 'window_maximized', { target: '1' }), true)

	await act(m, 'multiview_open', {})
	await act(m, 'multiview_layout', { layout: '5' })
	await act(m, 'multiview_tile', { tile: 2, source: cam1 })
	assert.equal(m.vars.multiview_layout, '1 + 5')
	assert.equal(m.vars.tile2, 'CAM1 (Camera 1)')
	assert.equal(fb(m, 'tile_source', { tile: 2, source: cam1 }), true)
	assert.equal(fb(m, 'window_open', { target: 'mv' }), true)

	await act(m, 'viewer_source', { slot: '1', source: '' }) // None closes
	assert.equal(m.vars.viewer_count, 0)
	assert.equal(m.vars.viewer1_source, 'None')
	await m.destroy()

	// ---- omtplayer ----
	const p = new Instance()
	await p.init({ device: 'omtplayer', host: '127.0.0.1', port, interval: 200 })
	await wait(300)
	assert.equal(p.status, real.InstanceStatus.Ok)
	assert.equal(p.vars.source_name, 'Camera 1')
	await act(p, 'source', { source: 'CAM2 (Camera 2)' })
	assert.equal(p.vars.source, 'CAM2 (Camera 2)')
	assert.equal(fb(p, 'source', { source: 'CAM2 (Camera 2)' }), true)
	assert.equal(Object.keys(p.presets).length, 2)
	await p.destroy()


	// ---- 4 Out OMT Matrix (TCP); parser also accepts the 1.0 greeting ----
	// parser: split SOURCES block, CH with spaces, out-of-range ignored
	const st = api.newControlState()
	;['HELLO OMTViewerControl 1.0.0 2', 'OUT 1 PC (Viewer Control 1)', 'CH 1 A (Cam One)', 'CH 9 x', 'SOURCES 2', 'SRC A (Cam One)']
		.forEach((l) => api.applyControlLine(st, l))
	assert.deepEqual(st.sources, [])
	assert.equal(api.applyControlLine(st, 'SRC B (Cam Two)'), true)
	assert.deepEqual(st.sources, ['A (Cam One)', 'B (Cam Two)'])
	assert.deepEqual(st.routes, ['A (Cam One)', ''])

	await new Promise((r) => vcServer.listen(0, '127.0.0.1', r))
	const v = new Instance()
	await v.init({ device: 'viewercontrol', host: '127.0.0.1', port: vcServer.address().port })
	await wait(300)
	assert.equal(v.status, real.InstanceStatus.Ok)
	assert.equal(v.vars.out1_name, 'PC (Matrix Out 1)')
	assert.equal(v.actions.route.options[1].choices.length, 3)
	assert.equal(Object.keys(v.presets).length, 12) // 4 outputs x (None + 2)
	await act(v, 'route', { channel: '2', source: 'CAM2 (Camera 2)' })
	assert.equal(vcRoutes[1], 'CAM2 (Camera 2)')
	assert.equal(v.vars.out2_source_name, 'Camera 2')
	assert.equal(fb(v, 'route_source', { channel: '2', source: 'CAM2 (Camera 2)' }), true)
	await act(v, 'route', { channel: '2', source: '' })
	assert.equal(v.vars.out2_source, 'None')
	// reconnect after server drops the connection
	for (const c of vcClients) c.destroy()
	await wait(2600)
	assert.equal(v.status, real.InstanceStatus.Ok)
	await v.destroy()
	vcServer.close()

	// ---- unreachable ----
	const d = new Instance()
	await d.init({ device: 'omtmini', host: '127.0.0.1', port: 1, interval: 200 })
	await wait(300)
	assert.equal(d.status, real.InstanceStatus.ConnectionFailure)
	await d.destroy()

	server.close()
	console.log('all checks passed')
}

main().catch((e) => { console.error(e); process.exit(1) })
