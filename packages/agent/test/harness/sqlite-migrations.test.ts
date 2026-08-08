import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	applyMigrations,
	createNodeSqliteFactory,
	loadMigrations,
	loadReleaseManifest,
	type SqliteDatabase,
	type SqliteDatabaseFactory,
	type SqliteRunResult,
	type SqliteSessionMetadata,
	SqliteSessionRepository,
	type SqliteStatement,
} from "../../../storage/sqlite-node/src/index.ts";
import type { SqliteMigration } from "../../../storage/sqlite-node/src/sqlite/migrations.ts";
import { SqliteSessionConnection } from "../../../storage/sqlite-node/src/sqlite/storage/index.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { createAssistantMessage, createUserMessage } from "./session-test-utils.ts";

function createTempDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-agent-sqlite-"));
}

class ThrowingStatement implements SqliteStatement {
	private readonly onRun: () => Promise<SqliteRunResult>;

	constructor(onRun: () => Promise<SqliteRunResult>) {
		this.onRun = onRun;
	}

	async run(..._params: unknown[]): Promise<SqliteRunResult> {
		return this.onRun();
	}

	async get<TRow extends object>(..._params: unknown[]): Promise<TRow | undefined> {
		return undefined;
	}

	async all<TRow extends object>(..._params: unknown[]): Promise<TRow[]> {
		return [];
	}
}

class CountingDatabase implements SqliteDatabase {
	closeCount = 0;
	private readonly statementFactory: (sql: string) => SqliteStatement;

	constructor(statementFactory: (sql: string) => SqliteStatement) {
		this.statementFactory = statementFactory;
	}

	async exec(_sql: string): Promise<void> {}

	prepare(sql: string): SqliteStatement {
		return this.statementFactory(sql);
	}

	async transaction<T>(fn: () => Promise<T>): Promise<T> {
		return fn();
	}

	async close(): Promise<void> {
		this.closeCount += 1;
	}
}

function createCloseCountingSqliteFactory(): {
	sqlite: SqliteDatabaseFactory;
	counts: { opens: number; closes: number };
} {
	const source = createNodeSqliteFactory();
	const counts = { opens: 0, closes: 0 };
	return {
		counts,
		sqlite: {
			async open(path) {
				const db = await source.open(path);
				counts.opens += 1;
				return {
					exec: (sql) => db.exec(sql),
					prepare: (sql) => db.prepare(sql),
					transaction: (fn) => db.transaction(fn),
					async close() {
						counts.closes += 1;
						await db.close();
					},
				};
			},
		},
	};
}

describe("SQLite migrations", () => {
	it("applies file-based migrations and records them", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const env = new NodeExecutionEnv({ cwd: root });
		const sqlite = createNodeSqliteFactory();
		const repo = new SqliteSessionRepository({ env, sqlite, databasePath });
		await repo.create({ cwd: root, id: "session-1" });

		const db = await sqlite.open(databasePath);
		try {
			const rows = await db
				.prepare("SELECT id, checksum FROM migrations ORDER BY id")
				.all<{ id: string; checksum: string }>();
			expect(rows.map((row) => row.id)).toEqual([
				"001_initial.sql",
				"002_branch_tips.sql",
				"003_commit_receipts.sql",
				"004_receipt_seq.sql",
				"005_quarantine.sql",
			]);
			// iris_agent#50: every applied migration carries a release-owned
			// sha256 checksum of its SQL (fail closed if a released migration
			// is edited in place after being applied).
			for (const row of rows) {
				expect(row.checksum).toMatch(/^[0-9a-f]{64}$/);
			}
			const tables = await db
				.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name")
				.all<{ name: string; sql: string | null }>();
			expect(tables.map((row) => row.name)).toEqual(
				expect.arrayContaining([
					"migrations",
					"sessions",
					"session_entries",
					"session_sequences",
					"branch_entries",
					"branch_tips",
					"session_materialized",
					"entry_materialized",
				]),
			);
			const sessionColumns = await db.prepare("PRAGMA table_info(sessions)").all<{ name: string }>();
			expect(sessionColumns.map((column) => column.name)).toContain("active_leaf_id");
			const branchIndexes = await db
				.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'branch_entries'")
				.all<{ name: string }>();
			expect(branchIndexes.map((index) => index.name)).toContain("idx_branch_entries_session_branch_seq");
			expect(branchIndexes.map((index) => index.name)).not.toContain("idx_branch_entries_session_branch");
			for (const tableName of [
				"sessions",
				"session_sequences",
				"branch_entries",
				"branch_tips",
				"session_materialized",
				"entry_materialized",
			]) {
				const table = tables.find((row) => row.name === tableName);
				expect(table?.sql).toContain("WITHOUT ROWID");
			}
		} finally {
			await db.close();
		}
	});

	it("clears legacy branch projections when adding explicit tips", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const sqlite = createNodeSqliteFactory();
		const db = await sqlite.open(databasePath);
		try {
			const initial = (await loadMigrations()).find((migration) => migration.id === "001_initial.sql");
			if (!initial) throw new Error("Missing initial SQLite migration");
			await db.exec(initial.sql);
			await db.exec("CREATE TABLE migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
			await db
				.prepare("INSERT INTO migrations (id, applied_at) VALUES (?, ?)")
				.run(initial.id, "2026-01-01T00:00:00.000Z");
			await db
				.prepare("INSERT INTO branch_entries (session_id, branch_id, entry_id, entry_seq) VALUES (?, ?, ?, ?)")
				.run("session-1", "legacy-branch", "entry-1", 1);

			await applyMigrations(db);

			expect(await db.prepare("SELECT entry_id FROM branch_entries").all<{ entry_id: string }>()).toEqual([]);
			expect(
				await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'branch_tips'").get(),
			).toBeDefined();
			expect(
				(await db.prepare("SELECT id FROM migrations ORDER BY id").all<{ id: string }>()).map((row) => row.id),
			).toEqual([
				"001_initial.sql",
				"002_branch_tips.sql",
				"003_commit_receipts.sql",
				"004_receipt_seq.sql",
				"005_quarantine.sql",
			]);
		} finally {
			await db.close();
		}
	});

	it("iris_agent#50: a 003-era database upgrades cleanly and backfills receipt_seq from entry order", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const sqlite = createNodeSqliteFactory();
		const db = await sqlite.open(databasePath);
		try {
			// Build a pre-004 database by hand: apply 001-003 only, insert a
			// session + entries + receipt rows (the 003-era writer shape).
			await db.exec("CREATE TABLE migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
			for (const id of ["001_initial.sql", "002_branch_tips.sql", "003_commit_receipts.sql"]) {
				const migration = (await loadMigrations()).find((m) => m.id === id);
				if (!migration) throw new Error(`Missing ${id}`);
				await db.exec(migration.sql);
				await db
					.prepare("INSERT INTO migrations (id, applied_at) VALUES (?, ?)")
					.run(migration.id, new Date().toISOString());
			}
			await db
				.prepare(
					"INSERT INTO sessions (id, created_at, metadata, cwd, parent_session_id, active_leaf_id) VALUES (?, ?, ?, ?, NULL, NULL)",
				)
				.run("legacy-session", "2026-01-01T00:00:00.000Z", "{}", root);
			for (const [entryId, seq] of [
				["e1", 1],
				["e2", 2],
				["e3", 3],
			] as const) {
				await db
					.prepare(
						"INSERT INTO session_entries (session_id, id, entry_seq, parent_id, type, timestamp, payload) VALUES (?, ?, ?, NULL, 'message', ?, '{}')",
					)
					.run("legacy-session", entryId, seq, "2026-01-01T00:00:00.000Z");
				await db
					.prepare(
						"INSERT INTO session_commit_receipts (session_id, entry_id, content_hash, committed_at, acked) VALUES (?, ?, ?, ?, 0)",
					)
					.run("legacy-session", entryId, "hash".padEnd(64, "0"), "2026-01-01T00:00:00.000Z");
			}

			// Upgrade: 004 backfills receipt_seq = entry_seq (append order),
			// 005 adds the quarantine column.
			await applyMigrations(db);
			const rows = await db
				.prepare(
					"SELECT entry_id, receipt_seq, quarantine_reason FROM session_commit_receipts ORDER BY receipt_seq",
				)
				.all<{
					entry_id: string;
					receipt_seq: number;
					quarantine_reason: string | null;
				}>();
			expect(rows.map((row) => row.entry_id)).toEqual(["e1", "e2", "e3"]);
			expect(rows.map((row) => row.receipt_seq)).toEqual([1, 2, 3]);
			expect(rows.every((row) => row.quarantine_reason === null)).toBe(true);
		} finally {
			await db.close();
		}
	});

	it("iris_agent#50: a migration edited in place after being applied fails closed (release-owned checksum)", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const sqlite = createNodeSqliteFactory();
		const db = await sqlite.open(databasePath);
		try {
			// Apply all migrations, then corrupt the recorded checksum of an
			// applied migration (simulating a released migration file that
			// changed after being applied elsewhere).
			await applyMigrations(db);
			await db
				.prepare("UPDATE migrations SET checksum = ? WHERE id = ?")
				.run("0".repeat(64), "003_commit_receipts.sql");
			await expect(applyMigrations(db)).rejects.toThrow(/checksum mismatch/);
		} finally {
			await db.close();
		}
	});

	it("iris_agent#67: every released migration has a manifest checksum matching the packaged SQL (release-owned gate)", async () => {
		const manifest = await loadReleaseManifest();
		const migrations = await loadMigrations();
		// Every packaged migration must be pinned in the release manifest —
		// same ids, same RELEASE ORDER (a reordered manifest/package pair
		// would silently apply a different sequence on a fresh database).
		expect(manifest.map((entry) => entry.id)).toEqual(migrations.map((migration) => migration.id));
		// The pinned checksums must equal the sha256 of the packaged SQL — if a
		// released migration file is edited without updating the manifest, this
		// fails closed at the source.
		for (const migration of migrations) {
			const entry = manifest.find((candidate) => candidate.id === migration.id);
			expect(entry, migration.id).toBeDefined();
			expect(entry?.sha256, migration.id).toBe(createHash("sha256").update(migration.sql).digest("hex"));
		}
	});

	it("iris_agent#67: a legacy DB with empty checksum rows backfills ONLY against the release-owned manifest", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const sqlite = createNodeSqliteFactory();
		const db = await sqlite.open(databasePath);
		try {
			// Pre-checksum era: migrations table without a checksum column,
			// every released migration already applied.
			await db.exec("CREATE TABLE migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
			const migrations = await loadMigrations();
			for (const migration of migrations) {
				await db.exec(migration.sql);
				await db
					.prepare("INSERT INTO migrations (id, applied_at) VALUES (?, ?)")
					.run(migration.id, new Date().toISOString());
			}
			// First checksum-enabled upgrade: empty rows backfill to the
			// release-owned pinned checksums, not to a self-blessed hash.
			await applyMigrations(db);
			const rows = await db
				.prepare("SELECT id, checksum FROM migrations ORDER BY id")
				.all<{ id: string; checksum: string }>();
			const manifest = await loadReleaseManifest();
			const byId = new Map(manifest.map((entry) => [entry.id, entry.sha256]));
			for (const row of rows) {
				expect(row.checksum, row.id).toBe(byId.get(row.id));
			}
		} finally {
			await db.close();
		}
	});

	it("iris_agent#67: an edited legacy migration fails closed before the first checksum backfill (no self-blessing)", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const sqlite = createNodeSqliteFactory();
		const db = await sqlite.open(databasePath);
		try {
			// Pre-checksum era DB with 001-003 applied (the 003-era shape).
			await db.exec("CREATE TABLE migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
			for (const id of ["001_initial.sql", "002_branch_tips.sql", "003_commit_receipts.sql"]) {
				const migration = (await loadMigrations()).find((m) => m.id === id);
				if (!migration) throw new Error(`Missing ${id}`);
				await db.exec(migration.sql);
				await db
					.prepare("INSERT INTO migrations (id, applied_at) VALUES (?, ?)")
					.run(migration.id, new Date().toISOString());
			}
			// The packaged 003 SQL is EDITED before the first checksum-enabled
			// upgrade (e.g. an operator touched the released file). The old code
			// blessed the current file's hash; the fix must fail closed because
			// it does not match the release-owned manifest.
			const edited = (await loadMigrations()).map((m) =>
				m.id === "003_commit_receipts.sql" ? { ...m, sql: `${m.sql}\n-- edited in place\n` } : m,
			);
			await expect(applyMigrations(db, { migrations: edited })).rejects.toThrow(/manifest checksum|fail closed/);
			// The empty checksum row was NOT backfilled (no silent blessing).
			const row = await db
				.prepare("SELECT checksum FROM migrations WHERE id = ?")
				.get<{ checksum: string }>("003_commit_receipts.sql");
			expect(row?.checksum).toBe("");
		} finally {
			await db.close();
		}
	});

	it("iris_agent#67: an unknown applied migration id fails closed instead of being silently ignored", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const sqlite = createNodeSqliteFactory();
		const db = await sqlite.open(databasePath);
		try {
			// Pre-checksum era DB where a NEWER unknown migration id is already
			// recorded (schema from a newer release than this checkout).
			await db.exec("CREATE TABLE migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
			const migrations = await loadMigrations();
			for (const migration of migrations) {
				await db.exec(migration.sql);
				await db
					.prepare("INSERT INTO migrations (id, applied_at) VALUES (?, ?)")
					.run(migration.id, new Date().toISOString());
			}
			await db
				.prepare("INSERT INTO migrations (id, applied_at) VALUES (?, ?)")
				.run("999_unknown_future.sql", new Date().toISOString());
			// The unknown id is not part of this release's packaged migrations —
			// the runner must fail closed instead of proceeding against a schema
			// that may be newer than the checkout.
			await expect(applyMigrations(db)).rejects.toThrow(/999_unknown_future.sql/);
			await expect(applyMigrations(db)).rejects.toThrow(/fail closed/);
		} finally {
			await db.close();
		}
	});

	// iris_agent#78: helper — build a pre-checksum-era database with the
	// first `count` migrations applied (migrations table WITHOUT a checksum
	// column, as every database shipped before the checksum feature).
	async function createPreChecksumDatabase(
		db: SqliteDatabase,
		migrations: SqliteMigration[],
		count: number,
	): Promise<void> {
		await db.exec("CREATE TABLE migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
		for (let i = 0; i < count; i++) {
			await db.exec(migrations[i].sql);
			await db
				.prepare("INSERT INTO migrations (id, applied_at) VALUES (?, ?)")
				.run(migrations[i].id, new Date().toISOString());
		}
	}

	it("iris_agent#78: clean initialization records the release-manifest checksum for every packaged migration", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const sqlite = createNodeSqliteFactory();
		const db = await sqlite.open(databasePath);
		try {
			await applyMigrations(db);
			const rows = await db
				.prepare("SELECT id, checksum FROM migrations ORDER BY id")
				.all<{ id: string; checksum: string }>();
			const manifest = await loadReleaseManifest();
			const byId = new Map(manifest.map((entry) => [entry.id, entry.sha256]));
			expect(rows.map((row) => row.id)).toEqual(manifest.map((entry) => entry.id));
			for (const row of rows) {
				expect(row.checksum, row.id).toBe(byId.get(row.id));
			}
		} finally {
			await db.close();
		}
	});

	it("iris_agent#78: EVERY pre-checksum legacy upgrade boundary backfills against the release manifest", async () => {
		const migrations = await loadMigrations();
		const manifest = await loadReleaseManifest();
		const manifestById = new Map(manifest.map((entry) => [entry.id, entry.sha256]));
		// Reference schema produced by a clean initialization.
		const cleanRoot = createTempDir();
		const cleanSqlite = createNodeSqliteFactory();
		const cleanDb = await cleanSqlite.open(join(cleanRoot, "sessions.sqlite"));
		let cleanTables: string[];
		try {
			await applyMigrations(cleanDb);
			cleanTables = (
				await cleanDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>()
			)
				.map((row) => row.name)
				.sort();
		} finally {
			await cleanDb.close();
		}
		// Every supported pre-checksum boundary: a database created by any
		// prefix of the released migrations (001-era, 001-002-era,
		// 001-002-003-era, 001-002-003-004-era).
		for (let boundary = 1; boundary < migrations.length; boundary++) {
			const root = createTempDir();
			const databasePath = join(root, "sessions.sqlite");
			const sqlite = createNodeSqliteFactory();
			const db = await sqlite.open(databasePath);
			try {
				await createPreChecksumDatabase(db, migrations, boundary);
				await applyMigrations(db);
				const rows = await db
					.prepare("SELECT id, checksum FROM migrations ORDER BY id")
					.all<{ id: string; checksum: string }>();
				expect(
					rows.map((row) => row.id),
					`boundary ${boundary} applied set`,
				).toEqual(manifest.map((entry) => entry.id));
				for (const row of rows) {
					expect(row.checksum, `boundary ${boundary}: ${row.id}`).toBe(manifestById.get(row.id));
				}
				// The upgrade produced the exact same schema as a clean init.
				const tables = await db
					.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
					.all<{ name: string }>();
				expect(tables.map((row) => row.name).sort(), `boundary ${boundary} schema`).toEqual(cleanTables);
			} finally {
				await db.close();
			}
		}
	});

	it("iris_agent#78: a released migration missing from the packaged set fails closed before any application or backfill", async () => {
		const migrations = await loadMigrations();
		const withoutQuarantine = migrations.filter((migration) => migration.id !== "005_quarantine.sql");
		// Fresh database: the failure must happen before ANY mutation — not
		// even the migrations table is bootstrapped.
		{
			const root = createTempDir();
			const databasePath = join(root, "sessions.sqlite");
			const sqlite = createNodeSqliteFactory();
			const db = await sqlite.open(databasePath);
			try {
				await expect(applyMigrations(db, { migrations: withoutQuarantine })).rejects.toThrow(
					/005_quarantine\.sql.*missing from the packaged migration set/,
				);
				const table = await db
					.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migrations'")
					.get();
				expect(table).toBeUndefined();
			} finally {
				await db.close();
			}
		}
		// Legacy database: the failure must happen before ANY backfill — the
		// migrations table is not even altered to add the checksum column.
		{
			const root = createTempDir();
			const databasePath = join(root, "sessions.sqlite");
			const sqlite = createNodeSqliteFactory();
			const db = await sqlite.open(databasePath);
			try {
				await createPreChecksumDatabase(db, migrations, 4);
				await expect(applyMigrations(db, { migrations: withoutQuarantine })).rejects.toThrow(
					/005_quarantine\.sql.*missing from the packaged migration set/,
				);
				const columns = await db.prepare("PRAGMA table_info(migrations)").all<{ name: string }>();
				expect(columns.map((column) => column.name)).not.toContain("checksum");
			} finally {
				await db.close();
			}
		}
	});

	it("iris_agent#78: a reordered packaged migration set fails closed instead of silently applying a different sequence", async () => {
		const migrations = await loadMigrations();
		const reordered = [migrations[0], migrations[2], migrations[1], migrations[3], migrations[4]];
		// Fresh database: nothing may be applied from a reordered package.
		{
			const root = createTempDir();
			const databasePath = join(root, "sessions.sqlite");
			const sqlite = createNodeSqliteFactory();
			const db = await sqlite.open(databasePath);
			try {
				await expect(applyMigrations(db, { migrations: reordered })).rejects.toThrow(/out of release order/);
				const table = await db
					.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migrations'")
					.get();
				expect(table).toBeUndefined();
			} finally {
				await db.close();
			}
		}
		// Legacy database: no checksum backfill may happen from a reordered
		// package either — the migrations table is not even altered.
		{
			const root = createTempDir();
			const databasePath = join(root, "sessions.sqlite");
			const sqlite = createNodeSqliteFactory();
			const db = await sqlite.open(databasePath);
			try {
				await createPreChecksumDatabase(db, migrations, migrations.length);
				await expect(applyMigrations(db, { migrations: reordered })).rejects.toThrow(/out of release order/);
				const columns = await db.prepare("PRAGMA table_info(migrations)").all<{ name: string }>();
				expect(columns.map((column) => column.name)).not.toContain("checksum");
			} finally {
				await db.close();
			}
		}
	});

	it("iris_agent#78: a packaged migration without a manifest entry interleaved with released migrations fails closed", async () => {
		const migrations = await loadMigrations();
		const interleaved = [
			migrations[0],
			{ ...migrations[1], id: "006_draft.sql", order: 6 },
			migrations[2],
			migrations[3],
			migrations[4],
		];
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const sqlite = createNodeSqliteFactory();
		const db = await sqlite.open(databasePath);
		try {
			await expect(applyMigrations(db, { migrations: interleaved })).rejects.toThrow(/interleaved/);
			const table = await db
				.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migrations'")
				.get();
			expect(table).toBeUndefined();
		} finally {
			await db.close();
		}
	});

	it("iris_agent#78: a not-yet-released migration appended AFTER the released set applies and records its own checksum", async () => {
		const migrations = [
			...(await loadMigrations()),
			{
				id: "006_draft.sql",
				order: 6,
				sql: "-- draft migration under development\nCREATE TABLE IF NOT EXISTS draft_marker (id INTEGER PRIMARY KEY);\n",
			},
		];
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const sqlite = createNodeSqliteFactory();
		const db = await sqlite.open(databasePath);
		try {
			await applyMigrations(db, { migrations });
			const rows = await db
				.prepare("SELECT id, checksum FROM migrations ORDER BY id")
				.all<{ id: string; checksum: string }>();
			expect(rows.map((row) => row.id)).toEqual([
				"001_initial.sql",
				"002_branch_tips.sql",
				"003_commit_receipts.sql",
				"004_receipt_seq.sql",
				"005_quarantine.sql",
				"006_draft.sql",
			]);
			const draft = rows.find((row) => row.id === "006_draft.sql");
			expect(draft?.checksum).toBe(createHash("sha256").update(migrations[5].sql).digest("hex"));
			expect(
				await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'draft_marker'").get(),
			).toBeDefined();
		} finally {
			await db.close();
		}
	});

	it("persists session metadata through create, list, open, and fork", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const env = new NodeExecutionEnv({ cwd: root });
		const repo = new SqliteSessionRepository({
			env,
			sqlite: createNodeSqliteFactory(),
			databasePath,
		});
		const source = await repo.create({
			cwd: root,
			id: "session-1",
			metadata: { profile: "reviewer" },
		});
		const sourceMetadata = await source.getMetadata();
		expect(sourceMetadata.metadata).toEqual({ profile: "reviewer" });
		expect((await repo.list({ cwd: root })).map((listed) => listed.metadata)).toEqual([{ profile: "reviewer" }]);
		expect((await (await repo.open(sourceMetadata)).getMetadata()).metadata).toEqual({ profile: "reviewer" });
		const fork = await repo.fork(sourceMetadata, {
			cwd: root,
			id: "session-2",
		});
		expect((await fork.getMetadata()).metadata).toEqual({
			profile: "reviewer",
		});
		const overridden = await repo.fork(sourceMetadata, {
			cwd: root,
			id: "session-3",
			metadata: { profile: "writer" },
		});
		expect((await overridden.getMetadata()).metadata).toEqual({
			profile: "writer",
		});
	});

	it("rolls back the entire fork when copying an entry fails", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const env = new NodeExecutionEnv({ cwd: root });
		const sqlite = createNodeSqliteFactory();
		const repo = new SqliteSessionRepository({ env, sqlite, databasePath });
		const source = await repo.create({ cwd: root, id: "source" });
		await source.appendMessage(createUserMessage("one"));
		await source.appendMessage(createAssistantMessage("two"));

		const db = await sqlite.open(databasePath);
		try {
			await db.exec(`
CREATE TRIGGER fail_fork_entry BEFORE INSERT ON session_entries
WHEN new.session_id = 'fork' AND new.entry_seq = 2
BEGIN
  SELECT RAISE(ABORT, 'fail fork');
END;
`);
		} finally {
			await db.close();
		}

		await expect(repo.fork(await source.getMetadata(), { cwd: root, id: "fork" })).rejects.toMatchObject({
			code: "storage",
		});
		const inspection = await sqlite.open(databasePath);
		try {
			expect(
				await inspection.prepare("SELECT id FROM sessions WHERE id = ?").get<{ id: string }>("fork"),
			).toBeUndefined();
			expect(
				await inspection.prepare("SELECT id FROM session_entries WHERE session_id = ?").all<{ id: string }>("fork"),
			).toEqual([]);
		} finally {
			await inspection.close();
		}
	});

	it("materializes active leaf id in sessions transactionally", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const env = new NodeExecutionEnv({ cwd: root });
		const sqlite = createNodeSqliteFactory();
		const repo = new SqliteSessionRepository({ env, sqlite, databasePath });
		const session = await repo.create({ cwd: root, id: "session-1" });
		const rootId = await session.appendMessage(createUserMessage("root"));
		const childId = await session.appendMessage(createAssistantMessage("child"));
		await session.moveTo(rootId);

		const db = await sqlite.open(databasePath);
		try {
			const row = await db
				.prepare("SELECT active_leaf_id FROM sessions WHERE id = ?")
				.get<{ active_leaf_id: string | null }>("session-1");
			expect(row?.active_leaf_id).toBe(rootId);
			const latestBranchRow = await db
				.prepare(
					"SELECT branch_id, entry_id, entry_seq FROM branch_entries WHERE session_id = ? ORDER BY entry_seq DESC LIMIT 1",
				)
				.get<{ branch_id: string; entry_id: string; entry_seq: number }>("session-1");
			const latestSessionEntry = await db
				.prepare("SELECT id, type FROM session_entries WHERE session_id = ? ORDER BY entry_seq DESC LIMIT 1")
				.get<{ id: string; type: string }>("session-1");
			expect(latestSessionEntry?.type).toBe("leaf");
			expect(latestBranchRow?.entry_id).toBe(latestSessionEntry?.id);
			if (!latestBranchRow) throw new Error("Missing latest branch row");
			const branchTip = await db
				.prepare("SELECT branch_id, tip_id FROM branch_tips WHERE session_id = ? AND branch_id = ?")
				.get<{ branch_id: string; tip_id: string }>("session-1", latestBranchRow.branch_id);
			expect(branchTip?.tip_id).toBe(latestSessionEntry?.id);
		} finally {
			await db.close();
		}

		const reopened = await repo.open(await session.getMetadata());
		expect(await reopened.getLeafId()).toBe(rootId);
		expect(childId).not.toBe(rootId);
	});

	it("materializes a new branch when appending from a parent with an existing child", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const env = new NodeExecutionEnv({ cwd: root });
		const sqlite = createNodeSqliteFactory();
		const repo = new SqliteSessionRepository({ env, sqlite, databasePath });
		const session = await repo.create({ cwd: root, id: "session-1" });
		const rootId = await session.appendMessage(createUserMessage("root"));
		const firstChildId = await session.appendMessage(createAssistantMessage("first child"));
		await session.moveTo(rootId);
		const secondChildId = await session.appendMessage(createAssistantMessage("second child"));

		const db = await sqlite.open(databasePath);
		try {
			const branchRows = await db
				.prepare(
					"SELECT branch_id, entry_id, entry_seq FROM branch_entries WHERE session_id = ? ORDER BY branch_id, entry_seq",
				)
				.all<{ branch_id: string; entry_id: string; entry_seq: number }>("session-1");
			const branchIds = [...new Set(branchRows.map((row) => row.branch_id))];
			expect(branchIds).toHaveLength(2);
			expect(branchRows.filter((row) => row.entry_id === rootId)).toHaveLength(2);
			expect(branchRows.filter((row) => row.entry_id === firstChildId)).toHaveLength(1);
			expect(branchRows.filter((row) => row.entry_id === secondChildId)).toHaveLength(1);
			const tips = await db
				.prepare("SELECT branch_id, tip_id FROM branch_tips WHERE session_id = ? ORDER BY branch_id")
				.all<{ branch_id: string; tip_id: string }>("session-1");
			expect(tips.map((tip) => tip.branch_id)).toEqual(branchIds.sort());
			expect(new Set(tips.map((tip) => tip.tip_id)).size).toBe(tips.length);
		} finally {
			await db.close();
		}
	});

	it("reopens using branch materialization and session summary state", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const env = new NodeExecutionEnv({ cwd: root });
		const repo = new SqliteSessionRepository({
			env,
			sqlite: createNodeSqliteFactory(),
			databasePath,
		});
		const session = await repo.create({ cwd: root, id: "session-1" });
		const rootId = await session.appendMessage(createUserMessage("root"));
		await session.appendMessage(createAssistantMessage("first child"));
		await session.appendSessionName("  Reopened Session  ");
		await session.moveTo(rootId);
		await session.appendMessage(createAssistantMessage("branched child"));

		const reopened = await repo.open(await session.getMetadata());
		expect(await reopened.getSessionName()).toBe("Reopened Session");
		expect((await reopened.buildContext()).messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect((await reopened.buildContext()).messages.at(-1)).toMatchObject({
			content: [{ type: "text", text: "branched child" }],
		});
	});

	it("pages entries by entry_seq cursor", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const env = new NodeExecutionEnv({ cwd: root });
		const repo = new SqliteSessionRepository({
			env,
			sqlite: createNodeSqliteFactory(),
			databasePath,
		});
		const session = await repo.create({ cwd: root, id: "session-1" });
		const ids = [
			await session.appendMessage(createUserMessage("one")),
			await session.appendMessage(createAssistantMessage("two")),
			await session.appendMessage(createUserMessage("three")),
		];

		expect((await session.getEntries({ limit: 2 })).map((entry) => entry.id)).toEqual(ids.slice(0, 2));
		expect((await session.getEntries({ afterEntrySeq: 1, limit: 2 })).map((entry) => entry.id)).toEqual(ids.slice(1));
	});

	it("closes the database when create fails after openDatabase succeeds", async () => {
		const root = createTempDir();
		const db = new CountingDatabase((sql) => {
			if (sql.startsWith("INSERT INTO sessions")) {
				return new ThrowingStatement(async () => {
					throw new Error("insert failed");
				});
			}
			return new ThrowingStatement(async () => ({ changes: 1 }));
		});
		const sqlite: SqliteDatabaseFactory = {
			open: async () => db,
		};
		const env = new NodeExecutionEnv({ cwd: root });
		const repo = new SqliteSessionRepository({
			env,
			sqlite,
			databasePath: join(root, "sessions.sqlite"),
		});

		await expect(repo.create({ cwd: root, id: "session-1" })).rejects.toThrow("insert failed");
		expect(db.closeCount).toBe(0);
		await repo[Symbol.asyncDispose]();
		expect(db.closeCount).toBe(1);
	});

	it("closes the database when open fails after openDatabase succeeds", async () => {
		const root = createTempDir();
		const db = new CountingDatabase((sql) => {
			if (sql.includes("FROM sessions WHERE id = ?")) {
				return new ThrowingStatement(async () => ({ changes: 0 }));
			}
			return new ThrowingStatement(async () => ({ changes: 1 }));
		});
		const sqlite: SqliteDatabaseFactory = {
			open: async () => db,
		};
		const env = new NodeExecutionEnv({ cwd: root });
		const repo = new SqliteSessionRepository({
			env,
			sqlite,
			databasePath: join(root, "sessions.sqlite"),
		});
		const metadata: SqliteSessionMetadata = {
			id: "missing",
			createdAt: new Date().toISOString(),
			cwd: root,
			path: join(root, "sessions.sqlite"),
		};
		writeFileSync(metadata.path, "");

		await expect(repo.open(metadata)).rejects.toThrow("Session not found: missing");
		expect(db.closeCount).toBe(0);
		await repo[Symbol.asyncDispose]();
		expect(db.closeCount).toBe(1);
	});

	it("retains one connection for repeated session operations", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const env = new NodeExecutionEnv({ cwd: root });
		const { sqlite, counts } = createCloseCountingSqliteFactory();
		const repo = new SqliteSessionRepository({ env, sqlite, databasePath });

		const session = await repo.create({ cwd: root, id: "session-1" });
		for (let i = 0; i < 10; i++) await session.appendMessage(createUserMessage(`message ${i}`));
		await session.getEntries();
		expect(counts).toEqual({ opens: 1, closes: 0 });
		await repo[Symbol.asyncDispose]();
		expect(counts).toEqual({ opens: 1, closes: 1 });
		await repo[Symbol.asyncDispose]();
		expect(counts).toEqual({ opens: 1, closes: 1 });
	});

	it("shares one connection across source and fork until the repository is disposed", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const env = new NodeExecutionEnv({ cwd: root });
		const { sqlite, counts } = createCloseCountingSqliteFactory();
		const repo = new SqliteSessionRepository({ env, sqlite, databasePath });
		const source = await repo.create({ cwd: root, id: "session-1" });

		const fork = await repo.fork(await source.getMetadata(), {
			cwd: root,
			id: "session-2",
		});
		await fork.appendMessage(createUserMessage("fork"));
		expect(counts).toEqual({ opens: 1, closes: 0 });
		await repo[Symbol.asyncDispose]();
		expect(counts).toEqual({ opens: 1, closes: 1 });
	});

	it("rejects a missing active leaf when opened", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const env = new NodeExecutionEnv({ cwd: root });
		const sqlite = createNodeSqliteFactory();
		const repo = new SqliteSessionRepository({ env, sqlite, databasePath });
		const session = await repo.create({ cwd: root, id: "session-1" });
		const metadata = await session.getMetadata();

		const db = await sqlite.open(databasePath);
		try {
			await db.prepare("UPDATE sessions SET active_leaf_id = ? WHERE id = ?").run("missing", metadata.id);
		} finally {
			await db.close();
		}

		await expect(repo.open(metadata)).rejects.toMatchObject({
			code: "invalid_session",
			message: "Entry missing not found",
		});
	});

	it("fails loudly when a stored entry is read and cannot be decoded", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const env = new NodeExecutionEnv({ cwd: root });
		const sqlite = createNodeSqliteFactory();
		const repo = new SqliteSessionRepository({ env, sqlite, databasePath });
		const session = await repo.create({ cwd: root, id: "session-1" });
		const entryId = await session.appendMessage(createUserMessage("message"));
		const metadata = await session.getMetadata();

		const db = await sqlite.open(databasePath);
		try {
			await db
				.prepare("UPDATE session_entries SET payload = ? WHERE session_id = ? AND id = ?")
				.run("not json", metadata.id, entryId);
		} finally {
			await db.close();
		}

		const reopened = await repo.open(metadata);
		await expect(reopened.getEntries()).rejects.toMatchObject({
			code: "invalid_entry",
		});
	});

	it("does not publish connection state when an append transaction fails", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const sqlite = createNodeSqliteFactory();
		const db = await sqlite.open(databasePath);
		await applyMigrations(db);
		const storage = await SqliteSessionConnection.create(db, databasePath, {
			cwd: root,
			sessionId: "session-1",
		});
		await db.exec(`
			CREATE TEMP TRIGGER fail_branch_tip_insert
			BEFORE INSERT ON branch_tips
			BEGIN
				SELECT RAISE(ABORT, 'branch insert failed');
			END;
		`);

		const rootEntry = {
			type: "message" as const,
			id: "root",
			parentId: null,
			timestamp: new Date().toISOString(),
			message: createUserMessage("root"),
		};
		try {
			await expect(storage.appendEntry(rootEntry)).rejects.toMatchObject({
				code: "storage",
			});
		} finally {
			await db.exec("DROP TRIGGER fail_branch_tip_insert");
		}
		const sessionRow = await db
			.prepare("SELECT active_leaf_id FROM sessions WHERE id = ?")
			.get<{ active_leaf_id: string | null }>("session-1");
		expect(sessionRow?.active_leaf_id).toBeNull();
		expect(await storage.readEntries()).toEqual([]);
		await expect(
			storage.appendEntry({
				type: "leaf",
				id: "leaf",
				parentId: null,
				timestamp: new Date().toISOString(),
				targetId: rootEntry.id,
			}),
		).rejects.toMatchObject({ code: "not_found" });
		expect(await storage.readEntries()).toEqual([]);
		await storage.appendEntry(rootEntry);
		expect(await storage.readEntries()).toEqual([rootEntry]);
		await db.close();
	});

	it("materializes session summary fields transactionally", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const env = new NodeExecutionEnv({ cwd: root });
		const sqlite = createNodeSqliteFactory();
		const repo = new SqliteSessionRepository({ env, sqlite, databasePath });
		const session = await repo.create({ cwd: root, id: "session-1" });
		const userId = await session.appendMessage(createUserMessage("one"));
		await session.appendThinkingLevelChange("high");
		await session.appendModelChange("anthropic", "claude-sonnet-4-5");
		const assistant = {
			...createAssistantMessage("two"),
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 100,
				output: 25,
				cacheRead: 40,
				cacheWrite: 10,
				totalTokens: 175,
				cost: {
					input: 0.1,
					output: 0.2,
					cacheRead: 0.03,
					cacheWrite: 0.04,
					total: 0.37,
				},
			},
		};
		await session.appendMessage(assistant);
		await session.appendCompaction("summary", userId, 200, undefined, false, {
			input: 1,
			output: 2,
			cacheRead: 3,
			cacheWrite: 4,
			totalTokens: 10,
			cost: {
				input: 0.01,
				output: 0.02,
				cacheRead: 0.03,
				cacheWrite: 0.04,
				total: 0.1,
			},
		});
		await session.moveTo(userId, {
			summary: "branch summary",
			usage: {
				input: 5,
				output: 6,
				cacheRead: 7,
				cacheWrite: 8,
				totalTokens: 26,
				cost: {
					input: 0.05,
					output: 0.06,
					cacheRead: 0.07,
					cacheWrite: 0.08,
					total: 0.26,
				},
			},
		});
		await session.appendSessionName("  My Session  ");
		await session.appendLabel(userId, "checkpoint");

		const db = await sqlite.open(databasePath);
		try {
			const row = await db.prepare("SELECT session_id, payload FROM session_materialized WHERE session_id = ?").get<{
				session_id: string;
				payload: string;
			}>("session-1");
			expect(row).toBeDefined();
			expect(row?.session_id).toBe("session-1");
			expect(JSON.parse(row?.payload ?? "null")).toMatchObject({
				name: "My Session",
				messageCount: 2,
				cachedTokens: 50,
				uncachedTokens: 128,
				totalTokens: 211,
				costTotal: 0.73,
				currentModel: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
				currentThinkingLevel: "high",
			});
			const entryRows = await db
				.prepare(
					"SELECT session_id, entry_seq, type, payload FROM entry_materialized WHERE session_id = ? ORDER BY entry_seq, type",
				)
				.all<{
					session_id: string;
					entry_seq: number;
					type: string;
					payload: string;
				}>("session-1");
			expect(
				entryRows.some((entryRow) => entryRow.type === "label" && JSON.parse(entryRow.payload).targetId === userId),
			).toBe(true);
			expect(entryRows.some((entryRow) => entryRow.type === "thinking")).toBe(false);
			expect(entryRows.some((entryRow) => entryRow.type === "model")).toBe(false);
		} finally {
			await db.close();
		}
	});
});
