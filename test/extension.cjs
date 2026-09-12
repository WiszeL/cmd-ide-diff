// Checks the extension's socket layer, discovery file, and the preview/gate flows with a stubbed
// `vscode` module and a throwaway home. Run with: node test/extension.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

// The extension derives its bridge directory from os.homedir(). Point that at a throwaway dir:
// the real one is shared with a live editor session, and a test must never clean it out.
const ISOLATED_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-diff-ext-home-'));
const DIR = path.join(ISOLATED_HOME, '.commandcode', 'ide-diff');
const opened = [];
const commands = new Map();
const contextValues = new Map();
const tabGroups = {all: [], activeTabGroup: {activeTab: null}};
const tabListeners = [];
const providers = {};

class TabInputTextDiff {
	constructor(original, modified) {
		this.original = original;
		this.modified = modified;
	}
}

const toTab = (original, modified) => ({input: new TabInputTextDiff(original, modified)});

const closeTab = (tab) => {
	tabGroups.all = tabGroups.all.map((group) => ({tabs: group.tabs.filter((t) => t !== tab)}));
	if (tabGroups.activeTabGroup.activeTab === tab) tabGroups.activeTabGroup.activeTab = null;
	for (const listener of tabListeners) listener({closed: [tab], opened: [], changed: []});
};

const vscode = {
	env: {appName: 'Visual Studio Code'},
	Uri: {
		parse: (value) => {
			const match = /^([a-z-]+):(.*)$/.exec(value);
			return {scheme: match[1], path: match[2], fsPath: value};
		},
		file: (fsPath) => ({scheme: 'file', path: fsPath, fsPath}),
	},
	TabInputTextDiff,
	window: {
		createOutputChannel: () => ({appendLine() {}, dispose() {}}),
		showErrorMessage: (message) => console.error(message),
		tabGroups: Object.assign(tabGroups, {
			onDidChangeTabs: (listener) => {
				tabListeners.push(listener);
				return {dispose() {}};
			},
			onDidChangeTabGroups: () => ({dispose() {}}),
			close: async (tab) => closeTab(tab),
		}),
	},
	commands: {
		registerCommand: (name, handler) => {
			commands.set(name, handler);
			return {dispose() {}};
		},
		executeCommand: async (name, ...args) => {
			if (name === 'setContext') {
				contextValues.set(args[0], args[1]);
				return;
			}
			if (name !== 'vscode.diff') return;
			opened.push(args);
			// A real VS Code opens the tab and makes it active; mirror that.
			const tab = toTab(args[0], args[1]);
			tab.label = args[2];
			tabGroups.all = [{tabs: [tab]}];
			tabGroups.activeTabGroup.activeTab = tab;
			for (const listener of tabListeners) listener({closed: [], opened: [tab], changed: []});
		},
	},
	workspace: {
		workspaceFolders: [{uri: {fsPath: '/workspace'}}],
		registerTextDocumentContentProvider: (scheme, provider) => {
			providers[scheme] = provider.provideTextDocumentContent;
			return {dispose() {}};
		},
	},
};

const originalLoad = Module._load;
Module._load = function (request, ...rest) {
	if (request === 'vscode') return vscode;
	if (request === 'os' || request === 'node:os') return {...os, homedir: () => ISOLATED_HOME};
	return originalLoad.call(this, request, ...rest);
};

fs.mkdirSync(DIR, {recursive: true});

const extension = require('../extension/extension.js');

const tick = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

// A connection that can send several requests and read several replies.
const connect = (socketPath) =>
	new Promise((resolve, reject) => {
		const socket = net.connect(socketPath);
		const queue = [];
		const waiters = [];
		let buffer = '';
		socket.on('connect', () =>
			resolve({
				socket,
				send: (payload) =>
					socket.write(`${JSON.stringify({type: 'request', id: payload.requestId ?? 'req', payload})}\n`),
				next: () =>
					new Promise((res) => {
						if (queue.length > 0) res(queue.shift());
						else waiters.push(res);
					}),
			}),
		);
		socket.on('error', reject);
		socket.on('data', (data) => {
			buffer += data.toString();
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';
			for (const line of lines) {
				if (!line.trim()) continue;
				const message = JSON.parse(line);
				const waiter = waiters.shift();
				if (waiter) waiter(message);
				else queue.push(message);
			}
		});
	});

const send = async (socketPath, payload) => {
	const conn = await connect(socketPath);
	conn.send(payload);
	const message = await conn.next();
	conn.socket.destroy();
	return message;
};

const findDiffTab = () =>
	tabGroups.all.flatMap((group) => group.tabs).find((tab) => tab.input?.original?.scheme === 'cc-diff');

const uriDoc = (scheme, requestId) => providers[scheme]({scheme, path: `/${requestId}/file.txt`});

// A hanging check must say where it stopped, not just never finish.
const step = (message) => console.error(`  • ${message}`);

(async () => {
	const context = {subscriptions: []};
	await extension.activate(context);

	const sessionFile = fs.readdirSync(DIR).find((name) => /^code-.+\.json$/.test(name));
	assert.ok(sessionFile, 'session file must be written');
	const session = JSON.parse(fs.readFileSync(path.join(DIR, sessionFile), 'utf8'));
	assert.equal(session.ideName, 'code');
	assert.ok(session.socketPath, 'session file must carry the socket path');
	assert.deepEqual(session.workspaceFolders, ['/workspace']);
	if (process.platform !== 'win32') {
		assert.equal(fs.statSync(DIR).mode & 0o777, 0o700, 'session dir must be 0700');
		assert.equal(fs.statSync(session.socketPath).mode & 0o777, 0o600, 'socket must be 0600');
	}

	step('activated');
	const pong = await send(session.socketPath, {action: 'ping'});
	assert.equal(pong.payload.result, 'pong');

	// --- preview: opened at prompt time, both sides virtual, veto button only ---------------
	const previewConn = await connect(session.socketPath);
	previewConn.send({
		action: 'openPreview',
		requestId: 'preview-case',
		filePath: '/workspace/p.txt',
		oldContent: 'before\n',
		newContent: 'after\n',
		tabName: 'p.txt',
	});
	step('preview sent');
	const ack = await previewConn.next();
	assert.equal(ack.payload.result, 'preview', 'a preview must answer immediately');
	assert.equal(opened.length, 1, 'vscode.diff must be called for the preview');
	assert.equal(opened[0][0].scheme, 'cc-diff', 'preview left side is virtual');
	assert.equal(opened[0][1].scheme, 'cc-diff-new', 'preview right side is the projection');
	assert.equal(uriDoc('cc-diff', 'preview-case'), 'before\n', 'left side must serve the current content');
	assert.equal(uriDoc('cc-diff-new', 'preview-case'), 'after\n', 'right side must serve the projection');
	assert.ok(findDiffTab(), 'the preview tab must be open');
	assert.equal(contextValues.get('ccDiffVetoActive'), true, 'preview shows the veto button');
	assert.equal(contextValues.get('ccDiffGateActive'), false, 'preview must not show accept');

	// Reject in the preview answers on the socket the mod is holding.
	step('preview acked');
	await commands.get('ccDiff.reject')();
	step('veto clicked');
	const veto = await previewConn.next();
	assert.equal(veto.payload.result, 'reject');
	assert.equal(veto.payload.reason, 'veto');
	assert.equal(findDiffTab(), undefined, 'the preview tab closes on veto');
	previewConn.socket.destroy();

	// --- preview: a dropped socket closes the tab and votes for nothing ---------------------
	const previewConn2 = await connect(session.socketPath);
	previewConn2.send({
		action: 'openPreview',
		requestId: 'preview-drop',
		filePath: '/workspace/q.txt',
		oldContent: 'x\n',
		newContent: 'y\n',
	});
	step('drop preview sent');
	await previewConn2.next();
	assert.ok(findDiffTab(), 'second preview tab must be open');
	previewConn2.socket.destroy();
	step('drop preview acked');
	await tick();
	assert.equal(findDiffTab(), undefined, 'dropping the preview socket closes its tab');

	// --- gate: unchanged behaviour ---------------------------------------------------------
	const acceptAnswer = send(session.socketPath, {
		action: 'openDiff',
		requestId: 'gate-accept',
		filePath: '/workspace/a.txt',
		oldContent: 'old\n',
		tabName: 'a.txt',
	});
	step('gate sent');
	await tick();
	assert.equal(opened.at(-1)[1].fsPath, '/workspace/a.txt', 'the gate right side is the real file');
	assert.equal(uriDoc('cc-diff', 'gate-accept'), 'old\n');
	assert.equal(contextValues.get('ccDiffGateActive'), true, 'the gate shows both buttons');
	assert.equal(contextValues.get('ccDiffVetoActive'), false, 'the gate is not a veto tab');
	step('gate shown');
	await commands.get('ccDiff.accept')();
	step('accept clicked');
	assert.equal((await acceptAnswer).payload.result, 'accept');
	assert.equal(findDiffTab(), undefined, 'accept closes the tab');

	// --- gate: closing the tab is a reject --------------------------------------------------
	const closedAnswer = send(session.socketPath, {
		action: 'openDiff',
		requestId: 'gate-closed',
		filePath: '/workspace/b.txt',
		oldContent: 'b\n',
		tabName: 'b.txt',
	});
	await tick();
	closeTab(findDiffTab());
	const closed = (await closedAnswer).payload;
	assert.equal(closed.result, 'reject');
	assert.equal(closed.reason, 'closed');

	// unknown action surfaces as an error, not a hang
	const bad = await send(session.socketPath, {action: 'nope'});
	assert.equal(bad.type, 'error');
	assert.equal(bad.payload.code, 'UNKNOWN_ACTION');

	// deactivate cleans up its session file so a stale entry can never point at a dead socket
	extension.deactivate();
	await tick();
	for (const subscription of context.subscriptions.slice()) subscription.dispose?.();
	assert.equal(fs.existsSync(path.join(DIR, sessionFile)), false, 'deactivate must remove the session file');

	fs.rmSync(ISOLATED_HOME, {recursive: true, force: true});
	console.log('extension OK — preview (veto, drop), gate (accept, close→reject), ping, cleanup');
	process.exit(0);
})().catch((error) => {
	console.error(error);
	process.exit(1);
});
