"use strict";

const vscode = require("vscode");
const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const SCHEME = "cc-diff";
const SCHEME_NEW = "cc-diff-new";
const SESSION_DIR = path.join(os.homedir(), ".commandcode", "ide-diff");
const OUT = vscode.window.createOutputChannel("Command Code Diff Gate");

const MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
// One connection per open diff tab, held for the whole prompt: same-file edits each keep their own
// preview, so this must clear a realistic batch with room to spare.
const MAX_CONNECTIONS = 64;
const IDLE_TIMEOUT_MS = 60_000;
// A preview waits on a human reading a terminal prompt, so its socket must outlive the default.
const PREVIEW_IDLE_TIMEOUT_MS = 30 * 60_000;

const log = (message) => OUT.appendLine(`[${new Date().toISOString()}] ${message}`);

/**
 * One entry per open diff tab.
 * - `preview` — opened when the permission prompt appears, both sides virtual (the file has not
 *   changed yet), no accept button, `notify` writes a veto on the socket the mod is holding.
 * - `gate` — the post-write review, the real file on the right, `notify` resolves the awaiting call.
 * @type {Map<string, {notify: ((verdict: string) => void) | null, phase: 'preview' | 'gate', oldContent: string | null, newContent: string | null, filePath: string, socket: net.Socket | null, answered: boolean}>}
 */
const pending = new Map();

const detectIdeName = () => {
	const appName = vscode.env.appName.toLowerCase();
	if (appName.includes("cursor")) return "cursor";
	if (appName.includes("windsurf")) return "windsurf";
	return "code";
};

const ensureSessionDir = () => {
	fs.mkdirSync(SESSION_DIR, {recursive: true, mode: 0o700});
	if (process.platform !== "win32") {
		try {
			fs.chmodSync(SESSION_DIR, 0o700);
		} catch {}
	}
};

const atomicWriteFile = (filePath, data, mode) => {
	const tmpPath = `${filePath}.tmp`;
	removeFileQuietly(tmpPath);
	fs.writeFileSync(tmpPath, data, {mode});
	fs.renameSync(tmpPath, filePath);
};

const removeFileQuietly = (filePath) => {
	try {
		fs.unlinkSync(filePath);
	} catch {}
};

const requestIdFromUri = (uri) => {
	if (uri.scheme !== SCHEME && uri.scheme !== SCHEME_NEW) return null;
	const segments = uri.path.split("/").filter(Boolean);
	return segments.length > 0 ? segments[0] : null;
};

const diffUris = (requestId, filePath) => {
	const name = encodeURIComponent(path.basename(filePath));
	return {
		left: vscode.Uri.parse(`${SCHEME}:/${requestId}/${name}`),
		right: vscode.Uri.parse(`${SCHEME_NEW}:/${requestId}/${name}`),
	};
};

const findDiffTab = (requestId) => {
	for (const group of vscode.window.tabGroups.all) {
		for (const tab of group.tabs) {
			if (requestIdOfTab(tab) === requestId) return tab;
		}
	}
	return null;
};

// A diff tab of ours, or null — the one place the "is this our tab" test lives.
const requestIdOfTab = (tab) => {
	const input = tab?.input;
	if (!(input instanceof vscode.TabInputTextDiff)) return null;
	return requestIdFromUri(input.original);
};

const tabTitle = (request) => request.tabName ?? path.basename(request.filePath);

// The buttons a diff tab shows depend on which phase its request is in.
const activeEntry = () => {
	const requestId = requestIdOfTab(vscode.window.tabGroups.activeTabGroup?.activeTab);
	const entry = requestId ? pending.get(requestId) : undefined;
	return entry ? {requestId, phase: entry.phase} : null;
};

const refreshGateContext = async () => {
	const active = activeEntry();
	await Promise.all([
		vscode.commands.executeCommand("setContext", "ccDiffGateActive", active?.phase === "gate"),
		vscode.commands.executeCommand("setContext", "ccDiffVetoActive", active?.phase === "preview"),
	]);
};

// One answer per request; every other resolution path is a no-op afterwards.
const resolveRequest = async (requestId, verdict) => {
	const entry = pending.get(requestId);
	if (!entry || entry.answered) return;
	entry.answered = true;
	pending.delete(requestId);

	const tab = findDiffTab(requestId);
	if (tab) await vscode.window.tabGroups.close(tab);
	await refreshGateContext();
	if (entry.notify) entry.notify(verdict);
	log(`resolved ${requestId} → ${verdict} (${entry.phase})`);
};

// A closed preview is a cancelled review, never a veto — only the button votes.
// The socket goes too: the mod drops its entry when it sees the disconnect.
const discardRequest = async (requestId) => {
	const entry = pending.get(requestId);
	if (!entry) return;
	pending.delete(requestId);
	const tab = findDiffTab(requestId);
	if (tab) await vscode.window.tabGroups.close(tab);
	await refreshGateContext();
	entry.socket?.destroy();
	log(`discarded ${requestId} (${entry.phase})`);
};

// A gate must be declined by whoever ends it; a preview just disappears. The one policy seam.
const settleByPhase = (requestId, entry, gateVerdict) =>
	entry.phase === "gate" ? resolveRequest(requestId, gateVerdict) : discardRequest(requestId);

const answerActiveTab = async (verdict) => {
	const active = activeEntry();
	if (active) await resolveRequest(active.requestId, verdict);
};

// Last writer wins for unanswered GATES only. Previews are never superseded: every edit keeps its
// own tab, socket and verdict until its own call resolves.
const supersedePendingForFile = async (filePath, exceptRequestId) => {
	for (const [requestId, entry] of [...pending]) {
		if (entry.phase !== "gate") continue;
		if (entry.filePath === filePath && requestId !== exceptRequestId && !entry.answered) {
			await resolveRequest(requestId, "reject:superseded");
		}
	}
};

const openDiff = async (request, socket) => {
	const {left} = diffUris(request.requestId, request.filePath);
	// The gate's right side is the real file: what you see is what is on disk, and it stays editable.
	const right = vscode.Uri.file(request.filePath);
	const title = tabTitle(request);

	const verdict = new Promise((resolve) => {
		pending.set(request.requestId, {
			notify: resolve,
			phase: "gate",
			oldContent: request.oldContent,
			newContent: null,
			filePath: request.filePath,
			socket,
			answered: false,
		});
	});

	await supersedePendingForFile(request.filePath, request.requestId);
	await vscode.commands.executeCommand("vscode.diff", left, right, title, {preview: false});
	await refreshGateContext();
	return verdict;
};

// Read-only preview of the projection, opened while the permission prompt is on screen.
// The socket is held open: a Reject click answers on it.
const openPreview = async (request, socket) => {
	const {left, right} = diffUris(request.requestId, request.filePath);
	const title = tabTitle(request);

	pending.set(request.requestId, {
		// A preview has exactly one meaningful answer, and it is always "no".
		notify: () => send(socket, {type: "response", id: request.requestId, payload: {result: "reject", reason: "veto"}}),
		phase: "preview",
		oldContent: request.oldContent ?? "",
		newContent: request.newContent ?? "",
		filePath: request.filePath,
		socket,
		answered: false,
	});

	await vscode.commands.executeCommand("vscode.diff", left, right, title, {preview: false, preserveFocus: true});
	// Opening a diff is async: the entry can be gone by the time it lands (the mod's socket died, a
	// window reload, a dispose). Then the tab it just left behind must go with it.
	if (!pending.has(request.requestId)) {
		const tab = findDiffTab(request.requestId);
		if (tab) await vscode.window.tabGroups.close(tab);
		return;
	}
	await refreshGateContext();
};

// --- socket server -----------------------------------------------------------

const send = (socket, message) => {
	try {
		socket.write(`${JSON.stringify(message)}\n`);
	} catch (error) {
		log(`failed to send: ${error}`);
	}
};

const handleMessage = async (socket, line) => {
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		send(socket, {type: "error", id: null, payload: {message: "invalid JSON", code: "PARSE_ERROR"}});
		return;
	}
	if (message?.type !== "request" || !message.payload) return;
	const {id, payload} = message;
	const opensADiff = payload.action === "openPreview" || payload.action === "openDiff";
	if (opensADiff && (typeof payload.filePath !== "string" || !path.isAbsolute(payload.filePath))) {
		send(socket, {type: "error", id, payload: {message: "filePath must be absolute", code: "BAD_INPUT"}});
		return;
	}

	try {
		if (payload.action === "ping") {
			send(socket, {type: "response", id, payload: {result: "pong", ideName: detectIdeName()}});
			return;
		}
		if (payload.action === "openPreview") {
			// The socket is held open past this reply — a Reject click answers on it.
			socket.setTimeout(PREVIEW_IDLE_TIMEOUT_MS);
			await openPreview(payload, socket);
			send(socket, {type: "response", id, payload: {result: "preview"}});
			return;
		}
		if (payload.action === "openDiff") {
			// A human may take minutes: the mod's own window governs how long this waits, so the
			// generic idle timeout must not fire first and close the tab out from under them.
			socket.setTimeout(0);
			const verdict = await openDiff(payload, socket);
			const [result, reason] = verdict.split(":");
			send(socket, {type: "response", id, payload: {result, reason: reason ?? null}});
			return;
		}
		send(socket, {type: "error", id, payload: {message: `unknown action: ${payload.action}`, code: "UNKNOWN_ACTION"}});
	} catch (error) {
		log(`error handling ${payload.action}: ${error}`);
		send(socket, {
			type: "error",
			id,
			payload: {message: error instanceof Error ? error.message : "unknown error", code: "INTERNAL_ERROR"},
		});
	}
};

const createServer = (socketPath) => {
	const connections = new Set();
	const server = net.createServer((socket) => {
		if (connections.size >= MAX_CONNECTIONS) {
			log(`connection cap (${MAX_CONNECTIONS}) reached; rejecting`);
			socket.destroy();
			return;
		}
		connections.add(socket);
		socket.on("close", () => connections.delete(socket));
		socket.setTimeout(IDLE_TIMEOUT_MS);
		socket.on("timeout", () => socket.destroy());
		// The mod went away: an unanswered gate is a reject, an open preview just closes.
		socket.on("close", () => {
			for (const [requestId, entry] of [...pending]) {
				if (entry.socket !== socket || entry.answered) continue;
				void settleByPhase(requestId, entry, "reject:disconnected");
			}
		});

		let buffer = "";
		socket.on("data", async (data) => {
			if (Buffer.byteLength(buffer, "utf-8") + data.length > MAX_BUFFER_BYTES) {
				log("buffer cap exceeded; dropping connection");
				socket.destroy();
				return;
			}
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) {
				if (!line.trim()) continue;
				if (Buffer.byteLength(line, "utf-8") > MAX_MESSAGE_BYTES) {
					log("message cap exceeded; dropping connection");
					socket.destroy();
					return;
				}
				await handleMessage(socket, line);
			}
		});
	});

	server.on("error", (error) => log(`server error: ${error.message}`));
	return server;
};

// --- activation --------------------------------------------------------------

async function activate(context) {
	const shortId = crypto.randomUUID().slice(0, 8);
	const ideName = detectIdeName();
	const isWindows = process.platform === "win32";
	const socketPath = isWindows
		? `\\\\.\\pipe\\commandcode-ide-diff-${shortId}`
		: path.join(SESSION_DIR, `${ideName}-${shortId}.sock`);
	const sessionFile = path.join(SESSION_DIR, `${ideName}-${shortId}.json`);

	context.subscriptions.push(
		// Both sides of a preview are virtual; the gate's left side is the pre-edit snapshot.
		vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
			provideTextDocumentContent: (uri) => {
				const requestId = requestIdFromUri(uri);
				return (requestId && pending.get(requestId)?.oldContent) ?? "";
			},
		}),
		vscode.workspace.registerTextDocumentContentProvider(SCHEME_NEW, {
			provideTextDocumentContent: (uri) => {
				const requestId = requestIdFromUri(uri);
				return (requestId && pending.get(requestId)?.newContent) ?? "";
			},
		}),
		vscode.commands.registerCommand("ccDiff.accept", () => answerActiveTab("accept")),
		vscode.commands.registerCommand("ccDiff.reject", () => answerActiveTab("reject:button")),
		vscode.window.tabGroups.onDidChangeTabs((event) => {
			for (const tab of event.closed) {
				const requestId = requestIdOfTab(tab);
				const entry = requestId ? pending.get(requestId) : undefined;
				if (!entry) continue;
				// Closing a gate declines it; closing a preview only cancels the review.
				void settleByPhase(requestId, entry, "reject:closed");
			}
			void refreshGateContext();
		}),
		vscode.window.tabGroups.onDidChangeTabGroups(() => void refreshGateContext()),
		OUT,
	);

	if (!isWindows) {
		ensureSessionDir();
		removeFileQuietly(socketPath);
	}

	const server = createServer(socketPath);

	try {
		await new Promise((resolve, reject) => {
			server.once("error", reject);
			server.listen(socketPath, () => {
				if (!isWindows) {
					try {
						fs.chmodSync(socketPath, 0o600);
					} catch (error) {
						log(`chmod socket failed: ${error}`);
					}
				}
				resolve();
			});
		});
	} catch (error) {
		log(`failed to start server: ${error}`);
		void vscode.window.showErrorMessage("Command Code Diff Gate: failed to start the socket server.");
		return;
	}

	ensureSessionDir();
	try {
		atomicWriteFile(
			sessionFile,
			JSON.stringify({
				socketPath,
				workspaceFolders: vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [],
				pid: process.pid,
				ideName,
				timestamp: Date.now(),
			}),
			0o600,
		);
	} catch (error) {
		log(`failed to write session file: ${error}`);
	}

	context.subscriptions.push({
		dispose: () => {
			teardown();
			server.close();
			removeFileQuietly(sessionFile);
			if (!isWindows) removeFileQuietly(socketPath);
		},
	});

	log(`server started on ${socketPath}`);
}

// Releasing the editor must not vote: a gate declines, a preview just disappears.
const teardown = () => {
	for (const [requestId, entry] of [...pending]) {
		if (entry.answered) continue;
		void settleByPhase(requestId, entry, "reject:reload");
	}
};

exports.activate = activate;
exports.deactivate = teardown;
