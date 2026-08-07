import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { computeMessageContentHash } from "../../src/harness/agent-harness.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import {
	JsonlSessionBackend,
	JsonlSessionRepository,
	loadJsonlSessionMetadata,
} from "../../src/harness/session/jsonl-repo.ts";
import type { SessionCommitReceipt } from "../../src/harness/types.ts";
import { createTempDir, createUserMessage } from "./session-test-utils.ts";

/**
 * iris_agent#51: the JSONL entry+receipt journal must be crash-safe under
 * torn writes. Every truncation point across the frame (entry JSON, receipt
 * JSON, delimiter, checksum, missing newline) is fault-injected against a
 * REAL temporary file. Reopen must recover the last fully committed pair (or
 * quarantine a torn tail with a typed diagnostic) and never lose an earlier
 * complete pair, never fabricate an ACK, and never mistake marker-looking
 * message text for journal structure.
 */

/** A filesystem double WITHOUT the fsync capability (in-memory, no syncFile). */
function makeNoSyncFs(root: string): NodeExecutionEnv {
	// NodeExecutionEnv always supports syncFile; shadow the method with
	// `undefined` at runtime so the backend's capability probe
	// (`fs.syncFile === undefined`) sees none.
	const env = new NodeExecutionEnv({ cwd: root }) as unknown as {
		syncFile?: unknown;
	};
	Object.defineProperty(env, "syncFile", { value: undefined, writable: true });
	return env as unknown as NodeExecutionEnv;
}

function receiptFor(entryId: string, contentHash: string): SessionCommitReceipt {
	return {
		sessionId: "session-fault",
		entryId,
		contentHash,
		committedAt: new Date().toISOString(),
	};
}

async function openSessionFile(sessionPath: string) {
	const fs = new NodeExecutionEnv({ cwd: sessionPath });
	const repo = new JsonlSessionRepository({ fs, sessionsRoot: sessionPath });
	const metadata = await loadJsonlSessionMetadata(fs, sessionPath);
	const session = await repo.open(metadata);
	return { repo, session, metadata, fs };
}

describe("JSONL framed journal crash-safety (iris_agent#51)", () => {
	it("publishes an explicit crash-recoverable capability from the fsync boundary", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const repo = new JsonlSessionRepository({ fs: env, sessionsRoot: root });
		const session = await repo.create({ cwd: root, id: "cap-1" });
		expect(session.supportsCrashRecoverableReceipts()).toBe(true);

		const noSyncRoot = createTempDir();
		const noSyncFs = makeNoSyncFs(noSyncRoot);
		const noSyncRepo = new JsonlSessionRepository({
			fs: noSyncFs,
			sessionsRoot: noSyncRoot,
		});
		const noSyncSession = await noSyncRepo.create({
			cwd: noSyncRoot,
			id: "cap-2",
		});
		expect(noSyncSession.supportsCrashRecoverableReceipts()).toBe(false);
		await noSyncRepo[Symbol.asyncDispose]();
		await repo[Symbol.asyncDispose]();
	});

	it("fails closed on the journal seam when the filesystem cannot fsync", async () => {
		const root = createTempDir();
		const noSyncFs = makeNoSyncFs(root);
		const backend = new JsonlSessionBackend({
			fs: noSyncFs,
			sessionsRoot: root,
		});
		const storage = await backend.create({ cwd: root, id: "no-fsync-1" });
		const message = createUserMessage("crash window");
		const contentHash = await computeMessageContentHash(message);
		await expect(
			storage.appendEntryWithReceipt!(
				{
					id: "e1",
					parentId: null,
					timestamp: new Date().toISOString(),
					type: "message",
					message,
				},
				receiptFor("e1", contentHash),
			),
		).rejects.toThrow(/syncFile/);
		await backend[Symbol.asyncDispose]();
	});

	it("falls back to a plain append (publish-only receipts) on an fsync-less backend instead of pretending durability", async () => {
		const root = createTempDir();
		const noSyncFs = makeNoSyncFs(root);
		const repo = new JsonlSessionRepository({
			fs: noSyncFs,
			sessionsRoot: root,
		});
		const session = await repo.create({ cwd: root, id: "no-fsync-2" });
		const metadata = await session.getMetadata();
		const message = createUserMessage("plain append on fsync-less fs");
		const contentHash = await computeMessageContentHash(message);
		const { entryId } = await session.appendMessageWithCommitReceipt(message, (id) => receiptFor(id, contentHash));
		// No journal frame was written: the file has header + one bare entry line.
		const content = readFileSync(metadata.path, "utf8");
		expect(content).not.toContain("__piJournal");
		// The entry itself is durable; no pending receipt exists (publish-only).
		expect((await session.getEntry(entryId))?.type).toBe("message");
		expect(await session.readPendingCommitReceipts()).toEqual([]);
		await repo[Symbol.asyncDispose]();
	});

	it("fault-injects every truncation point: torn tails quarantine, earlier pairs survive, checksum bit-rot fails closed mid-file", async () => {
		const root = createTempDir();
		const fs = new NodeExecutionEnv({ cwd: root });
		const repo = new JsonlSessionRepository({ fs, sessionsRoot: root });
		const session = await repo.create({ cwd: root, id: "fault-1" });
		const metadata = await session.getMetadata();

		const first = createUserMessage("first committed pair");
		const second = createUserMessage("second committed pair");
		const hash1 = await computeMessageContentHash(first);
		const hash2 = await computeMessageContentHash(second);
		await session.appendMessageWithCommitReceipt(first, (id) => receiptFor(id, hash1));
		await session.appendMessageWithCommitReceipt(second, (id) => receiptFor(id, hash2));
		await repo[Symbol.asyncDispose]();

		const full = readFileSync(metadata.path, "utf8");
		const lines = full.split("\n");
		const frame2Start = full.indexOf(lines[2]!); // line 0 = header, 1 = frame1, 2 = frame2

		// (a) truncate inside the second frame's entry JSON
		const tmpA = createTempDir();
		writeFileSync(join(tmpA, "s.jsonl"), full.slice(0, frame2Start + Math.floor(lines[2]!.length * 0.3)));
		// (b) truncate inside the second frame's receipt JSON (later part of the line)
		const tmpB = createTempDir();
		writeFileSync(join(tmpB, "s.jsonl"), full.slice(0, frame2Start + Math.floor(lines[2]!.length * 0.9)));
		// (d) checksum of the LAST frame flipped (parses as JSON, fails verification)
		const tmpD = createTempDir();
		const frame2 = lines[2]!;
		const flipped = frame2.replace(/(?<=checksum":")[0-9a-f]/, (c) => (c === "0" ? "1" : "0"));
		writeFileSync(join(tmpD, "s.jsonl"), `${lines[0]}\n${lines[1]}\n${flipped}\n`);
		// (e) truncate exactly at the end of the first frame (second frame never started)
		const tmpE = createTempDir();
		writeFileSync(join(tmpE, "s.jsonl"), full.slice(0, frame2Start));

		for (const [label, dir] of [
			["entry-json", tmpA],
			["receipt-json", tmpB],
			["checksum-flip-last", tmpD],
			["truncated-before-second", tmpE],
		] as const) {
			const { session: reopened, repo: reopenedRepo } = await openSessionFile(join(dir, "s.jsonl"));
			const entries = await reopened.getEntries();
			const pending = await reopened.readPendingCommitReceipts();
			// The FIRST complete pair always survives; the torn second never does.
			expect(entries.length, label).toBe(1);
			expect(entries[0]!.type, label).toBe("message");
			expect(pending.length, label).toBe(1);
			expect(pending[0]!.contentHash, label).toBe(hash1);
			expect(pending[0]!.entrySeq, label).toBe(1);
			const diagnostics = await reopened.journalDiagnostics();
			if (label === "entry-json" || label === "receipt-json" || label === "checksum-flip-last") {
				expect(diagnostics.length, label).toBeGreaterThan(0);
				expect(diagnostics[0]!, label).toContain("torn_tail");
			} else {
				expect(diagnostics.length, label).toBe(0);
			}
			await reopenedRepo[Symbol.asyncDispose]();
		}

		// (c) complete second frame WITHOUT a trailing newline is a valid,
		// complete commit — both pairs must recover, no diagnostic.
		const tmpC = createTempDir();
		writeFileSync(join(tmpC, "s.jsonl"), full.slice(0, full.length - 1));
		{
			const { session: reopened, repo: reopenedRepo } = await openSessionFile(join(tmpC, "s.jsonl"));
			expect((await reopened.getEntries()).length).toBe(2);
			const pending = await reopened.readPendingCommitReceipts();
			expect(pending.length).toBe(2);
			expect(pending.map((r) => r.entrySeq)).toEqual([1, 2]);
			expect(await reopened.journalDiagnostics()).toEqual([]);
			await reopenedRepo[Symbol.asyncDispose]();
		}

		// Mid-file corruption (first frame's checksum flipped) fails closed.
		const tmpMid = createTempDir();
		const frame1 = lines[1]!;
		const flipped1 = frame1.replace(/(?<=checksum":")[0-9a-f]/, (c) => (c === "0" ? "1" : "0"));
		writeFileSync(join(tmpMid, "s.jsonl"), `${lines[0]}\n${flipped1}\n${lines[2]}\n`);
		const midFs = new NodeExecutionEnv({ cwd: tmpMid });
		const midRepo = new JsonlSessionRepository({
			fs: midFs,
			sessionsRoot: tmpMid,
		});
		const midMetadata = await loadJsonlSessionMetadata(midFs, join(tmpMid, "s.jsonl"));
		await expect(midRepo.open(midMetadata)).rejects.toThrow(/checksum mismatch|not valid JSON/);
		await midRepo[Symbol.asyncDispose]();
	});

	it("keeps marker-looking message text lossless on the framed journal path", async () => {
		const root = createTempDir();
		const fs = new NodeExecutionEnv({ cwd: root });
		const repo = new JsonlSessionRepository({ fs, sessionsRoot: root });
		const session = await repo.create({ cwd: root, id: "marker-lossless" });
		const metadata = await session.getMetadata();
		const message = createUserMessage('mention "__piJournal": 1 and __piReceiptAck and __piReceipt inside');
		const contentHash = await computeMessageContentHash(message);
		await session.appendMessageWithCommitReceipt(message, (id) => receiptFor(id, contentHash));
		const sessionPath = metadata.path;
		await repo[Symbol.asyncDispose]();

		const { session: reopened, repo: reopenedRepo } = await openSessionFile(sessionPath);
		const entries = await reopened.getEntries();
		expect(entries.length).toBe(1);
		expect(entries[0]!.type).toBe("message");
		expect((entries[0]! as { message: { content: Array<{ text: string }> } }).message.content[0]!.text).toContain(
			"__piJournal",
		);
		const pending = await reopened.readPendingCommitReceipts();
		expect(pending.length).toBe(1);
		expect(pending[0]!.contentHash).toBe(contentHash);
		await reopenedRepo[Symbol.asyncDispose]();
	});

	it("serializes concurrent journal appends with strictly monotonic seqs", async () => {
		const root = createTempDir();
		const fs = new NodeExecutionEnv({ cwd: root });
		const repo = new JsonlSessionRepository({ fs, sessionsRoot: root });
		const session = await repo.create({ cwd: root, id: "concurrent-1" });
		const metadata = await session.getMetadata();
		const results = await Promise.all(
			Array.from({ length: 5 }, (_, i) => {
				const message = createUserMessage(`concurrent ${i}`);
				return computeMessageContentHash(message).then((hash) =>
					session.appendMessageWithCommitReceipt(message, (id) => receiptFor(id, hash)),
				);
			}),
		);
		expect(results.length).toBe(5);
		const sessionPath = metadata.path;
		await repo[Symbol.asyncDispose]();

		const { session: reopened, repo: reopenedRepo } = await openSessionFile(sessionPath);
		const entries = await reopened.getEntries();
		expect(entries.length).toBe(5);
		const pending = await reopened.readPendingCommitReceipts();
		expect(pending.length).toBe(5);
		expect(pending.map((r) => r.entrySeq)).toEqual([1, 2, 3, 4, 5]);
		await reopenedRepo[Symbol.asyncDispose]();
	});

	it("never loses a committed pair when appending after a missing-newline tail (review finding, iris_agent#51)", async () => {
		const root = createTempDir();
		const fs = new NodeExecutionEnv({ cwd: root });
		const repo = new JsonlSessionRepository({ fs, sessionsRoot: root });
		const session = await repo.create({ cwd: root, id: "tail-guard" });
		const metadata = await session.getMetadata();

		const first = createUserMessage("first pair");
		const second = createUserMessage("second pair");
		const hash1 = await computeMessageContentHash(first);
		const hash2 = await computeMessageContentHash(second);
		await session.appendMessageWithCommitReceipt(first, (id) => receiptFor(id, hash1));
		await session.appendMessageWithCommitReceipt(second, (id) => receiptFor(id, hash2));
		const sessionPath = metadata.path;
		await repo[Symbol.asyncDispose]();

		// Simulate a torn tail that still contains the COMPLETE second frame
		// but lost its trailing newline (e.g. interrupted write at the byte
		// boundary after the JSON, before the delimiter).
		const full = readFileSync(sessionPath, "utf8");
		writeFileSync(sessionPath, full.slice(0, full.length - 1));

		// Reopen: both complete pairs must still be readable.
		{
			const { session: reopened, repo: reopenedRepo } = await openSessionFile(sessionPath);
			expect((await reopened.getEntries()).length).toBe(2);
			expect((await reopened.readPendingCommitReceipts()).length).toBe(2);
			expect(await reopened.journalDiagnostics()).toEqual([]);
			await reopenedRepo[Symbol.asyncDispose]();
		}

		// Appending the THIRD frame must not concatenate onto the trailing
		// line: the append guard emits the missing newline first, so the
		// previously committed pair survives and the new frame is its own line.
		{
			const { session: reopened, repo: reopenedRepo } = await openSessionFile(sessionPath);
			const third = createUserMessage("third pair after torn newline");
			const hash3 = await computeMessageContentHash(third);
			await reopened.appendMessageWithCommitReceipt(third, (id) => receiptFor(id, hash3));
			const entries = await reopened.getEntries();
			expect(entries.length).toBe(3);
			const pending = await reopened.readPendingCommitReceipts();
			expect(pending.length).toBe(3);
			expect(pending.map((r) => r.entrySeq)).toEqual([1, 2, 3]);
			expect(await reopened.journalDiagnostics()).toEqual([]);
			await reopenedRepo[Symbol.asyncDispose]();
		}
	});

	it("partial torn tail is physically repaired on load: append after quarantine keeps every committed pair (review BLOCKING repro)", async () => {
		const root = createTempDir();
		const fs = new NodeExecutionEnv({ cwd: root });
		const repo = new JsonlSessionRepository({ fs, sessionsRoot: root });
		const session = await repo.create({ cwd: root, id: "torn-repair" });
		const metadata = await session.getMetadata();

		const first = createUserMessage("first committed pair");
		const second = createUserMessage("second committed pair");
		const hash1 = await computeMessageContentHash(first);
		const hash2 = await computeMessageContentHash(second);
		await session.appendMessageWithCommitReceipt(first, (id) => receiptFor(id, hash1));
		await session.appendMessageWithCommitReceipt(second, (id) => receiptFor(id, hash2));
		const sessionPath = metadata.path;
		await repo[Symbol.asyncDispose]();

		// Crash mid-write of the second frame: PARTIAL JSON, no trailing
		// newline (the reviewer's independent repro scenario).
		const full = readFileSync(sessionPath, "utf8");
		const lines = full.split("\n");
		const frame2Start = full.indexOf(lines[2]!);
		writeFileSync(sessionPath, full.slice(0, frame2Start + Math.floor(lines[2]!.length * 0.5)));

		// Reopen: the torn tail is quarantined with a typed diagnostic, the
		// first pair is intact, and the torn bytes are physically truncated.
		{
			const { session: reopened, repo: reopenedRepo } = await openSessionFile(sessionPath);
			expect((await reopened.getEntries()).length).toBe(1);
			const pending = await reopened.readPendingCommitReceipts();
			expect(pending.length).toBe(1);
			expect(pending[0]!.contentHash).toBe(hash1);
			const diagnostics = await reopened.journalDiagnostics();
			expect(diagnostics.length).toBeGreaterThan(0);
			expect(diagnostics[0]!).toContain("torn_tail");
			await reopenedRepo[Symbol.asyncDispose]();
		}

		// The file on disk no longer contains the torn bytes (repaired).
		const repaired = readFileSync(sessionPath, "utf8");
		expect(repaired.endsWith("\n")).toBe(true);
		expect(repaired.split("\n").filter((l) => l.trim()).length).toBe(2);

		// Append a third frame on the recovered session: this previously
		// threw on the next reopen because the torn line became a MIDDLE
		// line (invalid JSON) — the whole session failed closed.
		{
			const { session: reopened, repo: reopenedRepo } = await openSessionFile(sessionPath);
			const third = createUserMessage("third pair after partial torn tail");
			const hash3 = await computeMessageContentHash(third);
			await reopened.appendMessageWithCommitReceipt(third, (id) => receiptFor(id, hash3));
			const entries = await reopened.getEntries();
			expect(entries.length).toBe(2);
			const pending = await reopened.readPendingCommitReceipts();
			expect(pending.length).toBe(2);
			// The torn frame was never durably committed (unverifiable), so
			// its seq is not reused and the next commit continues from the
			// max VALID seq — monotonic, no collision.
			expect(pending.map((r) => r.entrySeq)).toEqual([1, 2]);
			await reopenedRepo[Symbol.asyncDispose]();
		}

		// Reopen again with a fresh instance: the file is healed, both pairs
		// committed, and the load is clean (the repair note was surfaced by
		// the instance that performed it; persistence across restarts is the
		// #50 quarantine ledger's job, not the repaired torn tail's).
		{
			const { session: reopened, repo: reopenedRepo } = await openSessionFile(sessionPath);
			expect((await reopened.getEntries()).length).toBe(2);
			expect((await reopened.readPendingCommitReceipts()).length).toBe(2);
			expect(await reopened.journalDiagnostics()).toEqual([]);
			await reopenedRepo[Symbol.asyncDispose]();
		}
	});

	it("torn ack marker tail (valid JSON, missing entryId) quarantines instead of bricking the session", async () => {
		const root = createTempDir();
		const fs = new NodeExecutionEnv({ cwd: root });
		const repo = new JsonlSessionRepository({ fs, sessionsRoot: root });
		const session = await repo.create({ cwd: root, id: "ack-torn" });
		const metadata = await session.getMetadata();
		const message = createUserMessage("acked pair");
		const contentHash = await computeMessageContentHash(message);
		const { entryId } = await session.appendMessageWithCommitReceipt(message, (id) => receiptFor(id, contentHash));
		await session.ackCommitReceipt(entryId);
		const sessionPath = metadata.path;
		await repo[Symbol.asyncDispose]();

		// Simulate a crash mid-ack-write: the marker was truncated after
		// `true}` but before the entryId field — still valid JSON, structurally
		// incomplete. As the tail it must quarantine with a typed diagnostic
		// (the ack is lost; re-replay is idempotent), not brick the session.
		const full = readFileSync(sessionPath, "utf8");
		const ackLine = full.split("\n").find((l) => l.includes("__piReceiptAck"))!;
		const ackStart = full.indexOf(ackLine);
		writeFileSync(sessionPath, full.slice(0, ackStart + ackLine.indexOf("entryId")));

		const { session: reopened, repo: reopenedRepo } = await openSessionFile(sessionPath);
		// The committed pair is intact; the quarantined ack re-exposes the
		// pending receipt (idempotent re-replay semantics).
		expect((await reopened.getEntries()).length).toBe(1);
		const pending = await reopened.readPendingCommitReceipts();
		expect(pending.length).toBe(1);
		expect(pending[0]!.entryId).toBe(entryId);
		const diagnostics = await reopened.journalDiagnostics();
		expect(diagnostics.length).toBeGreaterThan(0);
		expect(diagnostics[0]!).toContain("torn_tail");
		await reopenedRepo[Symbol.asyncDispose]();

		// The file was physically repaired; a fresh reopen is clean.
		const repaired = readFileSync(sessionPath, "utf8");
		expect(repaired.endsWith("\n")).toBe(true);
		expect(repaired).not.toContain("__piReceiptAck");
	});

	it("non-ASCII (CJK) content: torn-tail repair truncates at UTF-8 byte boundary, never corrupts the committed frame (review D2)", async () => {
		const root = createTempDir();
		const fs = new NodeExecutionEnv({ cwd: root });
		const repo = new JsonlSessionRepository({ fs, sessionsRoot: root });
		const session = await repo.create({ cwd: root, id: "cjk-torn" });
		const metadata = await session.getMetadata();
		const first = createUserMessage("第一帧：中文内容 unicode 多字节，必须毫发无损");
		const second = createUserMessage("第二帧：也会被截断");
		const hash1 = await computeMessageContentHash(first);
		const hash2 = await computeMessageContentHash(second);
		await session.appendMessageWithCommitReceipt(first, (id) => receiptFor(id, hash1));
		await session.appendMessageWithCommitReceipt(second, (id) => receiptFor(id, hash2));
		const sessionPath = metadata.path;
		await repo[Symbol.asyncDispose]();

		// Crash mid-frame2 with CJK bytes present BEFORE the torn tail: a
		// UTF-16-vs-byte misaligned truncate would land inside frame1.
		const full = readFileSync(sessionPath, "utf8");
		const lines = full.split("\n");
		const frame2Start = full.indexOf(lines[2]!);
		writeFileSync(sessionPath, full.slice(0, frame2Start + Math.floor(lines[2]!.length * 0.4)));

		// Reopen: frame1 (CJK intact) recovers; the file is repaired at the
		// correct byte offset.
		{
			const { session: reopened, repo: reopenedRepo } = await openSessionFile(sessionPath);
			const entries = await reopened.getEntries();
			expect(entries.length).toBe(1);
			const text = (entries[0] as { message: { content: Array<{ text: string }> } }).message.content[0]!.text;
			expect(text).toBe("第一帧：中文内容 unicode 多字节，必须毫发无损");
			const pending = await reopened.readPendingCommitReceipts();
			expect(pending.length).toBe(1);
			expect(pending[0]!.contentHash).toBe(hash1);
			await reopenedRepo[Symbol.asyncDispose]();
		}

		// Append after the repair: reopen must be clean and both pairs intact.
		{
			const { session: reopened, repo: reopenedRepo } = await openSessionFile(sessionPath);
			const third = createUserMessage("第三帧 after CJK repair");
			const hash3 = await computeMessageContentHash(third);
			await reopened.appendMessageWithCommitReceipt(third, (id) => receiptFor(id, hash3));
			expect((await reopened.getEntries()).length).toBe(2);
			await reopenedRepo[Symbol.asyncDispose]();
		}
		{
			const { session: reopened, repo: reopenedRepo } = await openSessionFile(sessionPath);
			expect((await reopened.getEntries()).length).toBe(2);
			const text = (
				(await reopened.getEntries())[0] as {
					message: { content: Array<{ text: string }> };
				}
			).message.content[0]!.text;
			expect(text).toBe("第一帧：中文内容 unicode 多字节，必须毫发无损");
			expect(await reopened.journalDiagnostics()).toEqual([]);
			await reopenedRepo[Symbol.asyncDispose]();
		}
	});

	it("torn bare entry tail (valid JSON, structurally incomplete) quarantines instead of bricking the session (review F3)", async () => {
		const root = createTempDir();
		const fs = new NodeExecutionEnv({ cwd: root });
		const repo = new JsonlSessionRepository({ fs, sessionsRoot: root });
		const session = await repo.create({ cwd: root, id: "bare-torn" });
		const metadata = await session.getMetadata();
		const message = createUserMessage("plain entry before torn bare tail");
		const contentHash = await computeMessageContentHash(message);
		await session.appendMessageWithCommitReceipt(message, (id) => receiptFor(id, contentHash));
		const sessionPath = metadata.path;
		await repo[Symbol.asyncDispose]();

		// Crash mid-write of a BARE entry (plain append path): the line is
		// truncated to valid JSON that is structurally incomplete (here: a
		// leaf without id/targetId — parseEntry's structural checks fail).
		// As the tail it must quarantine with a typed diagnostic, not throw
		// invalid_entry and brick the session.
		const full = readFileSync(sessionPath, "utf8");
		writeFileSync(sessionPath, `${full}${JSON.stringify({ type: "leaf" })}`);

		const { session: reopened, repo: reopenedRepo } = await openSessionFile(sessionPath);
		// The committed frame survives; the torn bare entry is quarantined.
		expect((await reopened.getEntries()).length).toBe(1);
		const diagnostics = await reopened.journalDiagnostics();
		expect(diagnostics.length).toBeGreaterThan(0);
		expect(diagnostics[0]!).toContain("torn_tail");
		// A follow-up append works and the file stays healthy.
		await reopened.appendMessageWithCommitReceipt(createUserMessage("after torn bare tail"), (id) =>
			receiptFor(id, contentHash),
		);
		await reopenedRepo[Symbol.asyncDispose]();

		const { session: again, repo: againRepo } = await openSessionFile(sessionPath);
		expect((await again.getEntries()).length).toBe(2);
		await againRepo[Symbol.asyncDispose]();
	});

	it("capability requires BOTH fsync and truncate: syncFile without truncateFile is not crash-recoverable", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root }) as unknown as {
			truncateFile?: unknown;
		};
		// Shadow the prototype method with `undefined` (delete does not
		// remove inherited properties).
		Object.defineProperty(env, "truncateFile", {
			value: undefined,
			writable: true,
		});
		const repo = new JsonlSessionRepository({
			fs: env as unknown as NodeExecutionEnv,
			sessionsRoot: root,
		});
		const session = await repo.create({ cwd: root, id: "cap-sync-only" });
		expect(session.supportsCrashRecoverableReceipts()).toBe(false);
		// The journal seam fails closed and the Session falls back to a
		// publish-only plain append.
		const message = createUserMessage("no truncate capability");
		const contentHash = await computeMessageContentHash(message);
		const { entryId } = await session.appendMessageWithCommitReceipt(message, (id) => receiptFor(id, contentHash));
		expect((await session.getEntry(entryId))?.type).toBe("message");
		expect(await session.readPendingCommitReceipts()).toEqual([]);
		await repo[Symbol.asyncDispose]();
	});

	it("iris_agent#50: quarantined receipts are persisted via marker, excluded from pending, visible in diagnostics", async () => {
		const root = createTempDir();
		const fs = new NodeExecutionEnv({ cwd: root });
		const repo = new JsonlSessionRepository({ fs, sessionsRoot: root });
		const session = await repo.create({ cwd: root, id: "quarantine-1" });
		const metadata = await session.getMetadata();
		const first = createUserMessage("valid pair");
		const second = createUserMessage("pair to quarantine");
		const hash1 = await computeMessageContentHash(first);
		const hash2 = await computeMessageContentHash(second);
		const { entryId: secondId } = await session.appendMessageWithCommitReceipt(second, (id) => receiptFor(id, hash2));
		await session.appendMessageWithCommitReceipt(first, (id) => receiptFor(id, hash1));
		const sessionPath = metadata.path;

		// Quarantine the middle receipt (tampered content hash scenario).
		await session.quarantineCommitReceipt(secondId, "content_hash_mismatch: tampered");

		// Pending excludes it; diagnostics expose it with the typed reason.
		const pending = await session.readPendingCommitReceipts();
		expect(pending.length).toBe(1);
		expect(pending[0]!.entryId).not.toBe(secondId);
		const quarantined = await session.readQuarantinedCommitReceipts();
		expect(quarantined.length).toBe(1);
		expect(quarantined[0]!.entryId).toBe(secondId);
		expect(quarantined[0]!.reason).toContain("content_hash_mismatch");

		// Quarantine marker persists across reopen; the valid receipt stays
		// pending (never acked), the quarantined one is never re-exposed.
		await repo[Symbol.asyncDispose]();
		const { session: reopened, repo: reopenedRepo } = await openSessionFile(sessionPath);
		const reopenedPending = await reopened.readPendingCommitReceipts();
		expect(reopenedPending.length).toBe(1);
		expect(reopenedPending[0]!.entryId).not.toBe(secondId);
		const persisted = await reopened.readQuarantinedCommitReceipts();
		expect(persisted.length).toBe(1);
		expect(persisted[0]!.entryId).toBe(secondId);
		expect(persisted[0]!.reason).toContain("content_hash_mismatch");
		await reopenedRepo[Symbol.asyncDispose]();
	});

	it("recovery stays idempotent across restarts: acked pairs never re-emit", async () => {
		const root = createTempDir();
		const fs = new NodeExecutionEnv({ cwd: root });
		const repo = new JsonlSessionRepository({ fs, sessionsRoot: root });
		const session = await repo.create({ cwd: root, id: "idem-1" });
		const metadata = await session.getMetadata();
		const message = createUserMessage("idempotent recovery");
		const contentHash = await computeMessageContentHash(message);
		const { entryId } = await session.appendMessageWithCommitReceipt(message, (id) => receiptFor(id, contentHash));
		await session.ackCommitReceipt(entryId);
		const sessionPath = metadata.path;
		await repo[Symbol.asyncDispose]();

		const { session: reopened, repo: reopenedRepo } = await openSessionFile(sessionPath);
		expect(await reopened.readPendingCommitReceipts()).toEqual([]);
		expect(await reopened.journalDiagnostics()).toEqual([]);
		await reopenedRepo[Symbol.asyncDispose]();
	});

	it("reads legacy pre-framing journal files: pair recovery works, torn legacy marker tails are quarantined with a diagnostic", async () => {
		const root = createTempDir();
		const header = JSON.stringify({
			type: "session",
			version: 3,
			id: "legacy-1",
			timestamp: "2026-08-01T00:00:00.000Z",
			cwd: root,
		});
		const entry = JSON.stringify({
			id: "e-legacy",
			parentId: null,
			timestamp: "2026-08-01T00:00:01.000Z",
			type: "message",
			message: createUserMessage("legacy journal message"),
		});
		const marker = JSON.stringify({
			__piReceipt: true,
			receipt: receiptFor("e-legacy", "deadbeef".repeat(8)),
		});
		writeFileSync(join(root, "legacy.jsonl"), `${header}\n${entry}\n${marker}\n`);

		const { session: reopened, repo: reopenedRepo } = await openSessionFile(join(root, "legacy.jsonl"));
		const pending = await reopened.readPendingCommitReceipts();
		expect(pending.length).toBe(1);
		expect(pending[0]!.entryId).toBe("e-legacy");
		expect(await reopened.journalDiagnostics()).toEqual([]);
		await reopenedRepo[Symbol.asyncDispose]();

		// Torn legacy marker tail: the marker line is cut mid-JSON. The entry
		// stays visible, the missing receipt is reported, not hidden.
		const root2 = createTempDir();
		writeFileSync(join(root2, "legacy.jsonl"), `${header}\n${entry}\n${marker!.slice(0, 40)}\n`);
		const { session: torn, repo: tornRepo } = await openSessionFile(join(root2, "legacy.jsonl"));
		expect((await torn.getEntries()).length).toBe(1);
		const tornPending = await torn.readPendingCommitReceipts();
		expect(tornPending.length).toBe(0);
		const tornDiagnostics = await torn.journalDiagnostics();
		expect(tornDiagnostics.length).toBe(1);
		expect(tornDiagnostics[0]!).toContain("torn_tail");
		expect(tornDiagnostics[0]!).toContain("line 3");
		await tornRepo[Symbol.asyncDispose]();
	});

	it("iris_agent#60: mixed legacy+framed receipts replay in exact physical commit order, never by incomparable order domains", async () => {
		const root = createTempDir();
		const header = JSON.stringify({
			type: "session",
			version: 3,
			id: "mixed-order-1",
			timestamp: "2026-08-01T00:00:00.000Z",
			cwd: root,
		});
		// Legacy part: bare entry + legacy receipt marker (no journal seq).
		const legacyEntry = JSON.stringify({
			id: "e-legacy-a",
			parentId: null,
			timestamp: "2026-08-01T00:00:01.000Z",
			type: "message",
			message: createUserMessage("legacy committed first"),
		});
		const legacyReceipt = receiptFor("e-legacy-a", "deadbeef".repeat(8));
		const legacyMarker = JSON.stringify({
			__piReceipt: true,
			receipt: legacyReceipt,
		});

		// Framed part: a REAL journal frame via the backend, so the frame line
		// (seq, checksum) is exactly what production writes.
		const frameRoot = createTempDir();
		const frameFs = new NodeExecutionEnv({ cwd: frameRoot });
		const frameRepo = new JsonlSessionRepository({
			fs: frameFs,
			sessionsRoot: frameRoot,
		});
		const frameSession = await frameRepo.create({
			cwd: frameRoot,
			id: "frame-source",
		});
		const frameMessage = createUserMessage("framed committed second");
		const frameHash = await computeMessageContentHash(frameMessage);
		const { entryId: framedEntryId } = await frameSession.appendMessageWithCommitReceipt(frameMessage, (id) =>
			receiptFor(id, frameHash),
		);
		const frameLine = readFileSync((await frameSession.getMetadata()).path, "utf8").split("\n")[1]!;
		await frameRepo[Symbol.asyncDispose]();

		// The issue's exact file shape: legacy marker at line 3, framed frame at
		// line 4 with seq=1. Legacy order=3, framed old-order=1 — the old sort
		// put the NEWER frame first, violating physical commit order.
		const mixedPath = join(root, "mixed.jsonl");
		writeFileSync(mixedPath, `${header}\n${legacyEntry}\n${legacyMarker}\n${frameLine}\n`);

		const { session: reopened, repo: reopenedRepo } = await openSessionFile(mixedPath);
		const pending = await reopened.readPendingCommitReceipts();
		expect(pending.length).toBe(2);
		// Physical commit order: legacy A first, framed B second — despite the
		// framed seq restarting at 1.
		expect(pending.map((r) => r.entryId)).toEqual(["e-legacy-a", framedEntryId]);
		expect(pending[0]!.entrySeq).toBeUndefined();
		expect(pending[1]!.entrySeq).toBe(1);
		// Both entries are present in file order.
		const entries = await reopened.getEntries();
		expect(entries.map((e) => e.id)).toEqual(["e-legacy-a", framedEntryId]);

		// Ack the legacy receipt: only the framed receipt remains pending, and
		// it must not reorder against anything else.
		await reopened.ackCommitReceipt("e-legacy-a");
		expect((await reopened.readPendingCommitReceipts()).map((r) => r.entryId)).toEqual([framedEntryId]);
		await reopenedRepo[Symbol.asyncDispose]();
	});

	it("iris_agent#60: the first post-upgrade frame cannot sort before older pending legacy receipts (reopen-stable)", async () => {
		const root = createTempDir();
		const header = JSON.stringify({
			type: "session",
			version: 3,
			id: "upgrade-order-1",
			timestamp: "2026-08-01T00:00:00.000Z",
			cwd: root,
		});
		// A legacy journal with TWO pending receipts (lines 3 and 5), then the
		// upgrade appends the first framed pair (seq=1).
		const entryA = JSON.stringify({
			id: "e-up-a",
			parentId: null,
			timestamp: "2026-08-01T00:00:01.000Z",
			type: "message",
			message: createUserMessage("legacy a"),
		});
		const entryB = JSON.stringify({
			id: "e-up-b",
			parentId: null,
			timestamp: "2026-08-01T00:00:02.000Z",
			type: "message",
			message: createUserMessage("legacy b"),
		});
		const markerA = JSON.stringify({
			__piReceipt: true,
			receipt: receiptFor("e-up-a", "a".repeat(64)),
		});
		const markerB = JSON.stringify({
			__piReceipt: true,
			receipt: receiptFor("e-up-b", "b".repeat(64)),
		});
		const legacyPath = join(root, "upgrade.jsonl");
		writeFileSync(legacyPath, `${header}\n${entryA}\n${markerA}\n${entryB}\n${markerB}\n`);

		// Open the legacy journal and append the first FRAMED pair: the backend
		// seeds seq=1 (maxJournalSeq is 0 — no framed records yet).
		{
			const { session: reopened, repo: reopenedRepo } = await openSessionFile(legacyPath);
			const framed = createUserMessage("first framed after upgrade");
			const framedHash = await computeMessageContentHash(framed);
			const { entryId: framedEntryId } = await reopened.appendMessageWithCommitReceipt(framed, (id) =>
				receiptFor(id, framedHash),
			);
			// Order: the new frame (seq=1) MUST sort after BOTH older pending
			// legacy receipts — physical commit order wins over the restarting
			// seq counter.
			const pending = await reopened.readPendingCommitReceipts();
			expect(pending.map((r) => r.entryId)).toEqual(["e-up-a", "e-up-b", framedEntryId]);
			expect(pending[2]!.entrySeq).toBe(1);
			// The next framed append must continue monotonic (seq=2), not
			// restart, and stay last.
			const second = createUserMessage("second framed after upgrade");
			const secondHash = await computeMessageContentHash(second);
			const { entryId: framedEntryId2 } = await reopened.appendMessageWithCommitReceipt(second, (id) =>
				receiptFor(id, secondHash),
			);
			expect((await reopened.readPendingCommitReceipts()).map((r) => r.entryId)).toEqual([
				"e-up-a",
				"e-up-b",
				framedEntryId,
				framedEntryId2,
			]);
			const pending2 = await reopened.readPendingCommitReceipts();
			expect(pending2[3]!.entrySeq).toBe(2);
			await reopenedRepo[Symbol.asyncDispose]();
		}

		// Reopen/restart: the same deterministic order, exactly-once replay.
		{
			const { session: reopened, repo: reopenedRepo } = await openSessionFile(legacyPath);
			const pending = await reopened.readPendingCommitReceipts();
			expect(pending.map((r) => r.entrySeq ?? null)).toEqual([null, null, 1, 2]);
			expect(await reopened.journalDiagnostics()).toEqual([]);
			await reopenedRepo[Symbol.asyncDispose]();
		}
	});

	it("iris_agent#60: quarantine markers and torn-tail repair stay correct in a mixed legacy+framed file with CJK content", async () => {
		const root = createTempDir();
		const header = JSON.stringify({
			type: "session",
			version: 3,
			id: "mixed-cjk",
			timestamp: "2026-08-01T00:00:00.000Z",
			cwd: root,
		});
		const legacyEntry = JSON.stringify({
			id: "e-cjk-legacy",
			parentId: null,
			timestamp: "2026-08-01T00:00:01.000Z",
			type: "message",
			message: createUserMessage("旧消息正文：标记文本 __piReceipt 在正文里"),
		});
		const legacyMarker = JSON.stringify({
			__piReceipt: true,
			receipt: receiptFor("e-cjk-legacy", "c".repeat(64)),
		});

		// Real framed frame with CJK payload.
		const frameRoot = createTempDir();
		const frameFs = new NodeExecutionEnv({ cwd: frameRoot });
		const frameRepo = new JsonlSessionRepository({
			fs: frameFs,
			sessionsRoot: frameRoot,
		});
		const frameSession = await frameRepo.create({
			cwd: frameRoot,
			id: "frame-cjk",
		});
		const frameMessage = createUserMessage("新帧正文：你好，世界 __piReceiptQuarantine 混排测试");
		const frameHash = await computeMessageContentHash(frameMessage);
		const { entryId: framedEntryId } = await frameSession.appendMessageWithCommitReceipt(frameMessage, (id) =>
			receiptFor(id, frameHash),
		);
		const frameLine = readFileSync((await frameSession.getMetadata()).path, "utf8").split("\n")[1]!;
		await frameRepo[Symbol.asyncDispose]();

		const mixedPath = join(root, "mixed-cjk.jsonl");
		writeFileSync(mixedPath, `${header}\n${legacyEntry}\n${legacyMarker}\n${frameLine}\n`);

		// Load, quarantine the FRAMED receipt (integrity failure path), reopen.
		{
			const { session: reopened, repo: reopenedRepo } = await openSessionFile(mixedPath);
			const pending = await reopened.readPendingCommitReceipts();
			expect(pending.map((r) => r.entryId)).toEqual(["e-cjk-legacy", framedEntryId]);
			await reopened.quarantineCommitReceipt(framedEntryId, "integrity_mismatch_cjk");
			await reopenedRepo[Symbol.asyncDispose]();
		}
		{
			const { session: reopened, repo: reopenedRepo } = await openSessionFile(mixedPath);
			// Legacy pending survives; framed receipt quarantined; both entries
			// intact with the original CJK text.
			expect((await reopened.readPendingCommitReceipts()).map((r) => r.entryId)).toEqual(["e-cjk-legacy"]);
			const quarantined = await reopened.readQuarantinedCommitReceipts();
			expect(quarantined.map((q) => q.entryId)).toEqual([framedEntryId]);
			expect(quarantined[0]!.reason).toBe("integrity_mismatch_cjk");
			const entries = await reopened.getEntries();
			expect(entries.length).toBe(2);
			const text0 = (entries[0]! as { message: { content: Array<{ text: string }> } }).message.content[0]!.text;
			const text1 = (entries[1]! as { message: { content: Array<{ text: string }> } }).message.content[0]!.text;
			expect(text0).toBe("旧消息正文：标记文本 __piReceipt 在正文里");
			expect(text1).toBe("新帧正文：你好，世界 __piReceiptQuarantine 混排测试");
			await reopenedRepo[Symbol.asyncDispose]();
		}

		// Torn-tail repair on the mixed file: append a torn line, reopen —
		// repair truncates only the torn tail, the earlier legacy+framed order
		// is unchanged.
		{
			// Simulate a torn append by appending a partial line directly.
			const fs = new NodeExecutionEnv({ cwd: root });
			await fs.appendFile(mixedPath, '{"__piReceiptAck": true, "entryId": "');
		}
		{
			const { session: reopened, repo: reopenedRepo } = await openSessionFile(mixedPath);
			expect((await reopened.readPendingCommitReceipts()).map((r) => r.entryId)).toEqual(["e-cjk-legacy"]);
			const diagnostics = await reopened.journalDiagnostics();
			expect(diagnostics.length).toBeGreaterThan(0);
			expect(diagnostics[0]!).toContain("torn_tail");
			expect((await reopened.getEntries()).length).toBe(2);
			await reopenedRepo[Symbol.asyncDispose]();
		}
	});
});
