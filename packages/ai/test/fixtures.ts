import type { Api, Model } from "../src/types.ts";

// Stable fixture models for generic cancellation/tool tests.
//
// These models are constructed as plain literals and do NOT resolve through
// the generated catalog (`getModel`/`getBuiltinModel`), so their IDs cannot
// become stale when upstream model catalogs (models.dev, OpenRouter, NVIDIA,
// Vercel AI Gateway) churn. Runtime behavior is unchanged: the API and baseUrl
// point at the real provider endpoints, so e2e abort tests against live keys
// still exercise the real provider path. Only the ID is pinned to a stable,
// non-date-stamped catalog member (or a test-local ID where no stable member
// exists), which keeps the ModelId type universe decoupled from this file.

function fixtureModel<TApi extends Api>(
	api: TApi,
	provider: Model<TApi>["provider"],
	id: string,
	name: string,
	baseUrl: string,
	options: {
		reasoning?: boolean;
		contextWindow?: number;
		maxTokens?: number;
		input?: ("text" | "image")[];
		cost?: Model<TApi>["cost"];
	} = {},
): Model<TApi> {
	return {
		id,
		name,
		api,
		provider,
		baseUrl,
		reasoning: options.reasoning ?? false,
		input: options.input ?? ["text"],
		cost: options.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: options.contextWindow ?? 4096,
		maxTokens: options.maxTokens ?? 4096,
	} as Model<TApi>;
}

export const googleFixture = fixtureModel(
	"google-generative-ai",
	"google",
	"gemini-2.5-flash",
	"Gemini 2.5 Flash",
	"https://generativelanguage.googleapis.com/v1beta",
	{
		reasoning: true,
		contextWindow: 1000000,
		maxTokens: 65536,
	},
);

export const openaiCompletionsFixture = fixtureModel(
	"openai-completions",
	"openai",
	"gpt-4o-mini",
	"GPT-4o mini",
	"https://api.openai.com/v1",
	{
		contextWindow: 128000,
		maxTokens: 16384,
	},
);

export const openaiResponsesFixture = fixtureModel(
	"openai-responses",
	"openai",
	"gpt-5-mini",
	"GPT-5 mini",
	"https://api.openai.com/v1",
	{
		reasoning: true,
		contextWindow: 400000,
		maxTokens: 128000,
	},
);

export const azureOpenAiFixture = fixtureModel(
	"azure-openai-responses",
	"azure-openai-responses",
	"gpt-4o-mini",
	"GPT-4o mini (Azure)",
	"",
	{
		contextWindow: 128000,
		maxTokens: 16384,
	},
);

export const anthropicFixture = fixtureModel(
	"anthropic-messages",
	"anthropic",
	"claude-opus-4-5",
	"Claude Opus 4.5",
	"https://api.anthropic.com",
	{
		reasoning: true,
		contextWindow: 1000000,
		maxTokens: 128000,
	},
);

export const mistralFixture = fixtureModel(
	"mistral-conversations",
	"mistral",
	"devstral-medium-latest",
	"Devstral Medium Latest",
	"https://api.mistral.ai",
	{
		reasoning: true,
		contextWindow: 128000,
		maxTokens: 65536,
	},
);

export const togetherFixture = fixtureModel(
	"openai-completions",
	"together",
	"moonshotai/Kimi-K2.6",
	"Kimi K2.6 (Together)",
	"https://api.together.ai/v1",
	{
		reasoning: true,
		contextWindow: 262144,
		maxTokens: 65536,
	},
);

export const basetenFixture = fixtureModel(
	"openai-completions",
	"baseten",
	"zai-org/GLM-5.2",
	"GLM-5.2 (Baseten)",
	"https://inference.baseten.co/v1",
	{
		reasoning: true,
		contextWindow: 131072,
		maxTokens: 65536,
	},
);

export const minimaxFixture = fixtureModel(
	"openai-completions",
	"minimax",
	"MiniMax-M2.7",
	"MiniMax M2.7",
	"https://api.minimaxi.com/v1",
	{
		reasoning: true,
		contextWindow: 245760,
		maxTokens: 131072,
	},
);

export const xiaomiFixture = fixtureModel(
	"openai-completions",
	"xiaomi",
	"mimo-v2.5-pro",
	"MiMo v2.5 Pro",
	"https://api.xiaomi.com",
	{
		reasoning: true,
		contextWindow: 200000,
		maxTokens: 65536,
	},
);

export const xiaomiTokenPlanCnFixture = fixtureModel(
	"openai-completions",
	"xiaomi-token-plan-cn",
	"mimo-v2.5-pro",
	"MiMo v2.5 Pro (CN)",
	"https://api.xiaomi.com",
	{
		reasoning: true,
		contextWindow: 200000,
		maxTokens: 65536,
	},
);

export const xiaomiTokenPlanAmsFixture = fixtureModel(
	"openai-completions",
	"xiaomi-token-plan-ams",
	"mimo-v2.5-pro",
	"MiMo v2.5 Pro (AMS)",
	"https://api.xiaomi.com",
	{
		reasoning: true,
		contextWindow: 200000,
		maxTokens: 65536,
	},
);

export const xiaomiTokenPlanSgpFixture = fixtureModel(
	"openai-completions",
	"xiaomi-token-plan-sgp",
	"mimo-v2.5-pro",
	"MiMo v2.5 Pro (SGP)",
	"https://api.xiaomi.com",
	{
		reasoning: true,
		contextWindow: 200000,
		maxTokens: 65536,
	},
);

export const qwenTokenPlanFixture = fixtureModel(
	"openai-completions",
	"qwen-token-plan",
	"qwen3.7-max",
	"Qwen3.7 Max",
	"https://api.qwen.ai/v1",
	{
		reasoning: true,
		contextWindow: 262144,
		maxTokens: 65536,
	},
);

export const qwenTokenPlanCnFixture = fixtureModel(
	"openai-completions",
	"qwen-token-plan-cn",
	"qwen3.7-max",
	"Qwen3.7 Max (CN)",
	"https://api.qwen.ai/v1",
	{
		reasoning: true,
		contextWindow: 262144,
		maxTokens: 65536,
	},
);

export const kimiCodingFixture = fixtureModel(
	"openai-completions",
	"kimi-coding",
	"kimi-for-coding",
	"Kimi for Coding",
	"https://api.kimi.com/coding",
	{
		reasoning: true,
		contextWindow: 1000000,
		maxTokens: 32768,
	},
);

export const vercelAiGatewayFixture = fixtureModel(
	"anthropic-messages",
	"vercel-ai-gateway",
	"google/gemini-2.5-flash",
	"Gemini 2.5 Flash (Vercel AI Gateway)",
	"https://ai-gateway.vercel.sh",
	{
		reasoning: true,
		contextWindow: 1000000,
		maxTokens: 65536,
	},
);

export const openaiCodexFixture = fixtureModel(
	"openai-codex-responses",
	"openai-codex",
	"gpt-5.5",
	"GPT-5.5 (Codex)",
	"https://chatgpt.com/backend-api",
	{
		reasoning: true,
		contextWindow: 272000,
		maxTokens: 128000,
	},
);

export const bedrockFixture = fixtureModel(
	"bedrock-converse-stream",
	"amazon-bedrock",
	"global.anthropic.claude-sonnet-4-5-20250929-v1:0",
	"Claude Sonnet 4.5 (Bedrock)",
	"https://bedrock-runtime.us-east-1.amazonaws.com",
	{
		reasoning: true,
		contextWindow: 200000,
		maxTokens: 64000,
	},
);
