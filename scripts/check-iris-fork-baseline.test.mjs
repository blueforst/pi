// Tests for check-iris-fork-baseline.mjs.
//
// All fixtures are written to temporary directories; the real manifests in
// docs/iris-fork/ are only read by the default-path integration test and are
// never modified.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const SCRIPT = fileURLToPath(new URL("./check-iris-fork-baseline.mjs", import.meta.url));
const REPO_ROOT = dirname(dirname(SCRIPT));

const SHA_FORK = "ab5f8d88ee1d400c0c8fb5c50ac10b2f4a4851d1";
const SHA_UPSTREAM = "e741cb05ca7c1c7bc5a9664c99697df32de9fac6";
const SHA_ACCEPTED = "fa7aba0a5240ead1679dced5a5e12a0fe7df2800";
const SHA_ACCEPTED_TREE = "1b43382f421da75ee20a78d3bf2ef4342e776bf6";

function validLock() {
	return {
		schemaVersion: 2,
		fork: {
			repository: "blueforst/pi",
			defaultBranch: "main",
			baselineCommit: SHA_FORK,
		},
		acceptedRuntime: {
			repository: "blueforst/pi",
			commit: SHA_ACCEPTED,
			tree: SHA_ACCEPTED_TREE,
			verifiedAt: "2026-08-05",
		},
		upstream: {
			repository: "earendil-works/pi",
			baseCommit: SHA_UPSTREAM,
			verifiedAt: "2026-08-04",
		},
		runtime: {
			node: ">=22.19.0",
			packageManager: "npm",
			lockfile: "package-lock.json",
		},
		distribution: {
			packageIdentityStatus: "inherits_upstream_package_names",
			publishStatus: "not_published",
		},
		dependencyDirection: "upstream_only",
		sync: {
			strategy: "manual_review_gate",
			lastVerifiedUpstreamCommit: SHA_UPSTREAM,
			lastVerifiedAt: "2026-08-04",
		},
	};
}

function validPatches() {
	return {
		schemaVersion: 2,
		upstreamBaseCommit: SHA_UPSTREAM,
		patches: [],
	};
}

function samplePatch() {
	return {
		id: "iris-r0-p0-test-patch",
		title: "Sample carried patch",
		status: "carried",
		genericRuntimeRationale: "Required for the generic runtime substrate.",
		affectedPackages: ["packages/agent"],
		affectedSurfaces: ["runtime startup"],
		tests: ["node --test test/startup.test.mjs"],
		upstream: { issue: 123, pullRequest: null, status: "filed" },
		firstForkCommit: SHA_FORK,
		latestForkCommit: SHA_FORK,
		removalCondition: "Adopted upstream in a reviewed release.",
		compatibilityRisk: "low",
		notes: "",
	};
}

const fixtureDirs = [];

test.after(() => {
	for (const dir of fixtureDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function runCli(lock, patches) {
	const dir = mkdtempSync(join(tmpdir(), "iris-fork-baseline-"));
	fixtureDirs.push(dir);
	const lockPath = join(dir, "production-lock.json");
	const patchesPath = join(dir, "carried-patches.json");
	writeFileSync(lockPath, JSON.stringify(lock, null, "\t"));
	writeFileSync(patchesPath, JSON.stringify(patches, null, "\t"));
	const result = spawnSync(process.execPath, [SCRIPT, lockPath, patchesPath], { encoding: "utf8" });
	return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

// Fails with exit code 1, a field-level error matching `pattern`, and no
// raw TypeError/stack trace leaking from the validator.
function assertFailsWithFieldError(result, pattern) {
	assert.equal(result.status, 1);
	assert.match(result.stderr, pattern);
	assert.doesNotMatch(result.stderr, /TypeError|\n\s+at /);
}

test("accepts valid empty manifests", () => {
	const { status, stdout, stderr } = runCli(validLock(), validPatches());
	assert.equal(status, 0);
	assert.match(stdout, /OK: iris fork baseline manifests are valid/);
	assert.equal(stderr, "");
});

test("accepts carried patch with valid commit ids", () => {
	const patches = validPatches();
	patches.patches.push(samplePatch());
	const { status, stdout } = runCli(validLock(), patches);
	assert.equal(status, 0);
	assert.match(stdout, /OK/);
});

test("rejects missing required field", () => {
	const lock = validLock();
	delete lock.sync.strategy;
	const { status, stderr } = runCli(lock, validPatches());
	assert.equal(status, 1);
	assert.match(stderr, /missing required field: sync\.strategy/);
});

test("rejects placeholder values", () => {
	const patches = validPatches();
	const patch = samplePatch();
	patch.title = "TBD: still in design";
	patches.patches.push(patch);
	const { status, stderr } = runCli(validLock(), patches);
	assert.equal(status, 1);
	assert.match(stderr, /placeholder value not allowed/);
});

test("rejects lowercase placeholder variants", () => {
	const patches = validPatches();
	const patch = samplePatch();
	patch.notes = "todo: decide later";
	patches.patches.push(patch);
	const { status, stderr } = runCli(validLock(), patches);
	assert.equal(status, 1);
	assert.match(stderr, /placeholder value not allowed/);
});

test("rejects malformed SHA", () => {
	const lock = validLock();
	lock.fork.baselineCommit = "abc123";
	const { status, stderr } = runCli(lock, validPatches());
	assert.equal(status, 1);
	assert.match(stderr, /fork\.baselineCommit: expected full 40-character hex commit SHA/);
});

test("rejects zero SHA", () => {
	const lock = validLock();
	lock.upstream.baseCommit = "0".repeat(40);
	const { status, stderr } = runCli(lock, validPatches());
	assert.equal(status, 1);
	assert.match(stderr, /upstream\.baseCommit: zero SHA is not a valid baseline/);
});

test("rejects duplicate patch ids", () => {
	const patches = validPatches();
	patches.patches.push(samplePatch());
	const duplicate = samplePatch();
	duplicate.title = "Duplicate id";
	patches.patches.push(duplicate);
	const { status, stderr } = runCli(validLock(), patches);
	assert.equal(status, 1);
	assert.match(stderr, /duplicate patch id/);
});

test("rejects patch without tests", () => {
	const patches = validPatches();
	const patch = samplePatch();
	patch.tests = [];
	patches.patches.push(patch);
	const { status, stderr } = runCli(validLock(), patches);
	assert.equal(status, 1);
	assert.match(stderr, /tests: expected non-empty array/);
});

test("rejects patch without removal condition", () => {
	const patches = validPatches();
	const patch = samplePatch();
	delete patch.removalCondition;
	patches.patches.push(patch);
	const { status, stderr } = runCli(validLock(), patches);
	assert.equal(status, 1);
	assert.match(stderr, /missing required field: removalCondition/);
});

test("rejects invalid dependency direction", () => {
	const lock = validLock();
	lock.dependencyDirection = "agent_depends_on_pi";
	const { status, stderr } = runCli(lock, validPatches());
	assert.equal(status, 1);
	assert.match(stderr, /dependencyDirection: unsupported value/);
});

test("rejects upstream base mismatch", () => {
	const patches = validPatches();
	patches.upstreamBaseCommit = "f".repeat(40);
	const { status, stderr } = runCli(validLock(), patches);
	assert.equal(status, 1);
	assert.match(stderr, /does not match/);
});

test("rejects unsupported schema version", () => {
	const lock = validLock();
	lock.schemaVersion = 3;
	const { status, stderr } = runCli(lock, validPatches());
	assert.equal(status, 1);
	assert.match(stderr, /schemaVersion: unsupported value/);
});

test("rejects schema v1 without acceptedRuntime", () => {
	const lock = validLock();
	delete lock.acceptedRuntime;
	const { status, stderr } = runCli(lock, validPatches());
	assert.equal(status, 1);
	assert.match(stderr, /missing required field: acceptedRuntime\.repository/);
});

test("rejects acceptedRuntime commit equal to fork baseline", () => {
	const lock = validLock();
	lock.acceptedRuntime.commit = SHA_FORK;
	const { status, stderr } = runCli(lock, validPatches());
	assert.equal(status, 1);
	assert.match(stderr, /acceptedRuntime\.commit must differ from fork\.baselineCommit/);
});

test("rejects acceptedRuntime wrong repository", () => {
	const lock = validLock();
	lock.acceptedRuntime.repository = "someone-else/pi";
	const { status, stderr } = runCli(lock, validPatches());
	assert.equal(status, 1);
	assert.match(stderr, /acceptedRuntime\.repository: expected blueforst\/pi/);
});

test("rejects acceptedRuntime malformed tree", () => {
	const lock = validLock();
	lock.acceptedRuntime.tree = "short";
	const { status, stderr } = runCli(lock, validPatches());
	assert.equal(status, 1);
	assert.match(stderr, /acceptedRuntime\.tree: expected full 40-character hex commit SHA/);
});

test("rejects acceptedRuntime zero tree", () => {
	const lock = validLock();
	lock.acceptedRuntime.tree = "0".repeat(40);
	const { status, stderr } = runCli(lock, validPatches());
	assert.equal(status, 1);
	assert.match(stderr, /acceptedRuntime\.tree: zero SHA is not a valid baseline/);
});

test("rejects acceptedRuntime missing verifiedAt", () => {
	const lock = validLock();
	delete lock.acceptedRuntime.verifiedAt;
	const { status, stderr } = runCli(lock, validPatches());
	assert.equal(status, 1);
	assert.match(stderr, /missing required field: acceptedRuntime\.verifiedAt/);
});

test("rejects wrong fork repository", () => {
	const lock = validLock();
	lock.fork.repository = "someone-else/pi";
	const { status, stderr } = runCli(lock, validPatches());
	assert.equal(status, 1);
	assert.match(stderr, /fork\.repository: expected blueforst\/pi/);
});

test("rejects wrong upstream repository", () => {
	const lock = validLock();
	lock.upstream.repository = "someone-else/pi";
	const { status, stderr } = runCli(lock, validPatches());
	assert.equal(status, 1);
	assert.match(stderr, /upstream\.repository: expected earendil-works\/pi/);
});

test("rejects zero SHA in carried-patches upstream base", () => {
	const patches = validPatches();
	patches.upstreamBaseCommit = "0".repeat(40);
	const { status, stderr } = runCli(validLock(), patches);
	assert.equal(status, 1);
	assert.match(stderr, /upstreamBaseCommit: zero SHA is not a valid baseline/);
});

test("rejects unsupported patch status", () => {
	const patches = validPatches();
	const patch = samplePatch();
	patch.status = "wip";
	patches.patches.push(patch);
	const { status, stderr } = runCli(validLock(), patches);
	assert.equal(status, 1);
	assert.match(stderr, /status: unsupported value/);
});

test("rejects unsupported upstream status", () => {
	const patches = validPatches();
	const patch = samplePatch();
	patch.upstream.status = "pending";
	patches.patches.push(patch);
	const { status, stderr } = runCli(validLock(), patches);
	assert.equal(status, 1);
	assert.match(stderr, /upstream\.status: unsupported value/);
});

test("rejects malformed patch commit", () => {
	const patches = validPatches();
	const patch = samplePatch();
	patch.firstForkCommit = "not-a-sha";
	patches.patches.push(patch);
	const { status, stderr } = runCli(validLock(), patches);
	assert.equal(status, 1);
	assert.match(stderr, /firstForkCommit: expected full 40-character hex commit SHA/);
});

test("rejects not_filed upstream status with issue references", () => {
	const patches = validPatches();
	const patch = samplePatch();
	patch.upstream = { issue: 5, pullRequest: null, status: "not_filed" };
	patches.patches.push(patch);
	const { status, stderr } = runCli(validLock(), patches);
	assert.equal(status, 1);
	assert.match(stderr, /not_filed/);
});

test("rejects unparsable JSON", () => {
	const dir = mkdtempSync(join(tmpdir(), "iris-fork-baseline-"));
	fixtureDirs.push(dir);
	const lockPath = join(dir, "production-lock.json");
	const patchesPath = join(dir, "carried-patches.json");
	writeFileSync(lockPath, "{ not json");
	writeFileSync(patchesPath, JSON.stringify(validPatches(), null, "\t"));
	const result = spawnSync(process.execPath, [SCRIPT, lockPath, patchesPath], { encoding: "utf8" });
	assert.equal(result.status, 1);
	assert.match(result.stderr, /cannot read or parse/);
});

test("rejects empty patch id", () => {
	const patches = validPatches();
	const patch = samplePatch();
	patch.id = "";
	patches.patches.push(patch);
	assertFailsWithFieldError(runCli(validLock(), patches), /patches\[0\]: id: expected non-empty string/);
});

test("rejects duplicate empty patch ids", () => {
	const patches = validPatches();
	const first = samplePatch();
	first.id = "";
	const second = samplePatch();
	second.id = "";
	patches.patches.push(first, second);
	const { status, stderr } = runCli(validLock(), patches);
	assert.equal(status, 1);
	assert.match(stderr, /patches\[0\]: id: expected non-empty string/);
	assert.match(stderr, /patches\[1\]: id: expected non-empty string/);
});

test("accepts proposed patch without commit ids", () => {
	const patches = validPatches();
	const patch = samplePatch();
	patch.status = "proposed";
	delete patch.firstForkCommit;
	delete patch.latestForkCommit;
	patches.patches.push(patch);
	const { status } = runCli(validLock(), patches);
	assert.equal(status, 0);
});

test("rejects carried patch without firstForkCommit", () => {
	const patches = validPatches();
	const patch = samplePatch();
	delete patch.firstForkCommit;
	patches.patches.push(patch);
	assertFailsWithFieldError(runCli(validLock(), patches), /firstForkCommit: required for status "carried"/);
});

test("rejects carried patch without latestForkCommit", () => {
	const patches = validPatches();
	const patch = samplePatch();
	delete patch.latestForkCommit;
	patches.patches.push(patch);
	assertFailsWithFieldError(runCli(validLock(), patches), /latestForkCommit: required for status "carried"/);
});

test("rejects removed patch without commit ids", () => {
	const patches = validPatches();
	const patch = samplePatch();
	patch.status = "removed";
	delete patch.firstForkCommit;
	delete patch.latestForkCommit;
	patches.patches.push(patch);
	assertFailsWithFieldError(runCli(validLock(), patches), /firstForkCommit: required for status "removed"/);
});

test("rejects removable patch without commit ids", () => {
	const patches = validPatches();
	const patch = samplePatch();
	patch.status = "removable";
	delete patch.firstForkCommit;
	patches.patches.push(patch);
	assertFailsWithFieldError(runCli(validLock(), patches), /firstForkCommit: required for status "removable"/);
});

test("rejects upstreamed patch without commit ids", () => {
	const patches = validPatches();
	const patch = samplePatch();
	patch.status = "upstreamed";
	delete patch.latestForkCommit;
	patches.patches.push(patch);
	assertFailsWithFieldError(runCli(validLock(), patches), /latestForkCommit: required for status "upstreamed"/);
});

test("rejects missing fork object without throwing", () => {
	const lock = validLock();
	delete lock.fork;
	assertFailsWithFieldError(runCli(lock, validPatches()), /missing required field: fork\.repository/);
});

test("rejects missing upstream object without throwing", () => {
	const lock = validLock();
	delete lock.upstream;
	assertFailsWithFieldError(runCli(lock, validPatches()), /missing required field: upstream\.repository/);
});

test("rejects null fork object without throwing", () => {
	const lock = validLock();
	lock.fork = null;
	assertFailsWithFieldError(runCli(lock, validPatches()), /fork\.repository: expected blueforst\/pi, got undefined/);
});

test("rejects null upstream object without throwing", () => {
	const lock = validLock();
	lock.upstream = null;
	assertFailsWithFieldError(runCli(lock, validPatches()), /upstream\.repository: expected earendil-works\/pi, got undefined/);
});

test("consistency validation handles missing upstream safely", () => {
	const lock = { schemaVersion: 1 };
	assertFailsWithFieldError(runCli(lock, validPatches()), /missing required field: fork\.repository/);
});

test("rejects lastVerifiedUpstreamCommit not equal to upstream base", () => {
	const lock = validLock();
	lock.sync.lastVerifiedUpstreamCommit = "a".repeat(40);
	assertFailsWithFieldError(runCli(lock, validPatches()), /sync\.lastVerifiedUpstreamCommit must equal upstream\.baseCommit/);
});

test("rejects lastVerifiedAt earlier than upstream verifiedAt", () => {
	const lock = validLock();
	lock.sync.lastVerifiedAt = "2026-08-03";
	assertFailsWithFieldError(runCli(lock, validPatches()), /sync\.lastVerifiedAt must be equal to or later than upstream\.verifiedAt/);
});

test("rejects defaultBranch other than main", () => {
	const lock = validLock();
	lock.fork.defaultBranch = "dev";
	assertFailsWithFieldError(runCli(lock, validPatches()), /fork\.defaultBranch: schema v2 requires "main"/);
});

test("rejects packageManager other than npm", () => {
	const lock = validLock();
	lock.runtime.packageManager = "pnpm";
	assertFailsWithFieldError(runCli(lock, validPatches()), /runtime\.packageManager: schema v2 requires "npm"/);
});

test("rejects lockfile other than package-lock.json", () => {
	const lock = validLock();
	lock.runtime.lockfile = "yarn.lock";
	assertFailsWithFieldError(runCli(lock, validPatches()), /runtime\.lockfile: schema v2 requires "package-lock\.json"/);
});

test("validates the real manifests via default paths", () => {
	const result = spawnSync(process.execPath, [SCRIPT], { cwd: REPO_ROOT, encoding: "utf8" });
	assert.equal(result.status, 0);
	assert.match(result.stdout, /OK: iris fork baseline manifests are valid/);
});

// --- git-backed acceptedRuntime provenance (issue iris_agent#41) ---

function makeGitRepo() {
	const dir = mkdtempSync(join(tmpdir(), "iris-fork-git-"));
	fixtureDirs.push(dir);
	spawnSync("git", ["init", "-q", "-b", "main", dir], { encoding: "utf8" });
	spawnSync("git", ["-C", dir, "config", "user.email", "test@example.com"], { encoding: "utf8" });
	spawnSync("git", ["-C", dir, "config", "user.name", "Test"], { encoding: "utf8" });
	writeFileSync(join(dir, "README.md"), "# test repo\n");
	spawnSync("git", ["-C", dir, "add", "README.md"], { encoding: "utf8" });
	const commitResult = spawnSync("git", ["-C", dir, "commit", "-q", "-m", "baseline"], { encoding: "utf8" });
	assert.equal(commitResult.status, 0);
	const commit = spawnSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
	const tree = spawnSync("git", ["-C", dir, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).stdout.trim();
	return { dir, commit, tree };
}

test("--verify-git accepts matching commit and tree in a real repository", () => {
	const { dir, commit, tree } = makeGitRepo();
	const lock = validLock();
	lock.acceptedRuntime.commit = commit;
	lock.acceptedRuntime.tree = tree;
	const patches = validPatches();
	const dir2 = mkdtempSync(join(tmpdir(), "iris-fork-git-"));
	fixtureDirs.push(dir2);
	const lockPath = join(dir2, "production-lock.json");
	const patchesPath = join(dir2, "carried-patches.json");
	writeFileSync(lockPath, JSON.stringify(lock, null, "	"));
	writeFileSync(patchesPath, JSON.stringify(patches, null, "	"));
	const result = spawnSync(process.execPath, [SCRIPT, "--verify-git", lockPath, patchesPath, dir], {
		cwd: dir,
		encoding: "utf8",
	});
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /git-verified/);
});

test("--verify-git rejects a commit that does not exist", () => {
	const { dir, tree } = makeGitRepo();
	const lock = validLock();
	lock.acceptedRuntime.commit = "f".repeat(40);
	lock.acceptedRuntime.tree = tree;
	const dir2 = mkdtempSync(join(tmpdir(), "iris-fork-git-"));
	fixtureDirs.push(dir2);
	const lockPath = join(dir2, "production-lock.json");
	writeFileSync(lockPath, JSON.stringify(lock, null, "	"));
	writeFileSync(join(dir2, "carried-patches.json"), JSON.stringify(validPatches(), null, "	"));
	const result = spawnSync(process.execPath, [SCRIPT, "--verify-git", lockPath, join(dir2, "carried-patches.json"), dir], {
		cwd: dir,
		encoding: "utf8",
	});
	assert.equal(result.status, 1);
	assert.match(result.stderr, /does not exist in git repository/);
});

test("--verify-git rejects a tree mismatch for the pinned commit", () => {
	const { dir, commit } = makeGitRepo();
	const lock = validLock();
	lock.acceptedRuntime.commit = commit;
	lock.acceptedRuntime.tree = "a".repeat(40);
	const dir2 = mkdtempSync(join(tmpdir(), "iris-fork-git-"));
	fixtureDirs.push(dir2);
	const lockPath = join(dir2, "production-lock.json");
	writeFileSync(lockPath, JSON.stringify(lock, null, "	"));
	writeFileSync(join(dir2, "carried-patches.json"), JSON.stringify(validPatches(), null, "	"));
	const result = spawnSync(process.execPath, [SCRIPT, "--verify-git", lockPath, join(dir2, "carried-patches.json"), dir], {
		cwd: dir,
		encoding: "utf8",
	});
	assert.equal(result.status, 1);
	assert.match(result.stderr, /acceptedRuntime\.tree mismatch/);
});

test("--verify-git rejects a carried patch that is not an ancestor", () => {
	const { dir, commit, tree } = makeGitRepo();
	// Create a second, unrelated branch commit that is NOT an ancestor of HEAD.
	spawnSync("git", ["-C", dir, "checkout", "-q", "-b", "other"], { encoding: "utf8" });
	writeFileSync(join(dir, "other.txt"), "other\n");
	spawnSync("git", ["-C", dir, "add", "other.txt"], { encoding: "utf8" });
	spawnSync("git", ["-C", dir, "commit", "-q", "-m", "other"], { encoding: "utf8" });
	const otherCommit = spawnSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
	spawnSync("git", ["-C", dir, "checkout", "-q", "main"], { encoding: "utf8" });

	const lock = validLock();
	lock.acceptedRuntime.commit = commit;
	lock.acceptedRuntime.tree = tree;
	const patches = validPatches();
	const patch = samplePatch();
	patch.latestForkCommit = otherCommit;
	patches.patches.push(patch);

	const dir2 = mkdtempSync(join(tmpdir(), "iris-fork-git-"));
	fixtureDirs.push(dir2);
	const lockPath = join(dir2, "production-lock.json");
	writeFileSync(lockPath, JSON.stringify(lock, null, "	"));
	writeFileSync(join(dir2, "carried-patches.json"), JSON.stringify(patches, null, "	"));
	const result = spawnSync(process.execPath, [SCRIPT, "--verify-git", lockPath, join(dir2, "carried-patches.json"), dir], {
		cwd: dir,
		encoding: "utf8",
	});
	assert.equal(result.status, 1);
	assert.match(result.stderr, /is not an ancestor of acceptedRuntime\.commit/);
});
