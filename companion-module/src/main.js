const { InstanceBase, InstanceStatus, Regex, combineRgb, runEntrypoint } = require('@companion-module/base')
const net = require('node:net')
const api = require('./api')

const WHITE = combineRgb(255, 255, 255)
const BLACK = combineRgb(0, 0, 0)
const RED = combineRgb(255, 0, 0)
const YELLOW = combineRgb(255, 255, 0)

const range = (n) => Array.from({ length: n }, (_, i) => i + 1)
const NONE = { id: '', label: 'None' }

class OmtMonitorInstance extends InstanceBase {
	async init(config) {
		this.state = null
		this.sources = []
		this.definedFor = null
		await this.configUpdated(config)
	}

	async configUpdated(config) {
		this.config = config
		this.stopPolling()
		this.state = null
		this.sources = []
		this.definedFor = null
		this.closeControl()
		this.updateDefinitions()
		this.updateStatus(InstanceStatus.Connecting)
		if (this.isControl) this.connectControl()
		else this.poll()
	}

	async destroy() {
		this.stopPolling()
		this.closeControl()
	}

	get isMini() {
		return !this.config.device || this.config.device === 'omtmini'
	}

	get isControl() {
		return this.config.device === 'viewercontrol'
	}

	get base() {
		return `http://${this.config.host}:${this.config.port}`
	}

	stopPolling() {
		clearTimeout(this.timer)
		this.timer = null
		this.generation = (this.generation || 0) + 1
	}

	async poll() {
		const gen = this.generation
		try {
			const state = this.isMini ? await api.miniGetState(this.base) : await api.playerGetState(this.base)
			if (gen !== this.generation) return
			this.applyState(state)
			this.updateStatus(InstanceStatus.Ok)
		} catch (e) {
			if (gen !== this.generation) return
			this.updateStatus(InstanceStatus.ConnectionFailure, e.message)
		}
		if (gen === this.generation) this.timer = setTimeout(() => this.poll(), Number(this.config.interval) || 1000)
	}

	applyState(state) {
		this.state = state
		this.sources = this.isMini ? api.miniSources(state) : state.sources
		this.updateDefinitions()
		this.updateVariables()
		this.checkFeedbacks()
	}

	// Re-send definitions only when the device type or source list changed.
	updateDefinitions() {
		const outputs = this.isControl && this.state ? this.state.outputs : []
		const key = JSON.stringify([this.config.device, this.sources, outputs])
		if (key === this.definedFor) return
		this.definedFor = key
		if (this.isControl) this.defineControl()
		else if (this.isMini) this.defineMini()
		else this.definePlayer()
	}

	labelOf(address) {
		if (!address) return 'None'
		return (this.sources.find((s) => s.id === address) || {}).label || address
	}

	async send(cmd) {
		if (!cmd) return
		try {
			await api.miniCommand(this.base, cmd)
			setTimeout(() => this.pollNow(), 150) // pick up the result without waiting a full interval
		} catch (e) {
			this.log('error', `Command ${JSON.stringify(cmd)} failed: ${e.message}`)
		}
	}

	pollNow() {
		this.stopPolling()
		this.poll()
	}

	// ---- option helpers -------------------------------------------------------

	sourceOption(withNone) {
		const choices = withNone ? [NONE, ...this.sources] : this.sources
		return {
			type: 'dropdown',
			id: 'source',
			label: 'Source',
			choices,
			default: choices[0] ? choices[0].id : '',
			allowCustom: true,
		}
	}

	slotOption(withAny) {
		const choices = range(api.MAX_VIEWERS).map((n) => ({ id: String(n), label: `Viewer ${n}` }))
		if (withAny) choices.unshift({ id: '0', label: 'Any viewer' })
		return { type: 'dropdown', id: 'slot', label: 'Viewer (ordered by screen position)', choices, default: '1' }
	}

	targetOption() {
		return {
			type: 'dropdown',
			id: 'target',
			label: 'Window',
			choices: [
				...range(api.MAX_VIEWERS).map((n) => ({ id: String(n), label: `Viewer ${n}` })),
				{ id: 'mv', label: 'Multiview' },
			],
			default: '1',
		}
	}

	// ---- OMT Mini -------------------------------------------------------------

	defineMini() {
		const st = () => this.state || {}
		const layoutChoices = api.MV_LAYOUTS.map((l, i) => ({ id: String(i), label: l }))
		const tileOption = { type: 'number', id: 'tile', label: 'Tile', default: 1, min: 1, max: api.MAX_TILES }
		const winState = ['maximize', 'restore', 'minimize']

		this.setActionDefinitions({
			viewer_source: {
				name: 'Viewer: set source (None closes the viewer)',
				options: [this.slotOption(false), this.sourceOption(true)],
				callback: (a) => this.send(api.viewerSourceCommand(st(), a.options.slot, a.options.source)),
			},
			viewer_open: {
				name: 'Viewer: open new viewer',
				options: [this.sourceOption(false)],
				callback: (a) => this.send({ kind: 'open', address: a.options.source }),
			},
			window_close: {
				name: 'Window: close',
				options: [this.targetOption()],
				callback: (a) => {
					const id = api.windowId(st(), a.options.target)
					if (id !== null) return this.send({ kind: 'close', id })
				},
			},
			window_state: {
				name: 'Window: maximize / restore / minimize',
				options: [
					this.targetOption(),
					{
						type: 'dropdown',
						id: 'state',
						label: 'State',
						choices: [...winState.map((s) => ({ id: s, label: s })), { id: 'toggle', label: 'toggle maximize' }],
						default: 'maximize',
					},
				],
				callback: (a) => {
					const id = api.windowId(st(), a.options.target)
					if (id === null) return
					let state = a.options.state
					if (state === 'toggle') state = st().windows.find((w) => w.id === id).maximized ? 'restore' : 'maximize'
					return this.send({ kind: 'state', id, state })
				},
			},
			window_move: {
				name: 'Window: move / resize',
				options: [
					this.targetOption(),
					{ type: 'number', id: 'x', label: 'X', default: 0, min: -32768, max: 32768 },
					{ type: 'number', id: 'y', label: 'Y', default: 0, min: -32768, max: 32768 },
					{ type: 'number', id: 'width', label: 'Width', default: 1920, min: 1, max: 8192 },
					{ type: 'number', id: 'height', label: 'Height', default: 1080, min: 1, max: 8192 },
				],
				callback: (a) => {
					const id = api.windowId(st(), a.options.target)
					const { x, y, width, height } = a.options
					if (id !== null) return this.send({ kind: 'move', id, x, y, width, height })
				},
			},
			multiview_open: {
				name: 'Multiview: open',
				options: [],
				callback: () => this.send({ kind: 'openmv' }),
			},
			multiview_layout: {
				name: 'Multiview: layout',
				options: [{ type: 'dropdown', id: 'layout', label: 'Layout', choices: layoutChoices, default: '0' }],
				callback: (a) => this.send({ kind: 'layout', index: Number(a.options.layout) }),
			},
			multiview_tile: {
				name: 'Multiview: set tile source',
				options: [tileOption, this.sourceOption(true)],
				callback: (a) => this.send({ kind: 'tile', index: a.options.tile - 1, address: a.options.source }),
			},
			add_source: {
				name: 'Add source by address (host or host:port)',
				options: [{ type: 'textinput', id: 'address', label: 'Address', default: '' }],
				callback: (a) => this.send({ kind: 'add', address: a.options.address.trim() }),
			},
			custom_command: {
				name: 'Custom command (JSON)',
				options: [{ type: 'textinput', id: 'json', label: 'JSON', default: '{"kind":"openmv"}' }],
				callback: (a) => {
					try {
						return this.send(JSON.parse(a.options.json))
					} catch (e) {
						this.log('error', `Invalid JSON: ${e.message}`)
					}
				},
			},
		})

		const viewerHas = (slot, address) => {
			const viewers = api.viewerSlots(st())
			if (slot === '0') return viewers.some((w) => w.address === address)
			const w = viewers[Number(slot) - 1]
			return w ? w.address === address : address === ''
		}

		this.setFeedbackDefinitions({
			viewer_source: {
				type: 'boolean',
				name: 'Viewer shows source',
				defaultStyle: { color: WHITE, bgcolor: RED },
				options: [this.slotOption(true), this.sourceOption(true)],
				callback: (f) => viewerHas(f.options.slot, f.options.source),
			},
			tile_source: {
				type: 'boolean',
				name: 'Multiview tile shows source',
				defaultStyle: { color: BLACK, bgcolor: YELLOW },
				options: [tileOption, this.sourceOption(true)],
				callback: (f) => ((st().multiview_tiles || [])[f.options.tile - 1] || '') === f.options.source,
			},
			window_maximized: {
				type: 'boolean',
				name: 'Window is maximized',
				defaultStyle: { color: WHITE, bgcolor: RED },
				options: [this.targetOption()],
				callback: (f) => {
					const id = api.windowId(st(), f.options.target)
					return id !== null && st().windows.find((w) => w.id === id).maximized
				},
			},
			window_open: {
				type: 'boolean',
				name: 'Window exists',
				defaultStyle: { color: WHITE, bgcolor: combineRgb(0, 128, 0) },
				options: [this.targetOption()],
				callback: (f) => api.windowId(st(), f.options.target) !== null,
			},
			multiview_layout: {
				type: 'boolean',
				name: 'Multiview layout is',
				defaultStyle: { color: BLACK, bgcolor: YELLOW },
				options: [{ type: 'dropdown', id: 'layout', label: 'Layout', choices: layoutChoices, default: '0' }],
				callback: (f) => String(st().multiview_layout) === f.options.layout,
			},
		})

		const defs = [
			{ variableId: 'host', name: 'Monitor computer name' },
			{ variableId: 'version', name: 'OMT Mini version' },
			{ variableId: 'viewer_count', name: 'Number of open viewers' },
			{ variableId: 'multiview_open', name: 'Multiview window open' },
			{ variableId: 'multiview_layout', name: 'Multiview layout' },
		]
		for (const n of range(api.MAX_VIEWERS)) {
			defs.push(
				{ variableId: `viewer${n}_source`, name: `Viewer ${n}: source complete name` },
				{ variableId: `viewer${n}_host`, name: `Viewer ${n}: source host` },
				{ variableId: `viewer${n}_name`, name: `Viewer ${n}: source name` },
			)
		}
		for (const n of range(api.MAX_TILES)) defs.push({ variableId: `tile${n}`, name: `Multiview tile ${n} source` })
		this.setVariableDefinitions(defs)

		const presets = {}
		const button = (category, name, text, down, feedbacks = []) => ({
			type: 'button',
			category,
			name,
			style: { text, size: 'auto', color: WHITE, bgcolor: BLACK },
			steps: [{ down, up: [] }],
			feedbacks,
		})
		;[NONE, ...this.sources].forEach((s, i) => {
			const options = { slot: '1', source: s.id }
			presets[`v1_${i}`] = button('Viewer 1 source', s.label, s.label, [{ actionId: 'viewer_source', options }], [
				{ feedbackId: 'viewer_source', options, style: { color: WHITE, bgcolor: RED } },
			])
		})
		api.MV_LAYOUTS.forEach((l, i) => {
			const options = { layout: String(i) }
			presets[`mvl_${i}`] = button('Multiview', `Layout ${l}`, `MV\\n${l}`, [{ actionId: 'multiview_layout', options }], [
				{ feedbackId: 'multiview_layout', options, style: { color: BLACK, bgcolor: YELLOW } },
			])
		})
		presets.mv_open = button('Multiview', 'Open multiview', 'Open\\nMV', [{ actionId: 'multiview_open', options: {} }], [
			{ feedbackId: 'window_open', options: { target: 'mv' }, style: { color: WHITE, bgcolor: combineRgb(0, 128, 0) } },
		])
		presets.v1_max = button('Window', 'Viewer 1 toggle maximize', 'V1\\nMAX', [
			{ actionId: 'window_state', options: { target: '1', state: 'toggle' } },
		], [{ feedbackId: 'window_maximized', options: { target: '1' }, style: { color: WHITE, bgcolor: RED } }])
		presets.v1_close = button('Window', 'Viewer 1 close', 'V1\\nCLOSE', [{ actionId: 'window_close', options: { target: '1' } }])
		presets.v1_info = button('Info', 'Viewer 1 source', '$(this:viewer1_name)', [])
		this.setPresetDefinitions(presets)
	}

	// ---- omtplayer ------------------------------------------------------------

	definePlayer() {
		const current = () => (this.state ? this.state.current : '')

		this.setActionDefinitions({
			source: {
				name: 'Set source',
				options: [this.sourceOption(false)],
				callback: async (a) => {
					try {
						await api.playerSetSource(this.base, a.options.source)
						setTimeout(() => this.pollNow(), 150)
					} catch (e) {
						this.log('error', `Set source failed: ${e.message}`)
					}
				},
			},
		})

		this.setFeedbackDefinitions({
			source: {
				type: 'boolean',
				name: 'Source is active',
				defaultStyle: { color: WHITE, bgcolor: RED },
				options: [this.sourceOption(false)],
				callback: (f) => current() === f.options.source,
			},
		})

		this.setVariableDefinitions([
			{ variableId: 'source', name: 'Active source complete name' },
			{ variableId: 'source_host', name: 'Active source host' },
			{ variableId: 'source_name', name: 'Active source name' },
		])

		const presets = {}
		this.sources.forEach((s, i) => {
			const options = { source: s.id }
			presets[`src_${i}`] = {
				type: 'button',
				category: 'Sources',
				name: s.label,
				style: { text: s.label, size: 'auto', color: WHITE, bgcolor: BLACK },
				steps: [{ down: [{ actionId: 'source', options }], up: [] }],
				feedbacks: [{ feedbackId: 'source', options, style: { color: WHITE, bgcolor: RED } }],
			}
		})
		this.setPresetDefinitions(presets)
	}

	// ---- Stockwerk Matrix Router (TCP, formerly OMT Viewer Control) ----

	connectControl() {
		const gen = this.generation
		const ctl = api.newControlState()
		const sock = net.connect({ host: this.config.host, port: Number(this.config.port) })
		this.sock = sock
		let buf = ''
		sock.setEncoding('utf8')
		sock.setKeepAlive(true, 5000)
		sock.on('connect', () => this.updateStatus(InstanceStatus.Ok))
		sock.on('data', (d) => {
			buf += d
			let changed = false
			let nl
			while ((nl = buf.indexOf('\n')) >= 0) {
				const line = buf.slice(0, nl).replace(/\r$/, '')
				buf = buf.slice(nl + 1)
				if (line.startsWith('ERR ')) this.log('warn', `Matrix Router: ${line}`)
				changed = api.applyControlLine(ctl, line) || changed
			}
			if (buf.length > 65536) buf = ''
			if (changed) {
				this.state = ctl
				this.sources = ctl.sources.map((s) => ({ id: s, label: s }))
				this.updateDefinitions()
				this.updateVariables()
				this.checkFeedbacks()
			}
		})
		sock.on('error', (e) => this.updateStatus(InstanceStatus.ConnectionFailure, e.message))
		sock.on('close', () => {
			if (gen !== this.generation) return
			this.updateStatus(InstanceStatus.ConnectionFailure, 'Disconnected')
			this.timer = setTimeout(() => this.connectControl(), 2000)
		})
	}

	closeControl() {
		if (this.sock) this.sock.destroy()
		this.sock = null
	}

	sendLine(line) {
		line = line.replace(/[\r\n]/g, ' ').trimEnd()
		if (this.sock && !this.sock.destroyed && this.sock.readyState === 'open') this.sock.write(line + '\r\n')
		else this.log('error', `Not connected, dropped: ${line}`)
	}

	defineControl() {
		const n = (this.state && this.state.outputs.length) || 4
		const routes = () => (this.state ? this.state.routes : [])
		const chOption = {
			type: 'dropdown',
			id: 'channel',
			label: 'Output',
			choices: range(n).map((c) => ({ id: String(c), label: `Output ${c}` })),
			default: '1',
		}

		this.setActionDefinitions({
			route: {
				name: 'Route output to source (None clears)',
				options: [chOption, this.sourceOption(true)],
				callback: (a) => this.sendLine(`SET ${a.options.channel} ${a.options.source}`),
			},
			raw: {
				name: 'Send raw command',
				options: [{ type: 'textinput', id: 'line', label: 'Command', default: 'GET' }],
				callback: (a) => this.sendLine(a.options.line),
			},
		})

		this.setFeedbackDefinitions({
			route_source: {
				type: 'boolean',
				name: 'Output is routed to source',
				defaultStyle: { color: WHITE, bgcolor: RED },
				options: [chOption, this.sourceOption(true)],
				callback: (f) => (routes()[f.options.channel - 1] || '') === f.options.source,
			},
		})

		const defs = [{ variableId: 'version', name: 'Matrix Router version' }]
		for (const c of range(n)) {
			defs.push(
				{ variableId: `out${c}_name`, name: `Output ${c}: virtual source to select in the viewer` },
				{ variableId: `out${c}_source`, name: `Output ${c}: routed source complete name` },
				{ variableId: `out${c}_host`, name: `Output ${c}: routed source host` },
				{ variableId: `out${c}_source_name`, name: `Output ${c}: routed source name` },
			)
		}
		this.setVariableDefinitions(defs)

		const presets = {}
		for (const c of range(n)) {
			;[NONE, ...this.sources].forEach((s, i) => {
				const options = { channel: String(c), source: s.id }
				presets[`o${c}_${i}`] = {
					type: 'button',
					category: `Output ${c}`,
					name: s.label,
					style: { text: s.label, size: 'auto', color: WHITE, bgcolor: BLACK },
					steps: [{ down: [{ actionId: 'route', options }], up: [] }],
					feedbacks: [{ feedbackId: 'route_source', options, style: { color: WHITE, bgcolor: RED } }],
				}
			})
		}
		this.setPresetDefinitions(presets)
	}

	// ---- variables ------------------------------------------------------------

	updateVariables() {
		const v = {}
		const s = this.state
		if (this.isControl) {
			v.version = s.version
			s.outputs.forEach((out, i) => {
				const complete = s.routes[i] || 'None'
				const { host, name } = api.splitName(complete)
				Object.assign(v, {
					[`out${i + 1}_name`]: out,
					[`out${i + 1}_source`]: complete,
					[`out${i + 1}_host`]: host,
					[`out${i + 1}_source_name`]: name,
				})
			})
		} else if (this.isMini) {
			const viewers = api.viewerSlots(s)
			v.host = s.host || ''
			v.version = s.version || ''
			v.viewer_count = viewers.length
			v.multiview_open = !!s.multiview_open
			v.multiview_layout = api.MV_LAYOUTS[s.multiview_layout] || ''
			for (const n of range(api.MAX_VIEWERS)) {
				const w = viewers[n - 1]
				const complete = w ? this.labelOf(w.address) : 'None'
				const { host, name } = api.splitName(complete)
				v[`viewer${n}_source`] = complete
				v[`viewer${n}_host`] = host
				v[`viewer${n}_name`] = name
			}
			const tiles = s.multiview_tiles || []
			for (const n of range(api.MAX_TILES)) v[`tile${n}`] = this.labelOf(tiles[n - 1])
		} else {
			const complete = s.current || 'None'
			const { host, name } = api.splitName(complete)
			Object.assign(v, { source: complete, source_host: host, source_name: name })
		}
		this.setVariableValues(v)
	}

	getConfigFields() {
		return [
			{
				type: 'static-text',
				id: 'info',
				width: 12,
				label: 'Information',
				value:
					'OMT Mini: enable the web control panel under Settings &gt; Web (default port 7400, no password).<br/>omtplayer (Raspberry Pi 5): web interface on port 8080.<br/>Stockwerk Matrix Router: TCP port 6390 – point the viewer (vMix OMT Viewer, Sienna, OBS …) once at &quot;HOST (Matrix Out 1)&quot;.',
			},
			{
				type: 'dropdown',
				id: 'device',
				label: 'Device',
				width: 12,
				choices: [
					{ id: 'omtmini', label: 'OMT Mini (Windows)' },
					{ id: 'omtplayer', label: 'omtplayer (Raspberry Pi 5)' },
					{ id: 'viewercontrol', label: 'Stockwerk Matrix Router (TCP) – any OMT viewer' },
				],
				default: 'omtmini',
			},
			{ type: 'textinput', id: 'host', label: 'Host or IP', width: 8, default: '127.0.0.1', regex: Regex.HOSTNAME },
			{ type: 'number', id: 'port', label: 'Port (Mini 7400, Pi 8080, Matrix Router 6390)', width: 4, default: 7400, min: 1, max: 65535 },
			{ type: 'number', id: 'interval', label: 'Poll interval (ms)', width: 4, default: 1000, min: 250, max: 10000 },
		]
	}
}

runEntrypoint(OmtMonitorInstance, [])
