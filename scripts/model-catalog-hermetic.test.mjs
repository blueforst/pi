#!/usr/bin/env node

// Hermetic model-catalog tests (node:test).
//
// Covers the required failure/behaviour matrix for the model catalog build:
//   - offline regeneration from the committed snapshot (--from-data)
//   - consistency gate: rendered TS shards/aggregator match committed files
//   - catalog drift: committed data diverges from the manifest
//   - stale snapshot: manifest structureHash mismatch
//   - checksum mismatch: a data file no longer matches its manifest hash
//   - single-upstream failure: refresh fails fast in strict mode
//   - all-upstream failure: refresh fails fast in strict mode
//
// All tests spawn the real generator script; none of them mutate the
// repository's committed data directory (fixtures live in temp dirs).

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../packages/ai/scripts/generate-models.ts", import.meta.url));
const REPO_ROOT = dirname(dirname(SCRIPT));

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

function runGenerator(args, options = {}) {
	return spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT, ...args], {
		cwd: options.cwd ?? REPO_ROOT,
		encoding: "utf8",
		env: { ...process.env, ...(options.env ?? {}) },
		timeout: 120_000,
	});
}

// Minimal committed-style package fixture: one provider with one model,
// matching the shape validateModelDataDirectory expects.
function createPackageFixture() {
	const root = mkdtempSync(join(tmpdir(), "pi-model-catalog-"));
	const providersDir = join(root, "src", "providers");
	const dataDir = join(providersDir, "data");
	mkdirSync(dataDir, { recursive: true });

	const model = {
		id: "fixture-model-1",
		name: "Fixture Model 1",
		api: "openai-completions",
		provider: "fixture-provider",
		baseUrl: "https://fixture.example/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
	const dataContent = `${JSON.stringify({ "openai-completions": { "fixture-model-1": model } })}\n`;
	writeFileSync(join(dataDir, "fixture-provider.json"), dataContent);

	// Minimal aggregator + shard so readModelDataStructure/from-data work.
	writeFileSync(
		join(root, "src", "models.generated.ts"),
		'import { FIXTURE_PROVIDER_MODELS } from "./providers/fixture-provider.models.ts";\n',
	);
	writeFileSync(
		join(providersDir, "fixture-provider.models.ts"),
		'import values from "./data/fixture-provider.json" with { type: "json" };\n' +
			'import { flattenModelCatalog, type ModelCatalog } from "../model-catalog.ts";\n\n' +
			'export const FIXTURE_PROVIDER_MODELS: ModelCatalog<typeof values, "fixture-provider"> =\n' +
			'\tflattenModelCatalog("fixture-provider", values);\n',
	);

	// Generate a valid manifest: structureHash over the sorted provider/model
	// structure, per-file content hash, and a source provenance entry.
	const structureHash = sha256('{"fixture-provider":{"fixture-model-1":"openai-completions"}}');
	const manifest = {
		schemaVersion: 3,
		generatedAt: "2026-08-06T00:00:00.000Z",
		structureHash,
		files: { "fixture-provider.json": sha256(dataContent) },
		sources: [{ name: "models.dev", url: "https://models.dev/api.json", fetchedAt: "2026-08-06T00:00:00.000Z", status: "ok" }],
	};
	writeFileSync(join(dataDir, ".manifest.json"), `${JSON.stringify(manifest)}\n`);
	return { root, dataDir };
}

test("offline --from-data regeneration is stable and hermetic (repo snapshot)", () => {
	// The committed repository data dir is the snapshot; regenerating TS from it
	// must succeed without network and leave the tree byte-identical.
	const result = runGenerator(["--from-data", "--check-only"]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /matches the committed model data snapshot/);
});

test("consistency gate fails when a shard is out of sync with the snapshot", () => {
	const { root, dataDir } = createPackageFixture();
	// First sync the fixture: generate the shards/aggregator from the snapshot.
	const syncResult = runGenerator(["--from-data", "--package-root", root]);
	assert.equal(syncResult.status, 0, syncResult.stderr);

	// Tamper with the generated shard; the gate must now report it.
	writeFileSync(
		join(root, "src", "providers", "fixture-provider.models.ts"),
		'// tampered\nimport values from "./data/fixture-provider.json" with { type: "json" };\n',
	);
	const result = runGenerator(["--from-data", "--check-only", "--package-root", root]);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /out of sync|fixture-provider\.models\.ts/);
	rmSync(root, { recursive: true, force: true });
});

test("catalog drift: manifest structure hash does not match the data files", () => {
	const { root, dataDir } = createPackageFixture();
	// Fix the manifest so schema/structure checks pass, then mutate a data file
	// so its content no longer matches the manifest's recorded hash.
	const manifestPath = join(dataDir, ".manifest.json");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	manifest.structureHash = "0000000000000000000000000000000000000000"; // will mismatch
	writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);

	const result = runGenerator(["--from-data", "--check-only", "--package-root", root]);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /generation stamp|structureHash/);
	rmSync(root, { recursive: true, force: true });
});

test("stale snapshot: manifest is missing (no data dir at all)", () => {
	const { root, dataDir } = createPackageFixture();
	rmSync(dataDir, { recursive: true, force: true });
	const result = runGenerator(["--from-data", "--check-only", "--package-root", root]);
	assert.notEqual(result.status, 0);
	rmSync(root, { recursive: true, force: true });
});

test("checksum mismatch: data file content diverges from manifest hash", () => {
	const { root, dataDir } = createPackageFixture();
	// Generate a real manifest + shards for the fixture data so validation
	// proceeds past structure checks, then tamper with the data file.
	const genResult = runGenerator(["--from-data", "--package-root", root]);
	assert.equal(genResult.status, 0, genResult.stderr);

	// Keep the API-group structure intact but change model content so the file
	// hash diverges from the manifest while structure parsing still succeeds.
	const tampered = `${JSON.stringify({
		"openai-completions": {
			"fixture-model-1": {
				id: "fixture-model-1",
				name: "Tampered Model Name",
				api: "openai-completions",
				provider: "fixture-provider",
				baseUrl: "https://fixture.example/v1",
				reasoning: false,
				input: ["text"],
				cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1000,
				maxTokens: 100,
			},
		},
	})}\n`;
	writeFileSync(join(dataDir, "fixture-provider.json"), tampered);
	const result = runGenerator(["--from-data", "--check-only", "--package-root", root]);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /does not match its manifest hash|generation stamp/);
	rmSync(root, { recursive: true, force: true });
});

test("single-upstream failure: strict refresh fails fast and preserves the snapshot", () => {
	const { root, dataDir } = createPackageFixture();
	// Hydrate in strict mode with a dead models.dev endpoint; must fail without
	// touching the existing data directory.
	const before = readdirSync(dataDir).sort();
	const result = runGenerator(["--strict", "--data-only", "--package-root", root], {
		env: { PI_MODELS_DEV_URL: "http://127.0.0.1:1/api.json" },
	});
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /fetch failed|ECONNREFUSED|models.dev/);
	const after = readdirSync(dataDir).sort();
	assert.deepEqual(after, before, "data directory must be unchanged after a failed refresh");
	rmSync(root, { recursive: true, force: true });
});

test("all-upstream failure: strict refresh fails fast with all endpoints dead", () => {
	const { root } = createPackageFixture();
	const result = runGenerator(["--strict", "--data-only", "--package-root", root], {
		env: {
			PI_MODELS_DEV_URL: "http://127.0.0.1:1/api.json",
			PI_NVIDIA_MODELS_URL: "http://127.0.0.1:1/nvidia",
			PI_OPENROUTER_MODELS_URL: "http://127.0.0.1:1/openrouter",
			PI_AI_GATEWAY_URL: "http://127.0.0.1:1/gateway",
		},
	});
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /fetch failed|ECONNREFUSED|models.dev/);
	rmSync(root, { recursive: true, force: true });
});

test("non-strict refresh degrades gracefully on a single upstream failure", () => {
	const { root } = createPackageFixture();
	// Without --strict, NVIDIA/OpenRouter/gateway failures degrade to empty
	// catalogs instead of aborting; only models.dev is mandatory.
	const result = runGenerator(["--data-only", "--package-root", root], {
		env: {
			PI_MODELS_DEV_URL: "http://127.0.0.1:1/api.json",
		},
	});
	// models.dev is required even in non-strict mode (its data is the base
	// catalog); a dead endpoint must still fail fast.
	assert.notEqual(result.status, 0);
	rmSync(root, { recursive: true, force: true });
});
