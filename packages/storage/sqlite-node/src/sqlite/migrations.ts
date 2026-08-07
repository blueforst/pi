import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { SqliteDatabase } from "./types.ts";

export interface SqliteMigration {
	id: string;
	order: number;
	sql: string;
}

/**
 * iris_agent#67/#78: release-owned checksum manifest entry. The manifest is a
 * checked-in JSON file (`./migrations/release-manifest.json`) whose array
 * order IS the release order of the migrations. It is the SINGLE source of
 * expected checksums, shared by the runtime (this module), the release
 * verification gate (`scripts/check-iris-fork-baseline.mjs`) and CI.
 */
export interface ReleasedMigrationChecksum {
	id: string;
	sha256: string;
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

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/**
 * iris_agent#67: load the release-owned migration manifest.
 *
 * Every RELEASED migration must have its immutable expected sha256 pinned in
 * the manifest, INDEPENDENT of the mutable `migrations` row and of whatever
 * SQL currently ships in the checkout. A legacy database whose
 * `migrations.checksum` rows are empty (pre-checksum era) is only allowed to
 * backfill a checksum when the packaged SQL matches this manifest — never by
 * blessing the current file's hash as the historical checksum (that would
 * let an edited, already-applied legacy migration pass its first
 * checksum-enabled upgrade undetected).
 *
 * A migration NOT listed here is not yet released; at release time it must
 * gain a manifest entry (CI and the provenance gate enforce the packaged set
 * to match the manifest exactly).
 *
 * Malformed manifests fail closed: startup must never proceed against an
 * unverifiable checksum trust root.
 */
export async function loadReleaseManifest(): Promise<ReleasedMigrationChecksum[]> {
	const raw = await readFile(fileURLToPath(new URL("./migrations/release-manifest.json", import.meta.url)), "utf8");
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(
			`release migration manifest is not valid JSON; refusing to proceed (fail closed): ${String(error)}`,
		);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("release migration manifest must be a JSON object; refusing to proceed (fail closed)");
	}
	const record = parsed as { schemaVersion?: unknown; migrations?: unknown };
	if (record.schemaVersion !== 1) {
		throw new Error(
			`release migration manifest schemaVersion must be 1, got ${JSON.stringify(record.schemaVersion)}; ` +
				"refusing to proceed (fail closed)",
		);
	}
	if (!Array.isArray(record.migrations)) {
		throw new Error("release migration manifest must contain a migrations array; refusing to proceed (fail closed)");
	}
	const released: ReleasedMigrationChecksum[] = [];
	const seen = new Set<string>();
	for (const [index, entry] of record.migrations.entries()) {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
			throw new Error(
				`release migration manifest migrations[${index}] must be an object; refusing to proceed (fail closed)`,
			);
		}
		const { id, sha256 } = entry as { id?: unknown; sha256?: unknown };
		if (typeof id !== "string" || id.length === 0) {
			throw new Error(
				`release migration manifest migrations[${index}].id must be a non-empty string; refusing to proceed (fail closed)`,
			);
		}
		if (typeof sha256 !== "string" || !SHA256_PATTERN.test(sha256)) {
			throw new Error(
				`release migration manifest migrations[${index}].sha256 must be a 64-character lowercase hex sha256; ` +
					"refusing to proceed (fail closed)",
			);
		}
		if (seen.has(id)) {
			throw new Error(`release migration manifest lists ${id} more than once; refusing to proceed (fail closed)`);
		}
		seen.add(id);
		released.push({ id, sha256 });
	}
	return released;
}

/**
 * iris_agent#78: the packaged migration set must be release-consistent with
 * the release-owned manifest BEFORE anything touches the database.
 *
 * - every released migration listed in the manifest must be present in the
 *   packaged set (a released migration file deleted from the package must
 *   fail closed instead of silently applying a partial schema);
 * - the relative order of released migrations in the packaged set must match
 *   the manifest order (a reordered package would silently apply a different
 *   sequence on a fresh database);
 * - a migration that is NOT in the manifest (not yet released) may only be
 *   appended AFTER the last released migration, so it can never be
 *   interleaved between released migrations.
 */
function assertReleaseManifestConsistency(migrations: SqliteMigration[], released: ReleasedMigrationChecksum[]): void {
	const manifestIndex = new Map(released.map((entry, index) => [entry.id, index]));
	const packagedPositions = new Map(migrations.map((migration, index) => [migration.id, index]));
	let nextManifestIndex = 0;
	let seenLastReleasedMigration = false;
	for (const [packagedIndex, migration] of migrations.entries()) {
		const index = manifestIndex.get(migration.id);
		if (index === undefined) {
			if (!seenLastReleasedMigration) {
				throw new Error(
					`packaged migration ${migration.id} has no release-owned manifest entry and is interleaved ` +
						`with released migrations at position ${packagedIndex}; new migrations must be appended after ` +
						"all released migrations (fail closed)",
				);
			}
			continue;
		}
		if (index !== nextManifestIndex) {
			const skipped = released[nextManifestIndex];
			const skippedPosition = packagedPositions.get(skipped.id);
			if (skippedPosition !== undefined && skippedPosition > packagedIndex) {
				throw new Error(
					`packaged migration set is out of release order: ${migration.id} appears before released ` +
						`migration ${skipped.id}; reordered migrations would silently apply a different sequence (fail closed)`,
				);
			}
			const missing = released
				.slice(nextManifestIndex, index)
				.map((entry) => entry.id)
				.join(", ");
			throw new Error(
				`released migration(s) ${missing} are missing from the packaged migration set; ` +
					"refusing to apply a partial release (fail closed)",
			);
		}
		nextManifestIndex += 1;
		if (nextManifestIndex === released.length) {
			seenLastReleasedMigration = true;
		}
	}
	if (nextManifestIndex < released.length) {
		const missing = released
			.slice(nextManifestIndex)
			.map((entry) => entry.id)
			.join(", ");
		throw new Error(
			`released migration(s) ${missing} are missing from the packaged migration set; ` +
				"refusing to apply a partial release (fail closed)",
		);
	}
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
 * packaged SQL matches the release-owned manifest (a checked-in JSON file,
 * never the current file's hash). An applied migration absent from the
 * manifest fails closed (unknown released migration); a packaged SQL that
 * differs from the manifest's pinned historical checksum fails closed
 * (edited legacy migration before first checksum backfill).
 *
 * iris_agent#78: the packaged migration set is validated against the
 * manifest BEFORE any database mutation (no partial migration, no backfill,
 * not even the migrations table bootstrap) — missing released files,
 * reordered sets and interleaved unreleased migrations all fail closed.
 */
export async function applyMigrations(
	db: SqliteDatabase,
	options: { migrations?: SqliteMigration[]; releaseManifest?: ReleasedMigrationChecksum[] } = {},
): Promise<void> {
	const migrations = options.migrations ?? (await loadMigrations());
	const released = options.releaseManifest ?? (await loadReleaseManifest());
	assertReleaseManifestConsistency(migrations, released);
	const manifestChecksums = new Map(released.map((entry) => [entry.id, entry.sha256]));

	await ensureMigrationsTable(db);
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
				const releasedChecksum = manifestChecksums.get(migration.id);
				if (releasedChecksum === undefined) {
					throw new Error(
						`migration ${migration.id} has no release-owned manifest checksum; ` +
							"refusing to backfill a checksum for an unknown released migration (fail closed)",
					);
				}
				if (releasedChecksum !== checksum) {
					throw new Error(
						`migration ${migration.id} packaged SQL does not match its release-owned manifest checksum ` +
							`(manifest ${releasedChecksum}, current ${checksum}); the applied legacy migration may have been ` +
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
