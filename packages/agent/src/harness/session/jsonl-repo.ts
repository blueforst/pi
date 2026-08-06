import type {
	FileSystem,
	JsonlSessionCreateOptions,
	JsonlSessionListOptions,
	JsonlSessionMetadata,
	SessionCommitReceipt,
	SessionForkOptions,
	SessionForkSelection,
	SessionStorage,
	SessionTreeEntry,
} from "../types.ts";
import { SessionError, toError } from "../types.ts";
import { ArraySessionIndex } from "./array-session-index.ts";
import { KeyedOperationQueue } from "./keyed-operation-queue.ts";
import {
	createSessionForkSelection,
	createSessionId,
	createTimestamp,
	getFileSystemResultOrThrow,
	readSessionEntriesForFork,
	type SessionRepository,
} from "./repository.ts";
import { createSession, type Session, type SessionContextBuildOptions } from "./session.ts";

export interface JsonlSessionBackendOptions {
	fs: JsonlSessionRepositoryFileSystem;
	sessionsRoot: string;
	/** Maximum active operations across session keys. Defaults to 4. */
	maxConcurrentOperations?: number;
}
export type JsonlSessionRepositoryFileSystem = Pick<
	FileSystem,
	| "absolutePath"
	| "joinPath"
	| "readTextFile"
	| "readTextLines"
	| "writeFile"
	| "appendFile"
	| "listDir"
	| "exists"
	| "createDir"
	| "remove"
	| "syncFile"
	| "truncateFile"
>;

type JsonlSessionFileSystem = Pick<FileSystem, "readTextFile" | "readTextLines" | "writeFile" | "appendFile">;

const DEFAULT_MAX_CONCURRENT_OPERATIONS = 4;

/** Bound on retained per-path load diagnostics (torn-tail quarantine notes). */
const MAX_LOAD_DIAGNOSTICS = 16;

interface SessionHeader {
	type: "session";
	version: 3;
	id: string;
	timestamp: string;
	cwd: string;
	parentSession?: string;
	metadata?: Record<string, unknown>;
}

interface SessionDocumentDescriptor {
	id: string;
	timestamp: string;
	fileName: string;
	operationKey: string;
}

function invalidSession(path: string, message: string, cause?: Error): SessionError {
	return new SessionError("invalid_session", `Invalid JSONL session file ${path}: ${message}`, cause);
}

function invalidEntry(path: string, line: number, message: string, cause?: Error): SessionError {
	return new SessionError("invalid_entry", `Invalid JSONL session file ${path}: line ${line} ${message}`, cause);
}

function parseHeader(line: string, path: string): SessionHeader {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch (error) {
		throw invalidSession(path, "first line is not a valid session header", toError(error));
	}
	if (typeof value !== "object" || value === null)
		throw invalidSession(path, "first line is not a valid session header");
	const header = value as Partial<SessionHeader>;
	if (header.type !== "session" || header.version !== 3) {
		throw invalidSession(
			path,
			header.type === "session" ? "unsupported session version" : "first line is not a valid session header",
		);
	}
	if (typeof header.id !== "string" || !header.id) throw invalidSession(path, "session header is missing id");
	if (typeof header.timestamp !== "string" || !header.timestamp)
		throw invalidSession(path, "session header is missing timestamp");
	if (typeof header.cwd !== "string" || !header.cwd) throw invalidSession(path, "session header is missing cwd");
	if (header.parentSession !== undefined && typeof header.parentSession !== "string") {
		throw invalidSession(path, "session header parentSession must be a string");
	}
	if (
		header.metadata !== undefined &&
		(typeof header.metadata !== "object" || header.metadata === null || Array.isArray(header.metadata))
	) {
		throw invalidSession(path, "session header metadata must be an object");
	}
	return {
		type: "session",
		version: 3,
		id: header.id,
		timestamp: header.timestamp,
		cwd: header.cwd,
		parentSession: header.parentSession,
		metadata: header.metadata,
	};
}

function parseEntry(line: string, path: string, lineNumber: number): SessionTreeEntry {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch (error) {
		throw invalidEntry(path, lineNumber, "is not valid JSON", toError(error));
	}
	if (typeof value !== "object" || value === null)
		throw invalidEntry(path, lineNumber, "is not a valid session entry");
	const entry = value as {
		type?: unknown;
		id?: unknown;
		parentId?: unknown;
		timestamp?: unknown;
		targetId?: unknown;
	};
	if (typeof entry.type !== "string") throw invalidEntry(path, lineNumber, "is missing entry type");
	if (typeof entry.id !== "string" || !entry.id) throw invalidEntry(path, lineNumber, "is missing entry id");
	if (entry.parentId !== null && typeof entry.parentId !== "string")
		throw invalidEntry(path, lineNumber, "has invalid parentId");
	if (typeof entry.timestamp !== "string" || !entry.timestamp)
		throw invalidEntry(path, lineNumber, "is missing timestamp");
	if (entry.type === "leaf" && entry.targetId !== null && typeof entry.targetId !== "string") {
		throw invalidEntry(path, lineNumber, "has invalid targetId");
	}
	return entry as SessionTreeEntry;
}

function metadataFromHeader(header: SessionHeader, path: string): JsonlSessionMetadata {
	return {
		id: header.id,
		createdAt: header.timestamp,
		cwd: header.cwd,
		path,
		parentSessionPath: header.parentSession,
		metadata: header.metadata,
	};
}

export async function loadJsonlSessionMetadata(
	fs: JsonlSessionFileSystem,
	path: string,
): Promise<JsonlSessionMetadata> {
	const lines = getFileSystemResultOrThrow(
		await fs.readTextLines(path, { maxLines: 1 }),
		`Failed to read session header ${path}`,
	);
	if (!lines[0]?.trim()) throw invalidSession(path, "missing session header");
	return metadataFromHeader(parseHeader(lines[0], path), path);
}

async function loadJsonlSession(fs: JsonlSessionFileSystem, path: string): Promise<JsonlSessionLoadResult> {
	const content = getFileSystemResultOrThrow(await fs.readTextFile(path), `Failed to read session ${path}`);
	const lines = content.split("\n").filter((line) => line.trim());
	if (lines.length === 0) throw invalidSession(path, "missing session header");
	const header = parseHeader(lines[0]!, path);
	const entries: SessionTreeEntry[] = [];
	const pendingReceipts: { receipt: SessionCommitReceipt; order: number }[] = [];
	const diagnostics: string[] = [];
	let maxJournalSeq = 0;
	let tornTailCleanLength: number | undefined;
	const entryIds = new Set<string>();

	for (let i = 1; i < lines.length; i++) {
		const line = lines[i]!;
		const lineNumber = i + 1;
		const isTail = i === lines.length - 1;
		// Torn-tail quarantine (iris_agent#51): only the LAST line may fail to
		// parse. A failure there means the append was interrupted mid-write
		// (short write, power loss, kill -9). The incomplete line is quarantined
		// with a typed diagnostic — it is never treated as a committed message —
		// and every earlier COMPLETE frame stays intact. Corruption in the
		// MIDDLE of the file is a storage fault and fails closed instead.
		const quarantineTail = (message: string): boolean => {
			if (!isTail) return false;
			diagnostics.push(`torn_tail: line ${lineNumber}: ${message}; quarantined`);
			// Byte offset of the LAST COMPLETE line: the torn line is the
			// suffix of the file (possibly followed by its own trailing
			// newline). The backend truncates to this offset so the torn
			// bytes can never become a mid-file corruption after later
			// appends (review finding, iris_agent#51).
			tornTailCleanLength = content.length - line.length - (content.endsWith("\n") ? 1 : 0);
			return true;
		};

		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch (error) {
			if (quarantineTail(`line is not valid JSON (${toError(error).message})`)) continue;
			throw invalidEntry(path, lineNumber, "is not valid JSON", toError(error));
		}
		if (typeof value !== "object" || value === null) {
			if (quarantineTail("line is not an object")) continue;
			throw invalidEntry(path, lineNumber, "is not a valid session entry");
		}
		const record = value as { __piReceipt?: unknown; __piReceiptAck?: unknown; __piJournal?: unknown };
		if (record.__piReceipt === true) {
			// Legacy pre-framing marker line: receipt-only; the entry is the
			// bare entry line written immediately before it. Torn marker tails
			// are quarantined above, leaving the entry visible with a diagnostic
			// (never silently — the missing receipt is reported, not hidden).
			const receipt = (record as { receipt?: SessionCommitReceipt }).receipt;
			if (!receipt || typeof receipt.entryId !== "string" || !receipt.entryId) {
				if (quarantineTail("legacy receipt marker is missing its receipt")) continue;
				throw invalidEntry(path, lineNumber, "legacy receipt marker is missing its receipt");
			}
			pendingReceipts.push({ receipt, order: lineNumber });
			continue;
		}
		if (record.__piReceiptAck === true) {
			const entryId = (record as { entryId?: unknown }).entryId;
			if (typeof entryId !== "string" || !entryId)
				throw invalidEntry(path, lineNumber, "receipt ack marker is missing entryId");
			const index = pendingReceipts.findIndex((p) => p.receipt.entryId === entryId);
			if (index >= 0) pendingReceipts.splice(index, 1);
			continue;
		}
		if (record.__piJournal === 1) {
			let frame: { entry: SessionTreeEntry; receipt: SessionCommitReceipt; seq: number } | undefined;
			try {
				frame = await parseJournalFrame(line, path, lineNumber);
			} catch (error) {
				if (error instanceof SessionError && error.code === "invalid_entry" && quarantineTail(error.message)) {
					continue;
				}
				throw error;
			}
			if (frame !== undefined) {
				if (entryIds.has(frame.entry.id)) throw invalidSession(path, `duplicate entry id ${frame.entry.id}`);
				entryIds.add(frame.entry.id);
				entries.push(frame.entry);
				pendingReceipts.push({ receipt: { ...frame.receipt, entrySeq: frame.seq }, order: frame.seq });
				maxJournalSeq = Math.max(maxJournalSeq, frame.seq);
			}
			continue;
		}
		// Bare entry line (plain append path, pre-framing journals, forks).
		const entry = parseEntry(line, path, lineNumber);
		if (entryIds.has(entry.id)) throw invalidSession(path, `duplicate entry id ${entry.id}`);
		entryIds.add(entry.id);
		entries.push(entry);
	}

	return {
		metadata: metadataFromHeader(header, path),
		entries,
		pendingReceipts,
		diagnostics,
		maxJournalSeq,
		tailEndsWithNewline: content.endsWith("\n"),
		tornTailCleanLength,
	};
}

/**
 * True for crash-journal marker lines appended by appendEntryWithReceipt/ackCommitReceipt.
 * Kept for legacy-file filtering by external readers; loadJsonlSession classifies
 * lines structurally instead (see parseJournalFrame / legacy marker handling).
 */
export function isReceiptJournalLine(line: string): boolean {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return false;
	}
	if (typeof value !== "object" || value === null) return false;
	const record = value as { __piReceipt?: unknown; __piReceiptAck?: unknown; __piJournal?: unknown };
	// Structural check, not substring matching: a legitimate entry whose message
	// text merely contains "__piReceiptAck" must never be mistaken for a marker.
	return record.__piReceipt === true || record.__piReceiptAck === true || record.__piJournal === 1;
}

/**
 * iris_agent#51 framed journal v1. A commit frame is ONE line containing the
 * entry, its pending receipt, a monotonic per-session seq and a checksum over
 * the whole frame. Either the complete line is durably on disk (verifiable
 * via JSON.parse + checksum) or it is torn — there is no intermediate state
 * where an entry exists without its receipt. A torn tail is the only
 * corruption a single-process append can produce; it is quarantined with a
 * typed diagnostic and never treated as a committed message.
 */
const JOURNAL_FRAME_VERSION = 1;

interface JournalFrame {
	__piJournal: 1;
	v: number;
	seq: number;
	entry: SessionTreeEntry;
	receipt: SessionCommitReceipt;
	checksum: string;
}

/**
 * Frame checksum over the canonical frame payload. Uses the global Web Crypto
 * API (Node >=19 and browsers) so the harness keeps bundling for browser
 * platforms (browser-smoke gate), mirroring computeMessageContentHash.
 */
export async function computeJournalFrameChecksum(frame: {
	v: number;
	seq: number;
	entry: SessionTreeEntry;
	receipt: SessionCommitReceipt;
}): Promise<string> {
	const data = new TextEncoder().encode(JSON.stringify([frame.v, frame.seq, frame.entry, frame.receipt]));
	const digest = await crypto.subtle.digest("SHA-256", data);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function encodeJournalFrame(
	seq: number,
	entry: SessionTreeEntry,
	receipt: SessionCommitReceipt,
): Promise<string> {
	const frame: JournalFrame = {
		__piJournal: 1,
		v: JOURNAL_FRAME_VERSION,
		seq,
		entry,
		receipt,
		checksum: await computeJournalFrameChecksum({ v: JOURNAL_FRAME_VERSION, seq, entry, receipt }),
	};
	return JSON.stringify(frame);
}

/**
 * Parse a journal line into a validated frame. Returns undefined when the
 * line is not a journal frame (entry lines, ack markers, legacy markers).
 * Throws {@link invalidEntry} for a frame whose checksum does not verify
 * (bit-rot that still parses as JSON) — callers decide between fail-closed
 * and quarantine depending on whether the line is the file tail.
 */
async function parseJournalFrame(
	line: string,
	path: string,
	lineNumber: number,
): Promise<{ entry: SessionTreeEntry; receipt: SessionCommitReceipt; seq: number } | undefined> {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as {
		__piJournal?: unknown;
		v?: unknown;
		seq?: unknown;
		entry?: unknown;
		receipt?: unknown;
		checksum?: unknown;
	};
	if (record.__piJournal !== 1) return undefined;
	if (typeof record.v !== "number" || record.v !== JOURNAL_FRAME_VERSION) {
		throw invalidEntry(path, lineNumber, `unsupported journal frame version ${JSON.stringify(record.v)}`);
	}
	if (typeof record.seq !== "number" || !Number.isInteger(record.seq) || record.seq < 1) {
		throw invalidEntry(path, lineNumber, "journal frame has an invalid seq");
	}
	if (
		typeof record.entry !== "object" ||
		record.entry === null ||
		typeof record.receipt !== "object" ||
		record.receipt === null
	) {
		throw invalidEntry(path, lineNumber, "journal frame is missing entry or receipt");
	}
	if (typeof record.checksum !== "string" || record.checksum.length !== 64) {
		throw invalidEntry(path, lineNumber, "journal frame has an invalid checksum");
	}
	const frame = record as unknown as JournalFrame;
	const expected = await computeJournalFrameChecksum({
		v: frame.v,
		seq: frame.seq,
		entry: frame.entry,
		receipt: frame.receipt,
	});
	if (expected !== frame.checksum) {
		throw invalidEntry(path, lineNumber, "journal frame checksum mismatch (torn or corrupted commit)");
	}
	return { entry: frame.entry, receipt: frame.receipt, seq: frame.seq };
}

interface JsonlSessionLoadResult {
	metadata: JsonlSessionMetadata;
	entries: SessionTreeEntry[];
	/** Pending receipts in commit order, with the journal seq when known. */
	pendingReceipts: { receipt: SessionCommitReceipt; order: number }[];
	/** Torn-tail / corruption diagnostics from this load (typed, human-readable). */
	diagnostics: string[];
	/**
	 * Highest journal seq seen in the file, INCLUDING frames whose receipts
	 * were already acked. Seeding the next-append counter from pending-only
	 * seqs would reuse a seq after an ack (violating monotonicity).
	 */
	maxJournalSeq: number;
	/** Whether the file tail ends with a newline (torn-tail append guard). */
	tailEndsWithNewline: boolean;
	/**
	 * When a torn tail was quarantined this load: byte offset of the last
	 * COMPLETE line. The backend physically truncates the file to this
	 * offset (when the fs has truncateFile) so the torn bytes cannot
	 * re-poison later reopens after appends.
	 */
	tornTailCleanLength?: number;
}

function encodeCwd(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

function createDocumentDescriptor(options: JsonlSessionCreateOptions): SessionDocumentDescriptor {
	const id = options.id ?? createSessionId();
	if (!id) throw new SessionError("invalid_session", "Session id cannot be empty");
	let encodedId: string;
	try {
		encodedId = encodeURIComponent(id);
	} catch (error) {
		throw new SessionError("invalid_session", `Invalid session id ${JSON.stringify(id)}`, toError(error));
	}
	const timestamp = createTimestamp();
	const fileName = `${timestamp.replace(/[:.]/g, "-")}_${encodedId}.jsonl`;
	return {
		id,
		timestamp,
		fileName,
		operationKey: `document:${JSON.stringify([encodeCwd(options.cwd), fileName])}`,
	};
}

export class JsonlSessionBackend {
	private readonly fs: JsonlSessionRepositoryFileSystem;
	private readonly sessionsRootInput: string;
	private sessionsRoot: string | undefined;
	private readonly entryIndexesByPath = new Map<string, ArraySessionIndex>();
	private readonly operationKeysByPath = new Map<string, string>();
	/** iris_agent#51: per-path next journal seq (monotonic commit sequence). */
	private readonly journalSeqsByPath = new Map<string, number>();
	/** iris_agent#51: torn-tail / corruption diagnostics from the latest load. */
	private readonly loadDiagnosticsByPath = new Map<string, string[]>();
	/**
	 * iris_agent#51: whether the file tail (as of the last full read) ends
	 * with a newline. When false, the next append MUST first emit a newline —
	 * otherwise the new frame is concatenated onto the trailing partial line,
	 * the merged line fails to parse, and the whole line (including the
	 * previously COMPLETE frame written before the torn tail) is quarantined
	 * as one unit, losing a committed pair (review finding, iris_agent#51).
	 */
	private readonly newlineTailsByPath = new Map<string, boolean>();
	private readonly operations: KeyedOperationQueue<string>;
	private disposed = false;
	private disposePromise: Promise<void> | undefined;

	constructor(options: JsonlSessionBackendOptions) {
		this.fs = options.fs;
		this.sessionsRootInput = options.sessionsRoot;
		this.operations = new KeyedOperationQueue({
			maxConcurrentOperations: options.maxConcurrentOperations ?? DEFAULT_MAX_CONCURRENT_OPERATIONS,
		});
	}

	create(options: JsonlSessionCreateOptions): Promise<SessionStorage<JsonlSessionMetadata>> {
		this.assertOpen();
		const descriptor = createDocumentDescriptor(options);
		return this.operations.enqueue(descriptor.operationKey, async () =>
			this.storage(await this.createDocument(descriptor, options, options.parentSessionPath, options.metadata, [])),
		);
	}

	open(metadata: JsonlSessionMetadata): Promise<SessionStorage<JsonlSessionMetadata>> {
		this.assertOpen();
		return this.operations.enqueue(this.operationKey(metadata), async () =>
			this.storage(await this.loadDocument(metadata)),
		);
	}

	/**
	 * Load the session file and, when a torn tail was quarantined AND the
	 * filesystem can truncate, physically remove the torn bytes so they can
	 * never become a mid-file corruption after later appends (iris_agent#51
	 * review finding). The repair is idempotent: once truncated, subsequent
	 * loads find a clean tail and do nothing.
	 */
	/**
	 * Torn-tail / corruption diagnostics are sticky per path: the load that
	 * quarantined a torn tail must keep its note visible to health/readiness
	 * consumers even though later (post-repair) loads are clean. Merged
	 * append-only with a bounded cap so repeated corruption events cannot
	 * grow the list without bound.
	 */
	private recordDiagnostics(path: string, diagnostics: readonly string[]): void {
		if (diagnostics.length === 0) return;
		const existing = this.loadDiagnosticsByPath.get(path) ?? [];
		this.loadDiagnosticsByPath.set(path, [...existing, ...diagnostics].slice(-MAX_LOAD_DIAGNOSTICS));
	}

	private async loadAndRepair(metadata: JsonlSessionMetadata): Promise<JsonlSessionLoadResult> {
		const document = await loadJsonlSession(this.fs, metadata.path);
		if (document.tornTailCleanLength !== undefined && this.fs.truncateFile !== undefined) {
			getFileSystemResultOrThrow(
				await this.fs.truncateFile(metadata.path, document.tornTailCleanLength),
				`Failed to repair torn tail of ${metadata.path}`,
			);
			this.newlineTailsByPath.set(metadata.path, true);
		}
		return document;
	}

	private async loadDocument(metadata: JsonlSessionMetadata): Promise<JsonlSessionMetadata> {
		if (
			!getFileSystemResultOrThrow(await this.fs.exists(metadata.path), `Failed to check session ${metadata.path}`)
		) {
			throw new SessionError("not_found", `Session not found: ${metadata.path}`);
		}
		const document = await this.loadAndRepair(metadata);
		const entries = this.entryIndexesByPath.get(metadata.path);
		if (entries) entries.replace(document.entries);
		else this.entryIndexesByPath.set(metadata.path, new ArraySessionIndex(document.entries));
		this.recordDiagnostics(metadata.path, document.diagnostics);
		this.journalSeqsByPath.set(metadata.path, document.maxJournalSeq);
		this.newlineTailsByPath.set(metadata.path, document.tailEndsWithNewline);
		return document.metadata;
	}

	list(options: JsonlSessionListOptions = {}): Promise<JsonlSessionMetadata[]> {
		this.assertOpen();
		return this.operations.enqueueBarrier(() => this.listSessions(options));
	}

	private async listSessions(options: JsonlSessionListOptions): Promise<JsonlSessionMetadata[]> {
		const dirs = options.cwd ? [await this.getSessionDir(options.cwd)] : await this.listSessionDirs();
		const sessions: JsonlSessionMetadata[] = [];
		for (const dir of dirs) {
			if (!getFileSystemResultOrThrow(await this.fs.exists(dir), `Failed to check session directory ${dir}`))
				continue;
			const files = getFileSystemResultOrThrow(
				await this.fs.listDir(dir),
				`Failed to list sessions in ${dir}`,
			).filter((file) => file.kind !== "directory" && file.name.endsWith(".jsonl"));
			for (const file of files) sessions.push(await loadJsonlSessionMetadata(this.fs, file.path));
		}
		return sessions.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
	}

	private appendEntry(metadata: JsonlSessionMetadata, entry: SessionTreeEntry): Promise<void> {
		this.assertOpen();
		return this.operations.enqueue(this.operationKey(metadata), async () => {
			if (
				!getFileSystemResultOrThrow(await this.fs.exists(metadata.path), `Failed to check session ${metadata.path}`)
			) {
				throw new SessionError("not_found", `Session not found: ${metadata.path}`);
			}
			let entries = this.entryIndexesByPath.get(metadata.path);
			if (!entries) {
				await this.loadDocument(metadata);
				entries = this.entryIndexesByPath.get(metadata.path)!;
			}
			if (entries.has(entry.id)) throw new SessionError("invalid_entry", `Entry ${entry.id} already exists`);
			await this.ensureTrailingNewline(metadata.path);
			getFileSystemResultOrThrow(
				await this.fs.appendFile(metadata.path, `${JSON.stringify(entry)}\n`),
				`Failed to append session entry ${entry.id}`,
			);
			entries.append(entry);
		});
	}

	/**
	 * iris_agent#51 torn-tail append guard: appends a newline when the file
	 * tail is known (or assumed) to lack one. Without this, a new frame or
	 * marker would be concatenated onto the trailing partial line; the merged
	 * line then fails to parse and the WHOLE line — including any complete
	 * frame written before the torn tail — is quarantined as one unit,
	 * silently losing a previously committed pair.
	 */
	private async ensureTrailingNewline(path: string): Promise<void> {
		if (this.newlineTailsByPath.get(path) !== false) return;
		getFileSystemResultOrThrow(
			await this.fs.appendFile(path, "\n"),
			`Failed to repair newline tail of ${path} before append`,
		);
		this.newlineTailsByPath.set(path, true);
	}

	delete(metadata: JsonlSessionMetadata): Promise<void> {
		this.assertOpen();
		return this.operations.enqueue(this.operationKey(metadata), async () => {
			getFileSystemResultOrThrow(
				await this.fs.remove(metadata.path, { force: true }),
				`Failed to delete session ${metadata.path}`,
			);
			this.entryIndexesByPath.delete(metadata.path);
			this.operationKeysByPath.delete(metadata.path);
		});
	}

	fork(
		source: JsonlSessionMetadata,
		options: JsonlSessionCreateOptions,
		selection: SessionForkSelection,
	): Promise<SessionStorage<JsonlSessionMetadata>> {
		this.assertOpen();
		const descriptor = createDocumentDescriptor(options);
		const sourceEntries = this.operations.enqueue(this.operationKey(source), async () => {
			if (!getFileSystemResultOrThrow(await this.fs.exists(source.path), `Failed to check session ${source.path}`)) {
				throw new SessionError("not_found", `Session not found: ${source.path}`);
			}
			const document = await loadJsonlSession(this.fs, source.path);
			const entries = this.entryIndexesByPath.get(source.path);
			if (entries) entries.replace(document.entries);
			else this.entryIndexesByPath.set(source.path, new ArraySessionIndex(document.entries));
			return readSessionEntriesForFork(this.entryIndexesByPath.get(source.path)!, selection);
		});
		return this.operations.enqueue(descriptor.operationKey, async () =>
			this.storage(
				await this.createDocument(
					descriptor,
					options,
					options.parentSessionPath ?? source.path,
					options.metadata ?? source.metadata,
					await sourceEntries,
				),
			),
		);
	}

	async [Symbol.asyncDispose](): Promise<void> {
		if (!this.disposePromise) {
			this.disposed = true;
			this.disposePromise = this.operations.drain();
		}
		await this.disposePromise;
	}

	private assertOpen(): void {
		if (this.disposed) throw new SessionError("storage", "JSONL session repository is disposed");
	}

	private operationKey(metadata: JsonlSessionMetadata): string {
		return this.operationKeysByPath.get(metadata.path) ?? metadata.path;
	}

	private async createDocument(
		descriptor: SessionDocumentDescriptor,
		options: JsonlSessionCreateOptions,
		parentSessionPath: string | undefined,
		metadata: Record<string, unknown> | undefined,
		entries: readonly SessionTreeEntry[],
	): Promise<JsonlSessionMetadata> {
		const dir = await this.getSessionDir(options.cwd);
		getFileSystemResultOrThrow(
			await this.fs.createDir(dir, { recursive: true }),
			`Failed to create session directory ${dir}`,
		);
		const path = getFileSystemResultOrThrow(
			await this.fs.joinPath([dir, descriptor.fileName]),
			`Failed to resolve session file path for ${descriptor.id}`,
		);
		if (getFileSystemResultOrThrow(await this.fs.exists(path), `Failed to check session ${path}`)) {
			throw new SessionError("invalid_session", `Session already exists: ${path}`);
		}
		const header: SessionHeader = {
			type: "session",
			version: 3,
			id: descriptor.id,
			timestamp: descriptor.timestamp,
			cwd: options.cwd,
			parentSession: parentSessionPath,
			metadata,
		};
		const content = [JSON.stringify(header), ...entries.map((entry) => JSON.stringify(entry)), ""].join("\n");
		getFileSystemResultOrThrow(await this.fs.writeFile(path, content), `Failed to create session ${path}`);
		this.entryIndexesByPath.set(path, new ArraySessionIndex(entries));
		this.operationKeysByPath.set(path, descriptor.operationKey);
		this.newlineTailsByPath.set(path, true);
		return metadataFromHeader(header, path);
	}

	private readIndex<T>(metadata: JsonlSessionMetadata, read: (entries: ArraySessionIndex) => T): Promise<T> {
		this.assertOpen();
		return this.operations.enqueue(this.operationKey(metadata), () => read(this.entryIndex(metadata.path)));
	}

	private storage(metadata: JsonlSessionMetadata): SessionStorage<JsonlSessionMetadata> {
		return {
			metadata,
			readHead: () => this.readIndex(metadata, (entries) => entries.readHead()),
			readEntry: (id) => this.readIndex(metadata, (entries) => entries.readEntry(id)),
			readEntries: (options) => this.readIndex(metadata, (entries) => entries.readEntries(options)),
			appendEntry: (entry) => this.appendEntry(metadata, entry),
			findEntriesOnBranch: (query) => this.readIndex(metadata, (entries) => entries.findEntriesOnBranch(query)),
			readPathToRootOrCompaction: (leafId) =>
				this.readIndex(metadata, (entries) => entries.readPathToRootOrCompaction(leafId)),
			getLabel: (id) => this.readIndex(metadata, (entries) => entries.getLabel(id)),
			getName: () => this.readIndex(metadata, (entries) => entries.getName()),
			getStats: () => this.readIndex(metadata, (entries) => entries.getStats()),
			appendEntryWithReceipt: (entry, receipt) => this.appendEntryWithReceipt(metadata, entry, receipt),
			readPendingCommitReceipts: () => this.readPendingCommitReceipts(metadata),
			ackCommitReceipt: (entryId) => this.ackCommitReceipt(metadata, entryId),
			supportsCrashRecoverableReceipts: () => this.supportsCrashRecoverableReceipts(),
			journalDiagnostics: () => this.journalDiagnostics(metadata),
		};
	}

	/**
	 * iris_agent#51 framed journal append. Writes ONE self-describing frame
	 * line containing the entry, its pending receipt, a monotonic seq and a
	 * sha256 checksum, then fsyncs the file BEFORE returning — the durable
	 * append and the recoverable receipt are one verifiable unit. A torn
	 * write (crash mid-append) can only leave an incomplete LAST line, which
	 * the loader quarantines; it can never yield a complete entry without its
	 * receipt. Requires the fsync (`syncFile`) capability; without it the
	 * backend refuses the journal (fail closed) instead of claiming an
	 * unsupported durability boundary.
	 */
	private appendEntryWithReceipt(
		metadata: JsonlSessionMetadata,
		entry: SessionTreeEntry,
		receipt: SessionCommitReceipt,
	): Promise<void> {
		this.assertOpen();
		return this.operations.enqueue(this.operationKey(metadata), async () => {
			if (
				!getFileSystemResultOrThrow(await this.fs.exists(metadata.path), `Failed to check session ${metadata.path}`)
			) {
				throw new SessionError("not_found", `Session not found: ${metadata.path}`);
			}
			if (this.fs.syncFile === undefined || this.fs.truncateFile === undefined) {
				throw new SessionError(
					"storage",
					`JSONL commit journal requires fsync (syncFile) and torn-tail repair (truncateFile) capabilities; crash-recoverable receipts are unsupported on this filesystem (${metadata.path})`,
				);
			}
			let entries = this.entryIndexesByPath.get(metadata.path);
			if (!entries) {
				await this.loadDocument(metadata);
				entries = this.entryIndexesByPath.get(metadata.path)!;
			}
			if (entries.has(entry.id)) throw new SessionError("invalid_entry", `Entry ${entry.id} already exists`);
			const seq = (this.journalSeqsByPath.get(metadata.path) ?? 0) + 1;
			const line = await encodeJournalFrame(seq, entry, receipt);
			await this.ensureTrailingNewline(metadata.path);
			getFileSystemResultOrThrow(
				await this.fs.appendFile(metadata.path, `${line}\n`),
				`Failed to append session entry ${entry.id}`,
			);
			// Durability boundary: the caller must not observe success before
			// the frame is flushed to stable storage.
			getFileSystemResultOrThrow(
				await this.fs.syncFile(metadata.path),
				`Failed to fsync session ${metadata.path} after journal append`,
			);
			this.journalSeqsByPath.set(metadata.path, seq);
			entries.append(entry);
		});
	}

	/**
	 * Pending (recorded, not yet acked) receipts in commit order
	 * (iris_agent#50: authoritative seq order; timestamps are diagnostics).
	 * Re-reads the file so ack markers appended since the last load are
	 * reflected; frames are validated structurally and by checksum.
	 */
	private async readPendingCommitReceipts(metadata: JsonlSessionMetadata): Promise<readonly SessionCommitReceipt[]> {
		this.assertOpen();
		return this.operations.enqueue(this.operationKey(metadata), async () => {
			const document = await this.loadAndRepair(metadata);
			this.recordDiagnostics(metadata.path, document.diagnostics);
			this.journalSeqsByPath.set(metadata.path, document.maxJournalSeq);
			this.newlineTailsByPath.set(metadata.path, document.tailEndsWithNewline);
			return [...document.pendingReceipts].sort((a, b) => a.order - b.order).map((pending) => pending.receipt);
		});
	}

	/**
	 * Appends an append-only ack marker; replay skips acked entry ids. The
	 * marker is intentionally NOT fsynced: losing a torn ack tail only
	 * re-replays an already-published receipt (idempotent for consumers), it
	 * never fabricates a duplicate commit.
	 */
	private ackCommitReceipt(metadata: JsonlSessionMetadata, entryId: string): Promise<void> {
		this.assertOpen();
		return this.operations.enqueue(this.operationKey(metadata), async () => {
			if (
				!getFileSystemResultOrThrow(await this.fs.exists(metadata.path), `Failed to check session ${metadata.path}`)
			) {
				throw new SessionError("not_found", `Session not found: ${metadata.path}`);
			}
			const marker = JSON.stringify({ __piReceiptAck: true, entryId });
			await this.ensureTrailingNewline(metadata.path);
			getFileSystemResultOrThrow(
				await this.fs.appendFile(metadata.path, `${marker}\n`),
				`Failed to acknowledge receipt for entry ${entryId}`,
			);
		});
	}

	/**
	 * iris_agent#51 explicit durability capability: crash-recoverable receipts
	 * are supported exactly when the filesystem can fsync (durable append
	 * boundary) AND truncate (physical torn-tail repair; without it a torn
	 * line would poison every reopen after later appends).
	 */
	supportsCrashRecoverableReceipts(): boolean {
		return this.fs.syncFile !== undefined && this.fs.truncateFile !== undefined;
	}

	/** Diagnostics from the most recent load of this session file. */
	journalDiagnostics(metadata: JsonlSessionMetadata): readonly string[] {
		return [...(this.loadDiagnosticsByPath.get(metadata.path) ?? [])];
	}

	private entryIndex(path: string): ArraySessionIndex {
		const entries = this.entryIndexesByPath.get(path);
		if (!entries) throw new SessionError("not_found", `Session not found: ${path}`);
		return entries;
	}

	private async getSessionsRoot(): Promise<string> {
		this.sessionsRoot ??= getFileSystemResultOrThrow(
			await this.fs.absolutePath(this.sessionsRootInput),
			`Failed to resolve sessions root ${this.sessionsRootInput}`,
		);
		return this.sessionsRoot;
	}

	private async getSessionDir(cwd: string): Promise<string> {
		return getFileSystemResultOrThrow(
			await this.fs.joinPath([await this.getSessionsRoot(), encodeCwd(cwd)]),
			`Failed to resolve session directory for ${cwd}`,
		);
	}

	private async listSessionDirs(): Promise<string[]> {
		const root = await this.getSessionsRoot();
		if (!getFileSystemResultOrThrow(await this.fs.exists(root), `Failed to check sessions root ${root}`)) return [];
		return getFileSystemResultOrThrow(await this.fs.listDir(root), `Failed to list sessions root ${root}`)
			.filter((entry) => entry.kind === "directory")
			.map((entry) => entry.path);
	}
}

export interface JsonlSessionRepositoryOptions extends JsonlSessionBackendOptions {
	contextBuildOptions?: SessionContextBuildOptions;
}

export class JsonlSessionRepository
	implements SessionRepository<JsonlSessionMetadata, JsonlSessionCreateOptions, JsonlSessionListOptions>
{
	private readonly backend: JsonlSessionBackend;
	private readonly contextBuildOptions: SessionContextBuildOptions;

	constructor(options: JsonlSessionRepositoryOptions) {
		const { contextBuildOptions, ...backendOptions } = options;
		this.backend = new JsonlSessionBackend(backendOptions);
		this.contextBuildOptions = contextBuildOptions ?? {};
	}

	async create(options: JsonlSessionCreateOptions): Promise<Session<JsonlSessionMetadata>> {
		return createSession(await this.backend.create(options), this.contextBuildOptions);
	}

	async open(metadata: JsonlSessionMetadata): Promise<Session<JsonlSessionMetadata>> {
		return createSession(await this.backend.open(metadata), this.contextBuildOptions);
	}

	async list(options?: JsonlSessionListOptions): Promise<JsonlSessionMetadata[]> {
		return await this.backend.list(options);
	}

	async delete(metadata: JsonlSessionMetadata): Promise<void> {
		await this.backend.delete(metadata);
	}

	async fork(
		source: JsonlSessionMetadata,
		options: SessionForkOptions & JsonlSessionCreateOptions,
	): Promise<Session<JsonlSessionMetadata>> {
		const { entryId: _entryId, position: _position, ...createOptions } = options;
		return createSession(
			await this.backend.fork(source, createOptions, createSessionForkSelection(options)),
			this.contextBuildOptions,
		);
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.backend[Symbol.asyncDispose]();
	}
}
