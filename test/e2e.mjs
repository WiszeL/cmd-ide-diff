// End-to-end check for the mod: real socket, real files, fake `cmd` API.
// The bridge dir is redirected (CC_IDE_DIFF_DIR) so this never touches a live editor session.
// Run with: node test/e2e.mjs   (Node 24 strips the mod's TypeScript types natively)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-diff-e2e-'));
const DIR = path.join(tmpRoot, 'bridge');
process.env.CC_IDE_DIFF_DIR = DIR;

const modUrl = pathToFileURL(path.join(import.meta.dirname, '..', 'mod', 'ide-diff-gate.ts')).href;
const target = path.join(tmpRoot, 'src.txt');
const sessionFile = path.join(DIR, `zz-e2e-${process.pid}.json`);

let verdict = 'reject';
const requests = [];
const previewSockets = [];
let previewCloses = 0;
let currentSocketPath = null;

const server = net.createServer((socket) => {
	let buffer = '';
	socket.on('data', (data) => {
		buffer += data.toString();
		const lines = buffer.split('\n');
		buffer = lines.pop() ?? '';
		for (const line of lines) {
			if (!line.trim()) continue;
			const message = JSON.parse(line);
			const {action} = message.payload;
			if (action === 'ping') {
				socket.write(`${JSON.stringify({type: 'response', id: message.id, payload: {result: 'pong'}})}\n`);
				continue;
			}
			requests.push({action, payload: message.payload});
			if (action === 'openPreview') {
				previewSockets.push(socket);
				socket.on('close', () => {
					previewCloses += 1;
				});
				socket.write(`${JSON.stringify({type: 'response', id: message.id, payload: {result: 'preview'}})}\n`);
				continue;
			}
			socket.write(
				`${JSON.stringify({type: 'response', id: message.id, payload: {result: verdict, reason: 'test'}})}\n`,
			);
		}
	});
});

const hooks = [];
const commands = new Map();
const listeners = new Map();
const notices = [];

const emit = (event, payload) => {
	for (const handler of listeners.get(event) ?? []) handler(payload);
};
const on = (event, handler) => {
	listeners.set(event, [...(listeners.get(event) ?? []), handler]);
};

const fakeCmd = {
	cwd: tmpRoot,
	addFlag: () => ({dispose() {}}),
	getFlag: () => undefined,
	addCommand: (command) => commands.set(command.name, command.handler),
	on,
	hooks: (hookSet) => hooks.push(hookSet),
	ui: {notify: (message) => notices.push(message), setStatus: () => {}, capabilities: {status: false}},
};

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

// This test needs the real bridge dir (the mod reads it), so it must never litter: a crash
// mid-run would otherwise leave a stale session file behind for the next run to trip over.
const cleanup = () => {
	fs.rmSync(sessionFile, {force: true});
	if (currentSocketPath) fs.rmSync(currentSocketPath, {force: true});
	fs.rmSync(tmpRoot, {recursive: true, force: true});
};
process.on('exit', cleanup);
process.on('uncaughtException', (error) => {
	console.error(error);
	cleanup();
	process.exit(1);
});
const before = (name, input, id = `call-${name}`) =>
	hooks[0].beforeToolCall({toolCallId: id, toolName: name, input, state: {}});
const after = (name, input, id = `call-${name}`, isError = false) =>
	hooks[0].afterToolCall({toolCallId: id, toolName: name, input, isError, state: {}});
const queued = async (name, input, id = `call-${name}`) => {
	emit('tool_queued', {toolCallId: id, toolName: name, input});
	await tick();
};

const lastRequest = (action) => [...requests].reverse().find((request) => request.action === action);

await new Promise((resolve, reject) => {
	server.once('error', reject);
	server.listen(0, '127.0.0.1', resolve);
});
currentSocketPath = path.join(DIR, `zz-e2e-${process.pid}.sock`);
server.close();
fs.mkdirSync(DIR, {recursive: true});
fs.rmSync(currentSocketPath, {force: true});
await new Promise((resolve, reject) => {
	server.once('error', reject);
	server.listen(currentSocketPath, resolve);
});
fs.writeFileSync(sessionFile, JSON.stringify({socketPath: currentSocketPath, workspaceFolders: [tmpRoot]}));

const mod = (await import(modUrl)).default;
mod(fakeCmd);

// 1. exact-match edit: a preview opens at prompt time with the projected content
fs.writeFileSync(target, 'original\n');
await queued('edit_file', {file_path: target, old_string: 'original', new_string: 'changed'});
const preview = lastRequest('openPreview');
assert.ok(preview, 'an exact-match edit must preview');
assert.equal(preview.payload.oldContent, 'original\n');
assert.equal(preview.payload.newContent, 'changed\n');
assert.equal(previewSockets.length, 1, 'the preview socket is held open for the veto');
assert.ok(!lastRequest('openDiff'), 'no gate must open before the write');

// 2. no veto → the edit lands, the preview closes, and NO second gate appears
const allowed = await before('edit_file', {file_path: target, old_string: 'original', new_string: 'changed'});
assert.equal(allowed, undefined, 'without a veto the tool runs');
fs.writeFileSync(target, 'changed\n');
const previewSocket = previewSockets.at(-1);
const closesBefore = previewCloses;
const afterPreview = await after('edit_file', {file_path: target, old_string: 'original', new_string: 'changed'});
assert.equal(afterPreview, undefined, 'a previewed edit is not gated a second time');
assert.ok(!lastRequest('openDiff'), 'no gate after a previewed edit');
assert.equal(fs.readFileSync(target, 'utf8'), 'changed\n');
// That disconnect is what closes the preview tab: dropping it leaves the tab open forever.
await tick();
assert.equal(previewCloses, closesBefore + 1, 'the preview socket must close when the edit resolves');
assert.ok(previewSocket, 'the preview socket is the one that closed');

// 3. veto → the tool is blocked and the file is untouched
previewSockets.length = 0;
await queued('edit_file', {file_path: target, old_string: 'changed', new_string: 'vetoed'});
const vetoSocket = previewSockets.at(-1);
assert.ok(vetoSocket, 'a preview must be open before vetoing');
vetoSocket.write(`${JSON.stringify({type: 'response', id: 'v', payload: {result: 'reject', reason: 'veto'}})}\n`);
await tick();
const blocked = await before('edit_file', {file_path: target, old_string: 'changed', new_string: 'vetoed'});
assert.equal(blocked?.block, true, 'the veto must block the tool');
assert.match(blocked.additionalContext, /Rejected in the IDE diff view/);
assert.equal(fs.readFileSync(target, 'utf8'), 'changed\n', 'a vetoed edit must never touch the file');

// 3b. approval can beat the socket round trip: a preview that lands after the call resolved must
// be closed, not registered (this is the exact race a live pinned run showed).
verdict = 'accept';
const lateInput = {file_path: target, old_string: 'changed', new_string: 'raced'};
emit('tool_queued', {toolCallId: 'call-late', toolName: 'edit_file', input: lateInput});
await before('edit_file', lateInput, 'call-late');
fs.writeFileSync(target, 'raced\n');
await after('edit_file', lateInput, 'call-late'); // resolves before the preview can register
await tick();
// Assert on the mod's own tally: the server-side close count is timing-dependent.
const lateStatus = commands.get('ide-diff')({args: 'status'}).message;
if (!/\(1 vetoed, 1 too late\)/.test(lateStatus)) {
	const trail = fs.readFileSync(path.join(DIR, 'gate.log'), 'utf8').split('\n').slice(-10).join('\n');
	console.error(`late-preview trail:\n${trail}\nstatus: ${lateStatus}`);
}
assert.match(lateStatus, /\(1 vetoed, 1 too late\)/, 'a late preview must be closed by the guard, not shown');
assert.equal(fs.readFileSync(target, 'utf8'), 'raced\n', 'the raced edit still lands');

// 4. a fuzzy edit (old_string not present verbatim) cannot be previewed → the post-write gate covers it
requests.length = 0;
verdict = 'reject';
await queued('edit_file', {file_path: target, old_string: 'CHANGED', new_string: 'x'});
assert.ok(!lastRequest('openPreview'), 'an unpreviewable edit must not open a preview');
await before('edit_file', {file_path: target, old_string: 'CHANGED', new_string: 'x'});
fs.writeFileSync(target, 'edited-by-the-tool\n');
const gated = await after('edit_file', {file_path: target, old_string: 'CHANGED', new_string: 'x'});
assert.ok(lastRequest('openDiff'), 'an unpreviewable edit falls back to the post-write gate');
assert.equal(gated?.isError, true, 'rejecting the fallback gate reports failure');
assert.equal(fs.readFileSync(target, 'utf8'), 'raced\n', 'the fallback gate still restores the snapshot');

// 5. accepting the fallback gate keeps the edit
requests.length = 0;
verdict = 'accept';
await queued('edit_file', {file_path: target, old_string: 'NOT-THERE', new_string: 'x'});
await before('edit_file', {file_path: target, old_string: 'NOT-THERE', new_string: 'x'});
fs.writeFileSync(target, 'kept\n');
const accepted = await after('edit_file', {file_path: target, old_string: 'NOT-THERE', new_string: 'x'});
assert.equal(accepted, undefined, 'accepting the gate keeps the tool result');
assert.equal(fs.readFileSync(target, 'utf8'), 'kept\n');

// 6. write_file: a new file previews with an empty left side
requests.length = 0;
const fresh = path.join(tmpRoot, 'fresh.txt');
await queued('write_file', {file_path: fresh, content: 'brand new\n'});
const freshPreview = lastRequest('openPreview');
assert.ok(freshPreview, 'write_file must preview');
assert.equal(freshPreview.payload.oldContent, '', 'a new file previews against nothing');
assert.equal(freshPreview.payload.newContent, 'brand new\n');
await before('write_file', {file_path: fresh, content: 'brand new\n'});
fs.writeFileSync(fresh, 'brand new\n');
await after('write_file', {file_path: fresh, content: 'brand new\n'});
assert.equal(fs.existsSync(fresh), true);

// 7. auto-accept disables previews entirely
emit('permission_mode_changed', {mode: 'auto-accept'});
requests.length = 0;
await queued('edit_file', {file_path: target, old_string: 'kept', new_string: 'auto'});
assert.ok(!lastRequest('openPreview'), 'auto-accept must not preview');
const silent = await before('edit_file', {file_path: target, old_string: 'kept', new_string: 'auto'});
assert.equal(silent, undefined);

// 8. a denied call closes the preview sockets
emit('permission_mode_changed', {mode: 'default'});
previewSockets.length = 0;
await queued('edit_file', {file_path: target, old_string: 'kept', new_string: 'denied'});
const openSocket = previewSockets.at(-1);
assert.ok(openSocket && !openSocket.destroyed, 'the preview socket is alive before the denial');
emit('tool_denied', {});
await tick();
assert.equal(openSocket.destroyed, true, 'a denied call must close its preview socket');

// 9. a stale bridge (dead socket) must fail OPEN: no preview, the edit stays, the user is told
emit('permission_mode_changed', {mode: 'default'});
await new Promise((resolve) => setTimeout(resolve, 5100)); // let the mod's 5 s bridge cache expire
const deadSocket = path.join(DIR, `zz-dead-${process.pid}.sock`);
fs.rmSync(deadSocket, {force: true});
fs.writeFileSync(sessionFile, JSON.stringify({socketPath: deadSocket, workspaceFolders: [tmpRoot]}));
const noticesBefore = notices.length;
await queued('edit_file', {file_path: target, old_string: 'kept', new_string: 'stale'});
await before('edit_file', {file_path: target, old_string: 'kept', new_string: 'stale'});
fs.writeFileSync(target, 'edit-without-bridge\n');
const stale = await after('edit_file', {file_path: target, old_string: 'kept', new_string: 'stale'});
assert.equal(stale, undefined, 'an unreachable bridge must not fail the edit');
assert.equal(fs.readFileSync(target, 'utf8'), 'edit-without-bridge\n');
assert.ok(notices.length > noticesBefore, 'the user must be told the gate could not run');

// Back to the live bridge — the stale-socket case above repointed discovery at a dead path.
fs.writeFileSync(sessionFile, JSON.stringify({socketPath: currentSocketPath, workspaceFolders: [tmpRoot]}));

// 10. a NUL byte means binary → no preview, the edit stands
requests.length = 0;
const binary = path.join(tmpRoot, 'blob.bin');
fs.writeFileSync(binary, Buffer.from([0x00, 0x01, 0x02, 0x00, 0x41]));
await queued('write_file', {file_path: binary, content: 'text now\n'});
assert.ok(!lastRequest('openPreview'), 'a binary file must not be previewed');

// 11. an unreadable file yields no snapshot, so there is nothing to gate (no delete risk)
if (process.getuid?.() !== 0) {
	requests.length = 0;
	const locked = path.join(tmpRoot, 'locked.txt');
	fs.writeFileSync(locked, 'secret\n');
	fs.chmodSync(locked, 0o000);
	await queued('edit_file', {file_path: locked, old_string: 'secret', new_string: 'x'});
	await before('edit_file', {file_path: locked, old_string: 'secret', new_string: 'x'});
	const lockedResult = await after('edit_file', {file_path: locked, old_string: 'secret', new_string: 'x'});
	assert.ok(!lastRequest('openDiff'), 'an unreadable file must not reach the gate');
	assert.equal(lockedResult, undefined, 'an unreadable file must not be reverted or deleted');
	assert.equal(fs.existsSync(locked), true, 'the file must still exist');
	fs.chmodSync(locked, 0o644);
}

// 12. rejecting a brand-new file removes it (covers restoreSnapshot's removal branch)
requests.length = 0;
verdict = 'reject';
const created = path.join(tmpRoot, 'created-then-rejected.txt');
const missingInput = {file_path: created, old_string: 'not-there', new_string: 'x'};
await queued('edit_file', missingInput); // unpreviewable → the post-write gate covers it
await before('edit_file', missingInput);
fs.writeFileSync(created, 'created by the tool\n');
const removed = await after('edit_file', missingInput);
assert.equal(removed?.isError, true, 'the fallback gate reports the rejection');
assert.equal(fs.existsSync(created), false, 'rejecting a new file must remove it');

// 13. /ide-diff status reports previews, vetoes, gates and the live mode
fs.writeFileSync(sessionFile, JSON.stringify({socketPath: currentSocketPath, workspaceFolders: [tmpRoot]}));
const status = commands.get('ide-diff')({args: 'status'}).message;
assert.match(status, /previews: \d+ \(1 vetoed, 1 too late\)/);
assert.match(status, /mode: default/);

// 14. no litter: the redirect keeps this test's files inside its own temp dir
const realDir = path.join(os.homedir(), '.commandcode', 'ide-diff');
const stray = fs.existsSync(realDir)
	? fs.readdirSync(realDir).filter((name) => name.startsWith('zz-'))
	: [];
assert.deepEqual(stray, [], 'the test must leave nothing in the real bridge dir');

server.close();
cleanup();

console.log('e2e OK — preview at queue time, veto blocks, previewed edits skip the gate, fuzzy edits fall back');
