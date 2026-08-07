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

/**
 * iris_agent#67: release-owned checksum manifest. Every RELEASED migration
 * must have its immutable expected sha256 pinned here as a code constant,
 * INDEPENDENT of the mutable migration row and of whatever SQL currently
 * ships in the checkout. A legacy database whose `migrations.checksum` rows
 * are empty (pre-checksum era) is only allowed to backfill a checksum when
 * the packaged SQL matches this manifest — never by blessing the current
 * file's hash as the historical checksum (that would let an edited,
 * already-applied legacy migration pass its first checksum-enabled upgrade
 * undetected).
 *
 * A migration NOT listed here is either (a) not yet released (first-ever
 * application records its checksum normally) or (b) an UNKNOWN applied
 * migration — which fails closed (see applyMigrations).
 */
const RELEASED_MIGRATION_CHECKSUMS: Readonly<Record<string, string>> = {
	"001_initial.sql": "1403e1773e891adddb6099d7db41290e645cb337dbccae23724fb67f3ceafece",
	"002_branch_tips.sql": "a1e284e7ab152c452ffbcd4764cbb2e88f9e041f17aa4f483e67c7d1705a4f5f",
	"003_commit_receipts.sql": "1353d95756dc8fbd246fb14e12bc68f0cb01eb1b8b7957f87738bd586f328777",
	"004_receipt_seq.sql": "fc9629fed3ae827e33bbca7bd4047fba132cd0ddc765e2f6297d5cfc1d35f1c2",
	"005_quarantine.sql": "04317c1b502d3c730bd76c01768f8c89c1b3c872575a325fe71ac16e7d55870f",
};

/** iris_agent#67: expose the manifest for release-verification gates. */
export function releasedMigrationChecksums(): Readonly<Record<string, string>> {
	return { ...RELEASED_MIGRATION_CHECKSUMS };
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
 * schema.
 *
 * iris_agent#67: empty checksums on legacy rows are backfilled ONLY when the
 * packaged SQL matches the release-owned manifest (a code constant, not the
 * current file's hash). An applied migration absent from the manifest fails
 * closed (unknown released migration); a packaged SQL that differs from the
 * manifest's pinned historical checksum fails closed (edited legacy
 * migration before first checksum backfill).
 */
export async function applyMigrations(
	db: SqliteDatabase,
	options: { migrations?: SqliteMigration[] } = {},
): Promise<void> {
	await ensureMigrationsTable(db);
	const migrations = options.migrations ?? (await loadMigrations());
	const appliedRows = await db
		.prepare("SELECT id, checksum FROM migrations ORDER BY applied_at, id")
		.all<{ id: string; checksum: string }>();
	const applied = new Map(appliedRows.map((row) => [row.id, row.checksum]));

	// iris_agent#67: an applied migration id that is NOT part of this
	// release's packaged migrations means the database schema is NEWER than
	// this checkout (or a foreign/unknown migration was recorded). Failing
	// closed beats silently running an older release against a newer schema.
	const packagedIds = new Set(migrations.map((migration) => migration.id));
	for (const id of applied.keys()) {
		if (!packagedIds.has(id)) {
			throw new Error(
				`migration ${id} is applied but not part of this release's packaged migrations; ` +
					"the database schema may be newer than this checkout; refusing to proceed (fail closed)",
			);
		}
	}

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
				// iris_agent#67: legacy row from the pre-checksum era. The
				// packaged SQL is only trustworthy as the HISTORICAL checksum
				// when it matches the release-owned manifest.
				const released = RELEASED_MIGRATION_CHECKSUMS[migration.id];
				if (released === undefined) {
					throw new Error(
						`migration ${migration.id} has no release-owned manifest checksum; ` +
							"refusing to backfill a checksum for an unknown released migration (fail closed)",
					);
				}
				if (released !== checksum) {
					throw new Error(
						`migration ${migration.id} packaged SQL does not match its release-owned manifest checksum ` +
							`(manifest ${released}, current ${checksum}); the applied legacy migration may have been ` +
							"edited before its first checksum backfill; refusing to proceed (fail closed)",
					);
				}
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
