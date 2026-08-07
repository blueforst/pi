import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { SqliteDatabase } from "./types.ts";

export interface SqliteMigration {
	id: string;
	order: number;
	sql: string;
}

async function loadMigrationSql(relativePath: string): Promise<string> {
	return readFile(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

export async function loadMigrations(): Promise<SqliteMigration[]> {
	return [
		{
			id: "001_initial.sql",
			order: 1,
			sql: await loadMigrationSql("./migrations/001_initial.sql"),
		},
		{
			id: "002_branch_tips.sql",
			order: 2,
			sql: await loadMigrationSql("./migrations/002_branch_tips.sql"),
		},
		{
			id: "003_commit_receipts.sql",
			order: 3,
			sql: await loadMigrationSql("./migrations/003_commit_receipts.sql"),
		},
		{
			id: "004_receipt_seq.sql",
			order: 4,
			sql: await loadMigrationSql("./migrations/004_receipt_seq.sql"),
		},
		{
			id: "005_quarantine.sql",
			order: 5,
			sql: await loadMigrationSql("./migrations/005_quarantine.sql"),
		},
	];
}

function migrationChecksum(sql: string): string {
	return createHash("sha256").update(sql).digest("hex");
}

async function ensureMigrationsTable(db: SqliteDatabase): Promise<void> {
	await db.exec(`
CREATE TABLE IF NOT EXISTS migrations (
	id TEXT PRIMARY KEY,
	applied_at TEXT NOT NULL,
	checksum TEXT NOT NULL DEFAULT ''
);
`);
	// Legacy databases created before the checksum column: add it in place.
	const columns = await db.prepare("PRAGMA table_info(migrations)").all<{ name: string }>();
	if (!columns.some((column) => column.name === "checksum")) {
		await db.exec("ALTER TABLE migrations ADD COLUMN checksum TEXT NOT NULL DEFAULT ''");
	}
}

/**
 * Applies pending migrations in order. Each migration is recorded with a
 * sha256 checksum of its SQL; a migration whose on-disk SQL differs from the
 * recorded checksum (a released migration edited in place) fails closed —
 * silently re-running or skipping a changed migration would corrupt the
 * schema. Empty checksums on legacy rows are backfilled on first sight.
 */
export async function applyMigrations(db: SqliteDatabase): Promise<void> {
	await ensureMigrationsTable(db);
	const migrations = await loadMigrations();
	const appliedRows = await db
		.prepare("SELECT id, checksum FROM migrations ORDER BY applied_at, id")
		.all<{ id: string; checksum: string }>();
	const applied = new Map(appliedRows.map((row) => [row.id, row.checksum]));

	for (const migration of migrations) {
		const existingChecksum = applied.get(migration.id);
		const checksum = migrationChecksum(migration.sql);
		if (existingChecksum !== undefined) {
			if (existingChecksum !== "" && existingChecksum !== checksum) {
				throw new Error(
					`migration ${migration.id} checksum mismatch: the released SQL changed after it was applied ` +
						`(recorded ${existingChecksum}, current ${checksum}); refusing to proceed (fail closed)`,
				);
			}
			if (existingChecksum === "") {
				await db.prepare("UPDATE migrations SET checksum = ? WHERE id = ?").run(checksum, migration.id);
			}
			continue;
		}
		await db.transaction(async () => {
			await db.exec(migration.sql);
			await db
				.prepare("INSERT INTO migrations (id, applied_at, checksum) VALUES (?, ?, ?)")
				.run(migration.id, new Date().toISOString(), checksum);
		});
		applied.set(migration.id, checksum);
	}
}
