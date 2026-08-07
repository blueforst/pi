// Tests for the migration release-manifest gate added to
// check-iris-fork-baseline.mjs (iris_agent#78).
//
// All fixtures live in temporary directories; the real manifest and packaged
// migration files are only read by the final integration test.

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkMigrationReleaseManifest, validateReleaseManifest } from "./check-iris-fork-baseline.mjs";

const fixtureDirs = [];
process.on("exit", () => {
	for (const dir of fixtureDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function makeFixture() {
	const dir = mkdtempSync(join(tmpdir(), "iris-migration-manifest-"));
	fixtureDirs.push(dir);
	return dir;
}

function sha256(text) {
	return createHash("sha256").update(text).digest("hex");
}

function writeMigration(dir, name, sql) {
	writeFileSync(join(dir, name), sql);
}

function validManifest(migrations = [
	{ id: "001_initial.sql", sha256: sha256("CREATE TABLE one (id INTEGER);\n") },
	{ id: "002_branch_tips.sql", sha256: sha256("CREATE TABLE two (id INTEGER);\n") },
]) {
	return { schemaVersion: 1, migrations };
}

test("iris_agent#78: accepts a release manifest that matches the packaged migration files", () => {
	const dir = makeFixture();
	writeMigration(dir, "001_initial.sql", "CREATE TABLE one (id INTEGER);\n");
	writeMigration(dir, "002_branch_tips.sql", "CREATE TABLE two (id INTEGER);\n");
	const manifestPath = join(dir, "release-manifest.json");
	writeFileSync(manifestPath, JSON.stringify(validManifest(), null, "	"));
	const result = checkMigrationReleaseManifest(manifestPath, dir);
	assert.deepEqual(result, { ok: true, errors: [] });
});

test("iris_agent#78: a released migration missing from the packaged files fails closed", () => {
	const dir = makeFixture();
	writeMigration(dir, "001_initial.sql", "CREATE TABLE one (id INTEGER);\n");
	const manifestPath = join(dir, "release-manifest.json");
	writeFileSync(manifestPath, JSON.stringify(validManifest(), null, "\t"));
	const result = checkMigrationReleaseManifest(manifestPath, dir);
	assert.equal(result.ok, false);
	assert.match(result.errors.join("\n"), /packaged migration files do not match the manifest entries/);
	assert.match(result.errors.join("\n"), /002_branch_tips\.sql/);
});

test("iris_agent#78: a packaged migration without a manifest entry fails closed", () => {
	const dir = makeFixture();
	writeMigration(dir, "001_initial.sql", "CREATE TABLE one (id INTEGER);\n");
	writeMigration(dir, "002_branch_tips.sql", "CREATE TABLE two (id INTEGER);\n");
	writeMigration(dir, "003_unknown.sql", "CREATE TABLE three (id INTEGER);\n");
	const manifestPath = join(dir, "release-manifest.json");
	writeFileSync(manifestPath, JSON.stringify(validManifest(), null, "\t"));
	const result = checkMigrationReleaseManifest(manifestPath, dir);
	assert.equal(result.ok, false);
	assert.match(result.errors.join("\n"), /packaged migration files do not match the manifest entries/);
	assert.match(result.errors.join("\n"), /003_unknown\.sql/);
});

test("iris_agent#78: a reordered manifest/packaged pair fails closed", () => {
	const dir = makeFixture();
	writeMigration(dir, "001_initial.sql", "CREATE TABLE one (id INTEGER);\n");
	writeMigration(dir, "002_branch_tips.sql", "CREATE TABLE two (id INTEGER);\n");
	const manifestPath = join(dir, "release-manifest.json");
	// Manifest order reversed relative to the packaged files: a fresh
	// database would silently apply a different sequence.
	writeFileSync(
		manifestPath,
		JSON.stringify(
			validManifest([
				{ id: "002_branch_tips.sql", sha256: sha256("CREATE TABLE two (id INTEGER);\n") },
				{ id: "001_initial.sql", sha256: sha256("CREATE TABLE one (id INTEGER);\n") },
			]),
			null,
			"\t",
		),
	);
	const result = checkMigrationReleaseManifest(manifestPath, dir);
	assert.equal(result.ok, false);
	assert.match(result.errors.join("\n"), /packaged migration files do not match the manifest entries/);
});

test("iris_agent#78: an edited packaged migration whose sha256 no longer matches the manifest fails closed", () => {
	const dir = makeFixture();
	writeMigration(dir, "001_initial.sql", "CREATE TABLE one (id INTEGER);\n");
	// 002 edited in place: pinned checksum no longer matches file content.
	writeMigration(dir, "002_branch_tips.sql", "CREATE TABLE two (id INTEGER); -- edited\n");
	const manifestPath = join(dir, "release-manifest.json");
	writeFileSync(manifestPath, JSON.stringify(validManifest(), null, "\t"));
	const result = checkMigrationReleaseManifest(manifestPath, dir);
	assert.equal(result.ok, false);
	assert.match(result.errors.join("\n"), /does not match its release-owned manifest checksum/);
	assert.match(result.errors.join("\n"), /002_branch_tips\.sql/);
});

test("iris_agent#78: validateReleaseManifest rejects an unsupported schema version", () => {
	const errors = validateReleaseManifest({ schemaVersion: 2, migrations: [] });
	assert.match(errors.join("\n"), /schemaVersion/);
});

test("iris_agent#78: validateReleaseManifest rejects duplicate migration ids", () => {
	const errors = validateReleaseManifest(
		validManifest([
			{ id: "001_initial.sql", sha256: sha256("a") },
			{ id: "001_initial.sql", sha256: sha256("b") },
		]),
	);
	assert.match(errors.join("\n"), /duplicate migration id/);
});

test("iris_agent#78: validateReleaseManifest rejects a malformed sha256", () => {
	const errors = validateReleaseManifest(
		validManifest([{ id: "001_initial.sql", sha256: "not-a-sha" }]),
	);
	assert.match(errors.join("\n"), /sha256/);
});

test("iris_agent#78: validateReleaseManifest rejects a non-array migrations field", () => {
	const errors = validateReleaseManifest({ schemaVersion: 1, migrations: "nope" });
	assert.match(errors.join("\n"), /migrations: expected an array/);
});

test("iris_agent#78: the checked-in release manifest matches the packaged migration files (integration)", () => {
	// Default paths resolve to the real repository files.
	const result = checkMigrationReleaseManifest();
	assert.deepEqual(result, { ok: true, errors: [] });
});
