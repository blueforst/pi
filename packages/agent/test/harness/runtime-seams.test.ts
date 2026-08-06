import {
	createModels,
	type FauxProviderHandle,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { AgentHarness, computeMessageContentHash } from "../../src/harness/agent-harness.ts";
import type { MessageFinalizedEvent } from "../../src/harness/types.ts";
import type { AgentMessage } from "../../src/types.ts";
import { calculateTool } from "../utils/calculate.ts";
import { createInMemorySession } from "./session-test-utils.ts";

function createUserMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

/**
 * Runtime seam contract tests (PI-015 / PI-016 / PI-017).
 *
 * These are GENERIC runtime tests (no Iris cognitive semantics): they verify
 * the Provider Context Controller seam, the awaited Session commit receipts
 * and the stable RuntimeEvent lifecycle events behave as a generic runtime
 * substrate must.
 */

const models = createModels();
let fauxCount = 0;

function newFaux(): FauxProviderHandle {
	const faux = fauxProvider({ provider: `seam-faux-${++fauxCount}` });
	models.setProvider(faux.provider);
	return faux;
}

function textContent(message: AgentMessage): string {
	if (!("content" in message)) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	return content
		.filter((part): part is Extract<typeof part, { type: "text"; text: string }> => part.type === "text")
		.map((part) => part.text)
		.join("");
}

describe("PI-015 Provider Context Controller", () => {
	it("uses controller systemPrompt/messages and NEVER calls Session.buildContext()", async () => {
		const session = await createInMemorySession();
		let buildContextCalls = 0;
		// Spy that fails hard if the controller path still forces buildContext.
		session.buildContext = (async () => {
			buildContextCalls += 1;
			throw new Error("Session.buildContext must not be called on the controller path");
		}) as typeof session.buildContext;

		const registration = newFaux();
		let seenContext: { systemPrompt?: string; messages?: Array<{ role: string }> } | undefined;
		registration.setResponses([
			async (context) => {
				seenContext = context as { systemPrompt?: string; messages?: Array<{ role: string }> };
				return fauxAssistantMessage("controlled answer");
			},
		]);

		const harness = new AgentHarness({
			models,
			session,
			model: registration.getModel(),
			contextController: async ({ activeTools }) => ({
				systemPrompt: "CONTROLLED SYSTEM PROMPT",
				messages: [
					{ role: "user", content: [{ type: "text", text: "CONTROLLED MESSAGE" }], timestamp: Date.now() },
				],
				activeToolNames: activeTools.map((tool) => tool.name),
			}),
		});

		const response = await harness.prompt("ignored native input");
		expect(buildContextCalls).toBe(0);
		expect(textContent(response)).toBe("controlled answer");

		// The provider context must carry the controller's system prompt + messages.
		expect(seenContext?.systemPrompt).toBe("CONTROLLED SYSTEM PROMPT");
		const roles = seenContext?.messages?.map((message) => message.role);
		expect(roles).toContain("user");
	});

	it("default path (no controller) still calls Session.buildContext() and stays compatible", async () => {
		const session = await createInMemorySession();
		let buildContextCalls = 0;
		const originalBuildContext = session.buildContext.bind(session);
		session.buildContext = (async (...args: unknown[]) => {
			buildContextCalls += 1;
			return originalBuildContext(...(args as []));
		}) as typeof session.buildContext;

		const registration = newFaux();
		registration.setResponses([async () => fauxAssistantMessage("native answer")]);

		const harness = new AgentHarness({
			models,
			session,
			model: registration.getModel(),
			systemPrompt: "NATIVE SYSTEM PROMPT",
		});

		const response = await harness.prompt("hello");
		expect(buildContextCalls).toBeGreaterThanOrEqual(1);
		expect(textContent(response)).toBe("native answer");
	});
});

describe("PI-016 Session commit receipts & PI-017 lifecycle events", () => {
	it("emits message_finalized with a full receipt for every appended message", async () => {
		const session = await createInMemorySession();
		const registration = newFaux();
		registration.setResponses([async () => fauxAssistantMessage("hello back")]);

		const finalized: MessageFinalizedEvent[] = [];
		const harness = new AgentHarness({
			models,
			session,
			model: registration.getModel(),
			systemPrompt: "You are helpful.",
		});
		harness.subscribe((event) => {
			if (event.type === "message_finalized") finalized.push(event as MessageFinalizedEvent);
		});

		await harness.prompt("hello");

		// user prompt + assistant response both finalized exactly once
		expect(finalized.length).toBe(2);
		const userEvent = finalized[0]!;
		const assistantEvent = finalized[1]!;
		expect(userEvent.role).toBe("user");
		expect(assistantEvent.role).toBe("assistant");
		for (const event of finalized) {
			expect(typeof event.entryId).toBe("string");
			expect(event.entryId.length).toBeGreaterThan(0);
			expect(typeof event.contentHash).toBe("string");
			expect(event.contentHash.length).toBe(64);
			const metadata = await session.getMetadata();
			expect(event.receipt.sessionId).toBe(metadata.id);
			expect(event.receipt.entryId).toBe(event.entryId);
			expect(event.receipt.contentHash).toBe(event.contentHash);
			expect(typeof event.receipt.committedAt).toBe("string");
		}
		// Deterministic content hash: identical message content → identical hash,
		// regardless of JSON key order (computed via the exported helper).
		const stableMessage: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "hello" }],
			timestamp: 1234567890,
		};
		const hashA = await computeMessageContentHash(stableMessage);
		const reorderedMessage: AgentMessage = {
			timestamp: 1234567890,
			content: [{ type: "text", text: "hello" }],
			role: "user",
		};
		expect(await computeMessageContentHash(reorderedMessage)).toBe(hashA);
		expect(hashA.length).toBe(64);
	});

	it("emits turn_committed and settled in stable order", async () => {
		const session = await createInMemorySession();
		const registration = newFaux();
		registration.setResponses([async () => fauxAssistantMessage("done")]);

		const order: string[] = [];
		const harness = new AgentHarness({
			models,
			session,
			model: registration.getModel(),
			systemPrompt: "You are helpful.",
		});
		harness.subscribe((event) => {
			if (["message_finalized", "turn_committed", "save_point", "settled"].includes(event.type)) {
				order.push(event.type);
			}
		});

		await harness.prompt("hello");

		expect(order).toContain("message_finalized");
		expect(order).toContain("turn_committed");
		expect(order).toContain("save_point");
		expect(order[order.length - 1]).toBe("settled");
		// user message is finalized before the turn commits
		expect(order.indexOf("message_finalized")).toBeLessThan(order.indexOf("turn_committed"));
	});

	it("emits tool_execution_committed for each executed tool call", async () => {
		const session = await createInMemorySession();
		const registration = newFaux();
		registration.setResponses([
			async () =>
				fauxAssistantMessage(fauxToolCall("calculate", { expression: "1 + 1" }, { id: "toolcall-1" }), {
					stopReason: "toolUse",
				}),
			async () => fauxAssistantMessage("the answer is 2"),
		]);

		const committed: Array<{ toolCallId: string; toolName: string; isError: boolean }> = [];
		const harness = new AgentHarness({
			models,
			session,
			model: registration.getModel(),
			systemPrompt: "You are helpful.",
			tools: [calculateTool],
		});
		harness.subscribe((event) => {
			if (event.type === "tool_execution_committed") committed.push(event);
		});

		await harness.prompt("compute 1+1");

		expect(committed.length).toBe(1);
		expect(committed[0]!.toolCallId).toBe("toolcall-1");
		expect(committed[0]!.toolName).toBe("calculate");
		expect(committed[0]!.isError).toBe(false);
	});
});

describe("iris_agent#40: every supported append path yields exactly one commit receipt", () => {
	it("harness.appendMessage (idle) emits exactly one message_finalized with a receipt", async () => {
		const session = await createInMemorySession();
		const finalized: MessageFinalizedEvent[] = [];
		const harness = new AgentHarness({
			models,
			session,
			model: newFaux().getModel(),
			systemPrompt: "You are helpful.",
		});
		harness.subscribe((event) => {
			if (event.type === "message_finalized") finalized.push(event as MessageFinalizedEvent);
		});

		await harness.appendMessage(createUserMessage("direct append"));

		expect(finalized.length).toBe(1);
		expect(finalized[0]!.role).toBe("user");
		expect(finalized[0]!.receipt.entryId).toBe(finalized[0]!.entryId);
		expect(finalized[0]!.receipt.contentHash.length).toBe(64);
		expect(finalized[0]!.receipt.sessionId).toBe((await session.getMetadata()).id);
	});

	it("pending-writes flush emits one receipt per message in real commit order", async () => {
		const session = await createInMemorySession();
		const registration = newFaux();
		registration.setResponses([
			async () => fauxAssistantMessage("first"),
			async () => fauxAssistantMessage("second"),
		]);
		const finalized: MessageFinalizedEvent[] = [];
		const harness = new AgentHarness({
			models,
			session,
			model: registration.getModel(),
			systemPrompt: "You are helpful.",
		});
		harness.subscribe((event) => {
			if (event.type === "message_finalized") finalized.push(event as MessageFinalizedEvent);
		});

		// While the harness is busy, direct appends go to the pending queue.
		const promptPromise = harness.prompt("hello");
		await harness.appendMessage(createUserMessage("queued user message"));
		await harness.appendMessage(createUserMessage("queued assistant note"));
		await promptPromise;

		// Agent loop (user + assistant) plus the two queued writes.
		expect(finalized.length).toBe(4);
		// Order is the real commit order: prompt user, assistant, queued user, queued note.
		const texts = finalized.map((event) => textContent(event.message));
		expect(texts).toEqual(["hello", "first", "queued user message", "queued assistant note"]);
		// Each message got its own distinct entry and receipt.
		const ids = finalized.map((event) => event.entryId);
		expect(new Set(ids).size).toBe(4);
	});

	it("agent-loop messages do not double-emit after consolidation", async () => {
		const session = await createInMemorySession();
		const registration = newFaux();
		registration.setResponses([async () => fauxAssistantMessage("once")]);
		const finalized: MessageFinalizedEvent[] = [];
		const harness = new AgentHarness({
			models,
			session,
			model: registration.getModel(),
			systemPrompt: "You are helpful.",
		});
		harness.subscribe((event) => {
			if (event.type === "message_finalized") finalized.push(event as MessageFinalizedEvent);
		});

		await harness.prompt("hello");

		expect(finalized.length).toBe(2);
		const ids = finalized.map((event) => event.entryId);
		expect(new Set(ids).size).toBe(2);
	});

	it("failed durable append produces no receipt/event (no phantom receipts)", async () => {
		const session = await createInMemorySession();
		session.appendMessage = (async () => {
			throw new Error("storage failure");
		}) as typeof session.appendMessage;

		const finalized: MessageFinalizedEvent[] = [];
		const harness = new AgentHarness({
			models,
			session,
			model: newFaux().getModel(),
			systemPrompt: "You are helpful.",
		});
		harness.subscribe((event) => {
			if (event.type === "message_finalized") finalized.push(event as MessageFinalizedEvent);
		});

		await expect(harness.appendMessage(createUserMessage("will fail"))).rejects.toThrow("storage failure");
		expect(finalized.length).toBe(0);
	});
});
