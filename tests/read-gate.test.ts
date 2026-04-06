import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	NON_IMAGE_READ_BLOCK_REASON,
	NON_IMAGE_READ_NO_UI_REASON,
	buildNonImageReadApprovalMessage,
	classifyReadPath,
	ensureReadToolActive,
	evaluateReadGate,
	resolveReadPathForGate,
} from "../src/read-gate.ts";

async function withTempDir(fn: (dir: string) => Promise<void> | void) {
	const dir = mkdtempSync(join(tmpdir(), "doe-read-gate-"));
	try {
		await fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function writeBytes(path: string, bytes: number[]) {
	writeFileSync(path, Buffer.from(bytes));
}

test("classifyReadPath treats supported image signatures as images", async () => {
	await withTempDir(async (dir) => {
		const fixtures = [
			{ name: "image.png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], mimeType: "image/png" },
			{ name: "image.jpg", bytes: [0xff, 0xd8, 0xff, 0xdb], mimeType: "image/jpeg" },
			{ name: "image.gif", bytes: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61], mimeType: "image/gif" },
			{ name: "image.webp", bytes: [0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x45, 0x42, 0x50], mimeType: "image/webp" },
		] as const;

		for (const fixture of fixtures) {
			const path = join(dir, fixture.name);
			writeBytes(path, fixture.bytes);
			const result = await classifyReadPath(dir, fixture.name);
			assert.equal(result.kind, "image");
			assert.equal(result.mimeType, fixture.mimeType);
			assert.equal(result.resolvedPath, path);
		}
	});
});

test("classifyReadPath treats text and unsupported image formats as non-image", async () => {
	await withTempDir(async (dir) => {
		const textPath = join(dir, "notes.txt");
		const svgPath = join(dir, "image.svg");
		writeFileSync(textPath, "plain text");
		writeFileSync(svgPath, "<svg></svg>");

		const text = await classifyReadPath(dir, "notes.txt");
		const svg = await classifyReadPath(dir, "image.svg");

		assert.equal(text.kind, "non-image");
		assert.equal(svg.kind, "non-image");
	});
});

test("classifyReadPath returns unknown when the target cannot be opened", async () => {
	await withTempDir(async (dir) => {
		const result = await classifyReadPath(dir, "missing.txt");
		assert.equal(result.kind, "unknown");
		assert.equal(result.resolvedPath, join(dir, "missing.txt"));
	});
});

test("resolveReadPathForGate expands tilde and macOS screenshot variants", async () => {
	await withTempDir((dir) => {
		const screenshotDir = join(dir, "shots");
		mkdirSync(screenshotDir, { recursive: true });

		const tildeTarget = join(dir, "home-shot.png");
		writeFileSync(tildeTarget, "x");
		const expanded = resolveReadPathForGate("~/home-shot.png", "/tmp", { homeDir: dir });
		assert.equal(expanded, tildeTarget);

		const amPmTarget = join(screenshotDir, `CleanShot 2026-04-06 at 10.36.22${"\u202F"}PM.png`);
		writeFileSync(amPmTarget, "x");
		const amPmResolved = resolveReadPathForGate("shots/CleanShot 2026-04-06 at 10.36.22 PM.png", dir);
		assert.equal(amPmResolved, amPmTarget);

		const nfdCurlyTarget = join(screenshotDir, "Capture d’écran.png".normalize("NFD"));
		writeFileSync(nfdCurlyTarget, "x");
		const nfdCurlyResolved = resolveReadPathForGate("shots/Capture d'écran.png", dir);
		assert.notEqual(nfdCurlyResolved, join(dir, "shots", "Capture d'écran.png"));
		assert.match(nfdCurlyResolved, /Capture d’/);
	});
});

test("ensureReadToolActive adds read without duplicating it", () => {
	assert.deepEqual(ensureReadToolActive(["codex_spawn"]), ["codex_spawn", "read"]);
	assert.deepEqual(ensureReadToolActive(["codex_spawn", "read"]), ["codex_spawn", "read"]);
});

test("evaluateReadGate allows image reads and unknown reads without prompting", async () => {
	await withTempDir(async (dir) => {
		writeBytes(join(dir, "screen.png"), [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		let confirmCalls = 0;
		const confirm = async () => {
			confirmCalls += 1;
			return true;
		};

		const imageResult = await evaluateReadGate({
			cwd: dir,
			hasUI: true,
			input: { path: "screen.png" },
			confirm,
		});
		const unknownResult = await evaluateReadGate({
			cwd: dir,
			hasUI: true,
			input: { path: "missing.txt" },
			confirm,
		});

		assert.equal(imageResult, null);
		assert.equal(unknownResult, null);
		assert.equal(confirmCalls, 0);
	});
});

test("evaluateReadGate requires approval for non-image reads and blocks on denial", async () => {
	await withTempDir(async (dir) => {
		writeFileSync(join(dir, "notes.txt"), "hello");
		const prompts: string[] = [];
		const result = await evaluateReadGate({
			cwd: dir,
			hasUI: true,
			input: { path: "notes.txt", offset: 3, limit: 5 },
			confirm: async (title, message) => {
				prompts.push(title, message);
				return false;
			},
		});

		assert.deepEqual(result, { block: true, reason: NON_IMAGE_READ_BLOCK_REASON });
		assert.equal(prompts[0], "CTO Approval Required");
		assert.equal(
			prompts[1],
			buildNonImageReadApprovalMessage(
				{ path: "notes.txt", offset: 3, limit: 5 },
				{ kind: "non-image", resolvedPath: join(dir, "notes.txt"), mimeType: null },
			),
		);
	});
});

test("evaluateReadGate blocks non-image reads when confirmation is unavailable", async () => {
	await withTempDir(async (dir) => {
		writeFileSync(join(dir, "notes.txt"), "hello");
		const result = await evaluateReadGate({
			cwd: dir,
			hasUI: false,
			input: { path: "notes.txt" },
		});
		assert.deepEqual(result, { block: true, reason: NON_IMAGE_READ_NO_UI_REASON });
	});
});

test("evaluateReadGate allows approved non-image reads", async () => {
	await withTempDir(async (dir) => {
		writeFileSync(join(dir, "notes.txt"), "hello");
		const result = await evaluateReadGate({
			cwd: dir,
			hasUI: true,
			input: { path: "notes.txt" },
			confirm: async () => true,
		});
		assert.equal(result, null);
	});
});
