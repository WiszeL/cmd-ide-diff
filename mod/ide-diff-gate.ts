// ide-diff-gate — Command Code mod.
//
// In `default` permission mode, every edit_file / write_file that lands inside the workspace is
// re-opened as a native VS Code diff (old snapshot ←→ file on disk) with Accept / Reject buttons,
// served by the companion `ide-diff` extension over a Unix socket / Windows named pipe.
// Reject restores the pre-edit snapshot byte-for-byte. Every other mode is left alone.
//
// See ../README.md for the protocol and the known limits.

import type {ModApi} from '@commandcode/harness';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

// CC_IDE_DIFF_DIR exists so tests can point discovery at a throwaway dir instead of the real one.
const DIR = process.env.CC_IDE_DIFF_DIR ?? path.join(os.homedir(), '.commandcode', 'ide-diff');
const LOG = path.join(DIR, 'gate.log');
const GATED_TOOLS = new Set(['edit_file', 'write_file']);
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const CONNECT_TIMEOUT_MS = 2000;
const BRIDGE_CACHE_MS = 5000;

interface Snapshot {
	readonly exists: boolean;
	readonly content: string;
	readonly mode: number;
}

const ALIASES: Record<string, string> = {
	manual: 'default',
	standard: 'default',
	acceptEdits: 'auto-accept',
	dontAsk: 'dont-ask',
	bypassPermissions: 'bypass',
};

const normalizeMode = (value: string): string => ALIASES[value] ?? value;

// Rotating debug trail — when a gate does not appear, this says which decision bailed.
const debug = (message: string): void => {
	try {
		fs.mkdirSync(DIR, {recursive: true});
		if (fs.existsSync(LOG) && fs.statSync(LOG).size > 1_000_000) fs.rmSync(LOG);
		fs.appendFileSync(LOG, `${new Date().toISOString()} ${message}\n`);
	} catch {}
};

const argvMode = (argv: readonly string[]): string | null => {
	if (argv.includes('--yolo') || argv.includes('--dangerously-skip-permissions')) return 'bypass';
	if (argv.includes('--plan')) return 'plan';
	if (argv.includes('--auto-accept')) return 'auto-accept';
	const index = argv.findIndex((arg) => arg === '--permission-mode' || arg.startsWith('--permission-mode='));
	if (index === -1) return null;
	const inline = argv[index].split('=')[1];
	const value = inline ?? argv[index + 1];
	return value ? normalizeMode(value) : null;
};

const configMode = (): string | null => {
	try {
		const raw = fs.readFileSync(path.join(os.homedir(), '.commandcode', 'config.json'), 'utf8');
		const parsed = JSON.parse(raw) as {permissions?: {defaultMode?: string}};
		const value = parsed.permissions?.defaultMode;
		return typeof value === 'string' ? normalizeMode(value) : null;
	} catch {
		return null;
	}
};

const findBridge = (cwd: string): string | null => {
	let entries: string[];
	try {
		entries = fs.readdirSync(DIR).filter((name) => name.endsWith('.json'));
	} catch {
		return null;
	}

	let best: {socketPath: string; depth: number} | null = null;
	for (const name of entries) {
		try {
			const session = JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8')) as {
				socketPath?: string;
				workspaceFolders?: string[];
			};
			if (typeof session.socketPath !== 'string') continue;
			for (const folder of session.workspaceFolders ?? []) {
				const rel = path.relative(folder, cwd);
				if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
				const depth = folder.split(path.sep).length;
				if (!best || depth >= best.depth) best = {socketPath: session.socketPath, depth};
			}
		} catch {
			// half-written or stale session file — skip
		}
	}
	return best ? best.socketPath : null;
};

const readSnapshot = (filePath: string): Snapshot | null => {
	try {
		const stat = fs.statSync(filePath);
		if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
		return {exists: true, content: fs.readFileSync(filePath, 'utf8'), mode: stat.mode};
	} catch (error) {
		// Only a genuinely absent file is "did not exist". Anything else (EACCES, EIO) means we
		// could not read it — returning "absent" here would make a reject delete a real file.
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return {exists: false, content: '', mode: 0o644};
		}
		return null;
	}
};

const restoreSnapshot = (filePath: string, snapshot: Snapshot): void => {
	if (!snapshot.exists) {
		fs.rmSync(filePath, {force: true});
		return;
	}
	const tmpPath = `${filePath}.cc-diff-revert-${process.pid}`;
	fs.writeFileSync(tmpPath, snapshot.content, {mode: snapshot.mode});
	fs.renameSync(tmpPath, filePath);
};

const isInside = (root: string, filePath: string): boolean => {
	const rel = path.relative(root, filePath);
	return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

// `tool_queued` carries the raw model input, before the harness repair layer renames aliases.
const field = (input: Record<string, unknown>, names: readonly string[]): unknown => {
	for (const name of names) {
		if (input[name] !== undefined && input[name] !== null) return input[name];
	}
	return undefined;
};

interface Projection {
	readonly oldContent: string;
	readonly newContent: string;
}

// Simulate the edit so it can be shown BEFORE the tool runs. Returns null whenever the preview
// could not be trusted — the caller then falls back to the post-write gate.
const projectEdit = (
	toolName: string,
	input: Record<string, unknown>,
	filePath: string,
): Projection | null => {
	let current: string | null = null;
	try {
		const stat = fs.statSync(filePath);
		if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
		current = fs.readFileSync(filePath, 'utf8');
		// A NUL byte means binary: previewing it would show mojibake, so fall back to the gate.
		if (current.slice(0, 8000).includes('\u0000')) return null;
	} catch {
		current = null;
	}

	if (toolName === 'write_file') {
		const content = field(input, ['content', 'file_contents', 'contents']);
		if (typeof content !== 'string') return null;
		return {oldContent: current ?? '', newContent: content};
	}

	const oldString = field(input, ['old_string', 'oldValue', 'oldText']);
	const newString = field(input, ['new_string', 'newValue', 'newText']);
	if (typeof oldString !== 'string' || typeof newString !== 'string') return null;
	if (current === null) return null;
	if (oldString === '') return {oldContent: current, newContent: newString};

	const occurrences = current.split(oldString).length - 1;
	if (occurrences === 0) return null; // the tool's fuzzy cascade handles it, we cannot preview it
	const requested = Number(field(input, ['replacement_count']));
	const limit =
		Number.isFinite(requested) && requested > 0
			? requested
			: input.replace_all === true
				? Infinity
				: 1;
	if (limit === 1 && occurrences > 1) return null; // the tool refuses ambiguity anyway

	let remaining = limit;
	// A function replacer keeps `$&`/`$1` in new_string literal, like a real string replacement.
	const newContent = current.replaceAll(oldString, (match) => {
		if (remaining <= 0) return match;
		remaining -= 1;
		return newString;
	});
	return {oldContent: current, newContent};
};

// Infra problems are worth saying once per session, not once per edit.
const note = (cmd: ModApi, state: {last: string}, message: string): void => {
	if (state.last === message) return;
	state.last = message;
	cmd.ui.notify(message);
};

interface RequestResult {
	readonly socket: net.Socket | null; // non-null only when `hold` kept it open for the caller
	readonly connected: boolean; // false ⇒ never reached the bridge — infrastructure, not a decision
	readonly answered: boolean; // false ⇒ connected (or not) but the peer said nothing usable
}

// One framed request per connection: connect, write, and hand each reply line to `onReply`, which
// returns true once the caller is done. With `hold`, that socket is handed back still open (a
// preview keeps it for the veto); otherwise it is closed. Junk lines are ignored — a peer that
// says nothing coherent simply runs out the window.
const sendRequest = (
	socketPath: string,
	payload: Record<string, unknown>,
	onReply: (reply: {result?: string; reason?: string}) => boolean,
	options: {windowMs: number; hold?: boolean},
): Promise<RequestResult> =>
	new Promise((resolve) => {
		const requestId = crypto.randomUUID();
		const socket = net.connect(socketPath);
		let settled = false;
		let connected = false;
		let answered = false;
		let buffer = '';

		const settle = (keep: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (!keep) socket.destroy();
			resolve({socket: keep ? socket : null, connected, answered});
		};

		const timer = setTimeout(() => settle(false), options.windowMs);
		socket.setTimeout(options.hold === true ? 0 : CONNECT_TIMEOUT_MS + options.windowMs);
		socket.on('timeout', () => settle(false));
		socket.on('error', () => settle(false));
		socket.on('close', () => settle(false));
		socket.on('connect', () => {
			connected = true;
			socket.write(`${JSON.stringify({type: 'request', id: requestId, payload: {...payload, requestId}})}\n`);
		});
		socket.on('data', (data) => {
			buffer += data.toString();
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';
			for (const line of lines) {
				if (!line.trim()) continue;
				let reply: {result?: string; reason?: string};
				try {
					reply = (JSON.parse(line) as {payload?: {result?: string; reason?: string}}).payload ?? {};
				} catch {
					continue;
				}
				if (onReply(reply)) {
					answered = true;
					settle(options.hold === true);
				}
			}
		});
	});

const openDiff = async (
	socketPath: string,
	request: {filePath: string; oldContent: string | null; tabName: string; timeoutMs: number},
): Promise<'accept' | 'reject' | 'unavailable'> => {
	let verdict: 'accept' | 'reject' | null = null;
	const result = await sendRequest(
		socketPath,
		{
			action: 'openDiff',
			filePath: request.filePath,
			oldContent: request.oldContent,
			tabName: request.tabName,
		},
		(reply) => {
			verdict = reply.result === 'accept' ? 'accept' : 'reject';
			return true;
		},
		{windowMs: request.timeoutMs},
	);
	if (result.answered) return verdict ?? 'reject';
	// Connected but silent is a decision (fail closed); never connecting is not.
	return result.connected ? 'reject' : 'unavailable';
};

// Opens the read-only preview and KEEPS THE SOCKET: a Reject click answers on it later.
// Resolves to the socket to hold, or null when the bridge is unreachable.
const holdPreview = async (
	socketPath: string,
	request: {filePath: string; oldContent: string; newContent: string; tabName: string},
	onVeto: () => void,
): Promise<net.Socket | null> => {
	let acked = false;
	const result = await sendRequest(
		socketPath,
		{
			action: 'openPreview',
			filePath: request.filePath,
			oldContent: request.oldContent,
			newContent: request.newContent,
			tabName: request.tabName,
		},
		(reply) => {
			if (!acked) {
				acked = true;
				return true;
			}
			if (reply.result === 'reject') onVeto();
			return false;
		},
		{windowMs: CONNECT_TIMEOUT_MS, hold: true},
	);
	return result.socket;
};

export default function (cmd: ModApi): void {
	cmd.addFlag('ide-diff', {type: 'boolean', default: true, description: 'Enable the IDE diff gate'});
	cmd.addFlag('ide-diff-timeout', {type: 'string', default: '300', description: 'Seconds to wait for an answer'});
	cmd.addFlag('ide-diff-pin', {type: 'string', default: '', description: 'Pin the gate to a mode (e.g. default)'});

	let mode = argvMode(process.argv) ?? configMode() ?? 'default';
	let pinned = false;
	let enabled = true;
	let timeoutMs = 300_000;

	// getFlag is a LIVE method: in the factory the harness is not bound yet and every read
	// returns undefined, which silently discards --mod-option. So the flags are applied on the
	// first hook/command call instead, once.
	let flagsApplied = false;
	const applyFlags = (): void => {
		if (flagsApplied) return;
		flagsApplied = true;
		if (cmd.getFlag('ide-diff') === false) enabled = false;
		const seconds = Number(cmd.getFlag('ide-diff-timeout'));
		if (Number.isFinite(seconds) && seconds > 0) timeoutMs = seconds * 1000;
		const pin = cmd.getFlag('ide-diff-pin');
		if (typeof pin === 'string' && pin.trim()) {
			mode = normalizeMode(pin.trim());
			pinned = true;
		}
		debug(`flags applied enabled=${enabled} timeoutMs=${timeoutMs} mode=${mode} pinned=${pinned}`);
	};
	let gatesOpened = 0;
	const noteState = {last: ''};
	let queue: Promise<unknown> = Promise.resolve();
	const snapshots = new Map<string, Snapshot>();
	let noBridgeUntil = 0;

	// Only the "nothing found" answer is cached: a positive hit is re-scanned so a restarted IDE
	// (new socket path) is picked up on the next gate instead of 5 s later.
	const currentBridge = (): string | null => {
		if (Date.now() < noBridgeUntil) return null;
		const socketPath = findBridge(cmd.cwd);
		if (!socketPath) noBridgeUntil = Date.now() + BRIDGE_CACHE_MS;
		return socketPath;
	};

	debug(
		`factory cwd=${cmd.cwd} argv=${JSON.stringify(process.argv.slice(2))} mode=${mode} enabled=${enabled} timeout=${timeoutMs}`,
	);

	cmd.on('permission_mode_changed', (event) => {
		const next = (event as {mode?: string}).mode;
		debug(`event permission_mode_changed payload=${JSON.stringify(event)}`);
		if (typeof next === 'string' && !pinned) mode = normalizeMode(next);
	});

	// --- prompt-time preview ---------------------------------------------------------------
	// tool_queued is the only event that fires BEFORE the permission check, so it is the only
	// place a diff can be shown while the prompt is still on screen. It cannot block; the veto
	// is recorded here and applied in beforeToolCall, which runs after the prompt is answered.
	const previews = new Map<string, net.Socket>();
	const vetoes = new Set<string>();
	// Tool calls that already resolved: a preview socket arriving after that is too late to show,
	// so it is closed instead of registered (approval can beat the socket round trip).
	const settled = new Set<string>();
	let previewsOpened = 0;
	let vetoesUsed = 0;
	let previewsLate = 0;

	const closePreviews = (why: string): void => {
		settled.clear();
		if (previews.size === 0) return;
		for (const socket of previews.values()) socket.destroy();
		debug(`previews closed (${why}) ×${previews.size}`);
		previews.clear();
	};

	const openPreviewFor = async (event: {
		toolCallId?: string;
		toolName?: string;
		input?: Record<string, unknown>;
	}): Promise<void> => {
		try {
			applyFlags();
			const {toolCallId, toolName, input} = event;
			if (!toolCallId || !toolName || !input || !GATED_TOOLS.has(toolName)) return;
			if (!enabled || mode !== 'default') return;
			const filePath = field(input, ['file_path', 'path', 'filePath']);
			if (typeof filePath !== 'string' || !isInside(cmd.cwd, filePath)) return;

			const projection = projectEdit(toolName, input, filePath);
			if (!projection) {
				debug(`preview ${toolName} ${filePath}: not projectable, the post-write gate covers it`);
				return;
			}
			const bridge = currentBridge();
			if (!bridge) return;

			const socket = await holdPreview(
				bridge,
				{
					filePath,
					oldContent: projection.oldContent,
					newContent: projection.newContent,
					tabName: `${path.basename(filePath)}  —  preview (reject to cancel)`,
				},
				() => {
					vetoes.add(toolCallId);
					debug(`preview veto recorded for ${filePath}`);
				},
			);
			if (!socket) {
				debug(`preview ${toolName} ${filePath}: bridge unreachable`);
				return;
			}
			if (settled.has(toolCallId)) {
				previewsLate += 1;
				socket.destroy();
				debug(`preview ${toolName} ${filePath}: too late, the call already resolved`);
				return;
			}
			socket.on('close', () => previews.delete(toolCallId));
			previews.set(toolCallId, socket);
			previewsOpened += 1;
			debug(`preview opened for ${filePath} (${toolCallId})`);
		} catch (error) {
			debug(`preview failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	};

	cmd.on('tool_queued', (event) => {
		const typed = event as {toolCallId?: string; toolName?: string; input?: Record<string, unknown>};
		if (typed.toolName && GATED_TOOLS.has(typed.toolName)) {
			debug(`queued ${typed.toolName} ${String(field(typed.input ?? {}, ['file_path', 'path', 'filePath']))}`);
		}
		// A fresh queued call reuses nothing: clear any stale marks an earlier call left on this id.
		if (typed.toolCallId) {
			settled.delete(typed.toolCallId);
			vetoes.delete(typed.toolCallId);
		}
		void openPreviewFor(typed);
	});
	cmd.on('tool_denied', () => closePreviews('denied'));
	cmd.on('interrupted', () => closePreviews('interrupted'));
	cmd.on('run_end', () => closePreviews('run_end'));

	cmd.addCommand({
		name: 'ide-diff',
		description: 'IDE diff gate: on | off | pin <mode> | status',
		argumentHint: 'on|off|pin <mode>|status',
		handler: ({args}) => {
			applyFlags();
			const [action, value] = (args ?? '').trim().split(/\s+/);
			if (action === 'on') {
				enabled = true;
				return {message: 'IDE diff gate: on'};
			}
			if (action === 'off') {
				enabled = false;
				return {message: 'IDE diff gate: off'};
			}
			if (action === 'pin') {
				if (value === 'none' || value === '') {
					pinned = false;
					return {message: 'IDE diff gate: mode pin cleared — tracking the live mode again'};
				}
				if (!value) return {message: 'usage: /ide-diff pin <default|plan|auto-accept|bypass|none>'};
				mode = normalizeMode(value);
				pinned = true;
				return {message: `IDE diff gate: mode pinned to ${mode}`};
			}
			const bridge = currentBridge();
			return {
				message:
					`IDE diff gate: ${enabled ? 'on' : 'off'} · mode: ${mode}${pinned ? ' (pinned)' : ''}` +
					` · bridge: ${bridge ?? 'not found'}` +
					` · previews: ${previewsOpened} (${vetoesUsed} vetoed, ${previewsLate} too late)` +
					` · gates: ${gatesOpened}`,
			};
		},
	});

	cmd.hooks({
		beforeToolCall({toolCallId, toolName, input}) {
			if (!GATED_TOOLS.has(toolName)) return undefined;
			applyFlags();
			const filePath = typeof input.file_path === 'string' ? input.file_path : null;
			if (!filePath) {
				debug(`before ${toolName}: no file_path in ${JSON.stringify(Object.keys(input))}`);
				return undefined;
			}
			if (!enabled || mode !== 'default') {
				debug(`before ${toolName} ${filePath}: skipped (enabled=${enabled} mode=${mode})`);
				return undefined;
			}
			// The preview's Reject button was clicked while the prompt was up: the edit never lands.
			if (vetoes.delete(toolCallId)) {
				settled.add(toolCallId);
				previews.get(toolCallId)?.destroy();
				previews.delete(toolCallId);
				vetoesUsed += 1;
				debug(`before ${toolName} ${filePath}: BLOCKED by IDE veto`);
				return {
					block: true,
					additionalContext:
						'Rejected in the IDE diff view — the edit was not applied. Ask what to change, or show a different approach.',
				};
			}
			if (!isInside(cmd.cwd, filePath)) {
				debug(`before ${toolName} ${filePath}: outside workspace ${cmd.cwd}`);
				return undefined;
			}
			const snapshot = readSnapshot(filePath);
			if (snapshot) snapshots.set(filePath, snapshot);
			debug(`before ${toolName} ${filePath}: snapshot exists=${snapshot?.exists}`);
			return undefined;
		},

		async afterToolCall({toolCallId, toolName, input, isError}) {
			if (!GATED_TOOLS.has(toolName)) return undefined;
			applyFlags();
			const filePath = typeof input.file_path === 'string' ? input.file_path : null;
			if (!filePath) return undefined;

			// The edit was already reviewed at prompt time — close the tab and ask nothing more.
			// Destroying the socket is what closes that tab (the extension drops it on disconnect).
			settled.add(toolCallId);
			const preview = previews.get(toolCallId);
			if (preview) {
				previews.delete(toolCallId);
				preview.destroy();
				vetoes.delete(toolCallId);
				debug(`after ${toolName} ${filePath}: previewed at prompt time → no second ask`);
				return undefined;
			}

			if (isError) {
				debug(`after ${toolName} ${filePath}: tool errored, no gate`);
				return undefined;
			}
			if (!enabled || mode !== 'default') {
				debug(`after ${toolName} ${filePath}: skipped (enabled=${enabled} mode=${mode})`);
				return undefined;
			}
			const snapshot = snapshots.get(filePath);
			if (!snapshot) {
				debug(`after ${toolName} ${filePath}: no snapshot (beforeToolCall did not run)`);
				return undefined;
			}
			snapshots.delete(filePath);

			const run = async () => {
				const bridge = currentBridge();
				if (!bridge) {
					debug('gate: no bridge found');
					note(cmd, noteState, 'IDE diff gate: no IDE bridge found — edits apply without review.');
					return undefined;
				}

				gatesOpened += 1;
				debug(`gate: opening diff for ${filePath} via ${bridge}`);
				const verdict = await openDiff(bridge, {
					filePath,
					oldContent: snapshot.exists ? snapshot.content : null,
					tabName: `${path.basename(filePath)}  —  accept or reject`,
					timeoutMs,
				});
				debug(`gate: verdict for ${filePath} = ${verdict}`);

				if (verdict === 'accept') return undefined;

				// The bridge exists but never answered: infrastructure, not a decision → keep the edit.
				if (verdict === 'unavailable') {
					noBridgeUntil = 0;
					note(cmd, noteState, 'IDE diff gate: bridge unreachable — the edit was applied without review.');
					return undefined;
				}

				restoreSnapshot(filePath, snapshot);
				return {
					content: [
						{
							type: 'text' as const,
							text:
								'Edit rejected in the IDE diff view — the file was restored to its previous state.' +
								(snapshot.exists ? '' : ' (the file did not exist before and was removed)'),
						},
					],
					isError: true,
				};
			};

			const result = queue.then(run, run);
			queue = result.catch(() => undefined);
			return result;
		},
	});
}
