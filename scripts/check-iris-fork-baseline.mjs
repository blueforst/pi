// Iris fork provenance gate.
//
// Validates docs/iris-fork/production-lock.json and docs/iris-fork/carried-patches.json.
// Fail-closed: any malformed or unsupported value is an error and the check exits non-zero.
// No third-party dependencies. Schema authority lives here (single source of truth).
//
// Usage:
//   node scripts/check-iris-fork-baseline.mjs [productionLockPath] [carriedPatchesPath]
// Defaults to the repo's docs/iris-fork/ manifests.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_LOCK_PATH = join(SCRIPTS_DIR, "..", "docs", "iris-fork", "production-lock.json");
const DEFAULT_PATCHES_PATH = join(SCRIPTS_DIR, "..", "docs", "iris-fork", "carried-patches.json");

export const SUPPORTED_SCHEMA_VERSION = 1;

export const FORK_REPOSITORY = "blueforst/pi";
export const UPSTREAM_REPOSITORY = "earendil-works/pi";
export const PACKAGE_IDENTITY_STATUSES = ["inherits_upstream_package_names", "independent_identity"];
export const PUBLISH_STATUSES = ["not_published", "publish_forbidden"];
export const DEPENDENCY_DIRECTIONS = ["upstream_only"];
export const SYNC_STRATEGIES = ["manual_review_gate"];
export const PATCH_STATUSES = ["proposed", "carried", "upstreamed", "removable", "removed"];
export const UPSTREAM_STATUSES = ["not_filed", "filed", "open", "merged", "rejected", "superseded"];

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const ZERO_SHA = "0000000000000000000000000000000000000000";
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const PLACEHOLDER_PATTERN = /(?:^|\b)(?:TBD|TODO|unknown)(?:\b|$)/i;

const PRODUCTION_LOCK_REQUIRED_FIELDS = [
	"schemaVersion",
	"fork.repository",
	"fork.defaultBranch",
	"fork.baselineCommit",
	"upstream.repository",
	"upstream.baseCommit",
	"upstream.verifiedAt",
	"runtime.node",
	"runtime.packageManager",
	"runtime.lockfile",
	"distribution.packageIdentityStatus",
	"distribution.publishStatus",
	"dependencyDirection",
	"sync.strategy",
	"sync.lastVerifiedUpstreamCommit",
	"sync.lastVerifiedAt",
];

// firstForkCommit / latestForkCommit are optional: a proposed patch may not
// have landed any fork commit yet. When present they must be full SHAs.
const PATCH_REQUIRED_FIELDS = [
	"id",
	"title",
	"status",
	"genericRuntimeRationale",
	"affectedPackages",
	"affectedSurfaces",
	"tests",
	"upstream.issue",
	"upstream.pullRequest",
	"upstream.status",
	"removalCondition",
	"compatibilityRisk",
	"notes",
];

function isObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getPath(obj, path) {
	return path.split(".").reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

function isNonEmptyString(value) {
	return typeof value === "string" && value.length > 0;
}

function isSha(value) {
	return typeof value === "string" && SHA_PATTERN.test(value);
}

function isZeroSha(value) {
	return value === ZERO_SHA;
}

function isIsoDate(value) {
	if (typeof value !== "string" || !ISO_DATE_PATTERN.test(value)) return false;
	const [year, month, day] = value.split("-").map(Number);
	if (month < 1 || month > 12 || day < 1 || day > 31) return false;
	const date = new Date(Date.UTC(year, month - 1, day));
	return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isNullishOrPositiveInt(value) {
	return value === null || (Number.isInteger(value) && value > 0);
}

function collectStrings(value, path, out) {
	if (typeof value === "string") {
		out.push([path, value]);
	} else if (Array.isArray(value)) {
		value.forEach((item, index) => collectStrings(item, `${path}[${index}]`, out));
	} else if (isObject(value)) {
		for (const [key, child] of Object.entries(value)) {
			collectStrings(child, path === "" ? key : `${path}.${key}`, out);
		}
	}
}

function placeholderErrors(value, label) {
	const strings = [];
	collectStrings(value, "", strings);
	const errors = [];
	for (const [path, text] of strings) {
		if (PLACEHOLDER_PATTERN.test(text)) {
			const where = path === "" ? "(root)" : path;
			errors.push(`${label}: ${where}: placeholder value not allowed: ${JSON.stringify(text)}`);
		}
	}
	return errors;
}

function checkRequiredFields(obj, requiredFields, label) {
	const errors = [];
	for (const path of requiredFields) {
		if (getPath(obj, path) === undefined) {
			errors.push(`${label}: missing required field: ${path}`);
		}
	}
	return errors;
}

function checkShaField(obj, path, label) {
	const errors = [];
	const value = getPath(obj, path);
	if (!isSha(value)) {
		errors.push(`${label}: ${path}: expected full 40-character hex commit SHA, got ${JSON.stringify(value)}`);
	} else if (isZeroSha(value)) {
		errors.push(`${label}: ${path}: zero SHA is not a valid baseline`);
	}
	return errors;
}

function checkIsoDateField(obj, path, label) {
	const errors = [];
	const value = getPath(obj, path);
	if (!isIsoDate(value)) {
		errors.push(`${label}: ${path}: expected ISO date YYYY-MM-DD, got ${JSON.stringify(value)}`);
	}
	return errors;
}

function checkEnumField(obj, path, allowed, label) {
	const errors = [];
	const value = getPath(obj, path);
	if (!allowed.includes(value)) {
		errors.push(`${label}: ${path}: unsupported value ${JSON.stringify(value)}, expected one of ${allowed.map((v) => JSON.stringify(v)).join(", ")}`);
	}
	return errors;
}

function checkNonEmptyStringField(obj, path, label) {
	const errors = [];
	const value = getPath(obj, path);
	if (!isNonEmptyString(value)) {
		errors.push(`${label}: ${path}: expected non-empty string, got ${JSON.stringify(value)}`);
	}
	return errors;
}

function checkNonEmptyStringArray(obj, path, label) {
	const errors = [];
	const value = getPath(obj, path);
	if (!Array.isArray(value) || value.length === 0) {
		errors.push(`${label}: ${path}: expected non-empty array of strings, got ${JSON.stringify(value)}`);
		return errors;
	}
	for (let index = 0; index < value.length; index++) {
		if (!isNonEmptyString(value[index])) {
			errors.push(`${label}: ${path}[${index}]: expected non-empty string, got ${JSON.stringify(value[index])}`);
		}
	}
	return errors;
}

export function validateProductionLock(lock, label = "production-lock.json") {
	const errors = [];
	if (!isObject(lock)) {
		errors.push(`${label}: expected a JSON object, got ${JSON.stringify(lock)}`);
		return errors;
	}
	errors.push(...checkRequiredFields(lock, PRODUCTION_LOCK_REQUIRED_FIELDS, label));
	if (lock.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
		errors.push(`${label}: schemaVersion: unsupported value ${JSON.stringify(lock.schemaVersion)}, expected ${SUPPORTED_SCHEMA_VERSION}`);
	}
	checkNonEmptyStringField(lock, "fork.defaultBranch", label).forEach((e) => errors.push(e));
	if (lock.fork.repository !== FORK_REPOSITORY) {
		errors.push(`${label}: fork.repository: expected ${FORK_REPOSITORY}, got ${JSON.stringify(lock.fork.repository)}`);
	}
	if (lock.upstream.repository !== UPSTREAM_REPOSITORY) {
		errors.push(`${label}: upstream.repository: expected ${UPSTREAM_REPOSITORY}, got ${JSON.stringify(lock.upstream.repository)}`);
	}
	errors.push(...checkShaField(lock, "fork.baselineCommit", label));
	errors.push(...checkShaField(lock, "upstream.baseCommit", label));
	errors.push(...checkShaField(lock, "sync.lastVerifiedUpstreamCommit", label));
	errors.push(...checkIsoDateField(lock, "upstream.verifiedAt", label));
	errors.push(...checkIsoDateField(lock, "sync.lastVerifiedAt", label));
	["runtime.node", "runtime.packageManager", "runtime.lockfile"].forEach((path) => checkNonEmptyStringField(lock, path, label).forEach((e) => errors.push(e)));
	errors.push(...checkEnumField(lock, "distribution.packageIdentityStatus", PACKAGE_IDENTITY_STATUSES, label));
	errors.push(...checkEnumField(lock, "distribution.publishStatus", PUBLISH_STATUSES, label));
	errors.push(...checkEnumField(lock, "dependencyDirection", DEPENDENCY_DIRECTIONS, label));
	errors.push(...checkEnumField(lock, "sync.strategy", SYNC_STRATEGIES, label));
	errors.push(...placeholderErrors(lock, label));
	return errors;
}

export function validateCarriedPatches(doc, label = "carried-patches.json") {
	const errors = [];
	if (!isObject(doc)) {
		errors.push(`${label}: expected a JSON object, got ${JSON.stringify(doc)}`);
		return errors;
	}
	if (doc.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
		errors.push(`${label}: schemaVersion: unsupported value ${JSON.stringify(doc.schemaVersion)}, expected ${SUPPORTED_SCHEMA_VERSION}`);
	}
	errors.push(...checkShaField(doc, "upstreamBaseCommit", label));
	if (!Array.isArray(doc.patches)) {
		errors.push(`${label}: patches: expected an array, got ${JSON.stringify(doc.patches)}`);
		return errors;
	}
	const seenIds = new Set();
	for (let index = 0; index < doc.patches.length; index++) {
		const patch = doc.patches[index];
		const patchLabel = `${label}: patches[${index}]`;
		if (!isObject(patch)) {
			errors.push(`${patchLabel}: expected a patch object, got ${JSON.stringify(patch)}`);
			continue;
		}
		errors.push(...checkRequiredFields(patch, PATCH_REQUIRED_FIELDS, patchLabel));
		if (isNonEmptyString(patch.id)) {
			if (seenIds.has(patch.id)) {
				errors.push(`${patchLabel}: id: duplicate patch id: ${JSON.stringify(patch.id)}`);
			}
			seenIds.add(patch.id);
		}
		checkNonEmptyStringField(patch, "title", patchLabel).forEach((e) => errors.push(e));
		checkNonEmptyStringField(patch, "genericRuntimeRationale", patchLabel).forEach((e) => errors.push(e));
		checkNonEmptyStringField(patch, "removalCondition", patchLabel).forEach((e) => errors.push(e));
		checkNonEmptyStringField(patch, "compatibilityRisk", patchLabel).forEach((e) => errors.push(e));
		errors.push(...checkNonEmptyStringArray(patch, "affectedPackages", patchLabel));
		errors.push(...checkNonEmptyStringArray(patch, "affectedSurfaces", patchLabel));
		errors.push(...checkNonEmptyStringArray(patch, "tests", patchLabel));
		errors.push(...checkEnumField(patch, "status", PATCH_STATUSES, patchLabel));
		errors.push(...checkEnumField(patch, "upstream.status", UPSTREAM_STATUSES, patchLabel));
		for (const path of ["upstream.issue", "upstream.pullRequest"]) {
			const value = getPath(patch, path);
			if (!isNullishOrPositiveInt(value)) {
				errors.push(`${patchLabel}: ${path}: expected null or a positive integer, got ${JSON.stringify(value)}`);
			}
		}
		if (patch.upstream && patch.upstream.status === "not_filed" && (patch.upstream.issue !== null || patch.upstream.pullRequest !== null)) {
			errors.push(`${patchLabel}: upstream.status is "not_filed" but upstream.issue/upstream.pullRequest are not null`);
		}
		for (const path of ["firstForkCommit", "latestForkCommit"]) {
			if (getPath(patch, path) !== undefined) {
				errors.push(...checkShaField(patch, path, patchLabel));
			}
		}
		errors.push(...placeholderErrors(patch, patchLabel));
	}
	return errors;
}

export function validateBaselineConsistency(lock, patchesDoc, lockLabel = "production-lock.json", patchesLabel = "carried-patches.json") {
	const errors = [];
	if (!isObject(lock) || !isObject(patchesDoc)) return errors;
	if (patchesDoc.upstreamBaseCommit !== lock.upstream.baseCommit) {
		errors.push(
			`${patchesLabel}: upstreamBaseCommit ${JSON.stringify(patchesDoc.upstreamBaseCommit)} does not match ${lockLabel}: upstream.baseCommit ${JSON.stringify(lock.upstream.baseCommit)}`
		);
	}
	return errors;
}

export function checkIrisForkBaseline(lockPath, patchesPath) {
	const lockLabel = lockPath;
	const patchesLabel = patchesPath;
	let lock;
	let patchesDoc;
	try {
		lock = JSON.parse(readFileSync(lockPath, "utf8"));
	} catch (error) {
		return { ok: false, errors: [`${lockLabel}: cannot read or parse: ${error.message}`] };
	}
	try {
		patchesDoc = JSON.parse(readFileSync(patchesPath, "utf8"));
	} catch (error) {
		return { ok: false, errors: [`${patchesLabel}: cannot read or parse: ${error.message}`] };
	}
	const errors = [
		...validateProductionLock(lock, lockLabel),
		...validateCarriedPatches(patchesDoc, patchesLabel),
		...validateBaselineConsistency(lock, patchesDoc, lockLabel, patchesLabel),
	];
	return { ok: errors.length === 0, errors };
}

function main() {
	const [lockArg, patchesArg] = process.argv.slice(2);
	const lockPath = lockArg ?? DEFAULT_LOCK_PATH;
	const patchesPath = patchesArg ?? DEFAULT_PATCHES_PATH;
	const result = checkIrisForkBaseline(lockPath, patchesPath);
	if (result.ok) {
		console.log("OK: iris fork baseline manifests are valid");
		return;
	}
	console.error("FAIL: iris fork baseline manifests are invalid:");
	for (const error of result.errors) {
		console.error(`- ${error}`);
	}
	process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main();
}
