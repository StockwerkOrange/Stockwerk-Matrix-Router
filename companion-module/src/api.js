// HTTP access and pure helpers for both supported OMT monitors.
//   OMT Mini  (Windows): GET /api/state (JSON), POST /api/command (JSON)
//   omtplayer (Pi 5)   : GET / (HTML with <select>), POST / (form cmdChange + cboSource)

const TIMEOUT_MS = 2000

const MV_LAYOUTS = ['2 x 2', '3 x 2', '3 x 3', '4 x 3', '4 x 4', '1 + 5', '1 + 7']
const MAX_VIEWERS = 8
const MAX_TILES = 16

async function request(url, init = {}) {
	const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })
	if (!res.ok) throw new Error(`HTTP ${res.status}`)
	return res
}

// ---- OMT Mini ---------------------------------------------------------------

async function miniGetState(base) {
	return (await request(`${base}/api/state`)).json()
}

async function miniCommand(base, cmd) {
	const res = await request(`${base}/api/command`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(cmd),
	})
	const body = await res.json()
	if (!body.ok) throw new Error(body.message || 'command rejected')
	return body
}

// Viewer slots: OMT Mini replaces the window (new id) when its source changes but
// keeps the rectangle, so ordering by position gives slots that survive a switch.
function viewerSlots(state) {
	return (state.windows || [])
		.filter((w) => w.kind === 'viewer')
		.sort((a, b) => a.y - b.y || a.x - b.x || a.id - b.id)
}

// Window target: 'mv' or a viewer slot number (1-based). Returns id or null.
function windowId(state, target) {
	if (target === 'mv') return (state.windows || []).some((w) => w.kind === 'multiview') ? 1 : null
	const w = viewerSlots(state)[Number(target) - 1]
	return w ? w.id : null
}

// Command for "show <address> in viewer <slot>": switch, open new, or close (address '').
function viewerSourceCommand(state, slot, address) {
	const id = windowId(state, slot)
	if (address === '') return id === null ? null : { kind: 'close', id }
	return id === null ? { kind: 'open', address } : { kind: 'source', id, address }
}

function miniSources(state) {
	return (state.sources || []).map((s) => ({ id: s.address, label: s.name || s.address }))
}

// ---- omtplayer --------------------------------------------------------------

function decodeHtml(s) {
	return s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
}

// The page lists the current source first, marked "selected", then all discovered ones.
function parsePlayerPage(html) {
	const sources = []
	let current = ''
	for (const m of html.matchAll(/<option value="([^"]*)"( selected)?>/g)) {
		const value = decodeHtml(m[1])
		if (m[2]) current = value
		if (value !== '' && !sources.includes(value)) sources.push(value)
	}
	return { current, sources: sources.map((s) => ({ id: s, label: s })) }
}

async function playerGetState(base) {
	return parsePlayerPage(await (await request(`${base}/`)).text())
}

async function playerSetSource(base, source) {
	await request(`${base}/`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ cmdChange: 'Change', cboSource: source }).toString(),
	})
}

// ---- Stockwerk Matrix Router (TCP, line based) -----------------------------------

function newControlState() {
	return { outputs: [], routes: [], sources: [], pending: null, pendingCount: 0, version: '' }
}

// Applies one line from the Matrix Router. Returns true when the visible state changed.
// The server sends a SOURCES <n> block (followed by n SRC lines) in one piece.
function applyControlLine(st, line) {
	const sp = line.indexOf(' ')
	const cmd = sp < 0 ? line : line.slice(0, sp)
	const rest = sp < 0 ? '' : line.slice(sp + 1)
	if (st.pending) {
		if (cmd === 'SRC') {
			st.pending.push(rest)
			if (st.pending.length < st.pendingCount) return false
			st.sources = st.pending
			st.pending = null
			return true
		}
		st.pending = null // interrupted block, keep the previous list
	}
	const sp2 = rest.indexOf(' ')
	const i = Number(sp2 < 0 ? rest : rest.slice(0, sp2)) - 1
	const value = sp2 < 0 ? '' : rest.slice(sp2 + 1)
	switch (cmd) {
		case 'HELLO': {
			const parts = rest.split(' ') // HELLO <app> <version> <outputs>
			const n = Math.min(Number(parts[2]) || 0, 16)
			st.version = parts[1] || ''
			st.outputs = Array(n).fill('')
			st.routes = Array(n).fill('')
			return true
		}
		case 'OUT':
		case 'CH':
			if (!(i >= 0 && i < st.outputs.length)) return false
			;(cmd === 'OUT' ? st.outputs : st.routes)[i] = value
			return true
		case 'SOURCES':
			st.pendingCount = Number(rest) || 0
			if (st.pendingCount > 0) {
				st.pending = []
				return false
			}
			st.sources = []
			return true
		default:
			return false
	}
}

// ---- shared -----------------------------------------------------------------

// "HOST (Source Name)" -> { host, name }
function splitName(complete) {
	const m = /^(.*?) \((.*)\)$/.exec(complete || '')
	return m ? { host: m[1], name: m[2] } : { host: complete || '', name: complete || '' }
}

module.exports = {
	MV_LAYOUTS,
	MAX_VIEWERS,
	MAX_TILES,
	miniGetState,
	miniCommand,
	viewerSlots,
	windowId,
	viewerSourceCommand,
	miniSources,
	parsePlayerPage,
	playerGetState,
	playerSetSource,
	newControlState,
	applyControlLine,
	splitName,
}
