import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLLMClient,
  getProviderCatalog,
  getProviderOrderForRole,
} from "../../../core/src/llm-client.js";

vi.mock("@workspace/db", () => ({
  db: {
    insert: () => ({
      values: async () => undefined,
    }),
  },
  logs: {},
  taskOutcomes: {},
}));

const QWEN_KEY = `test-qwen-key-${process.pid}-${Date.now()}`;

function configureIsolatedRouter(): void {
  const unset = [
    "QWEN_API_KEY",
    "QWEN_API_KEY_2",
    "QWEN_MODEL",
    "QWEN_BASE_URL",
    "APEX_QWEN_BASE_URL",
    "APEX_QWEN_BYOK_ENABLED",
    "GROQ_API_KEY",
    "GEMINI_API_KEY",
    "OPENROUTER_API_KEY",
    "OPENROUTER_API_KEY_2",
    "OPENROUTER_API_KEY_3",
    "OPENROUTER_API_KEY_4",
    "OPENROUTER_FREE_API_KEY",
    "APEX_OPENROUTER_MODEL_POLICY",
  ];
  for (const name of unset) vi.stubEnv(name, "");
  vi.stubEnv("APEX_PAID_FALLBACK_ENABLED", "false");
  vi.stubEnv("APEX_REQUEST_CAP_TOTAL", "0");
  vi.stubEnv("APEX_EMERGENCY_REQUEST_CAP_TOTAL", "0");
  vi.stubEnv("APEX_REQUEST_PACING_ENABLED", "false");
  vi.stubEnv("APEX_TOKEN_CAP_TOTAL", "0");
  vi.stubEnv("APEX_TOKEN_PACING_ENABLED", "false");
}

function qwenCatalogModel(): string | undefined {
  return getProviderCatalog().find((p) => p.name === "qwen-dashscope-byok")
    ?.model;
}

beforeEach(() => {
  configureIsolatedRouter();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Qwen routing", () => {
  it("routes qwen-dashscope-byok first, ahead of the free OpenRouter models", () => {
    const order = getProviderOrderForRole("QA");
    expect(order[0]).toBe("qwen-dashscope-byok");
    expect(order[1]).toBe("openrouter-nex-n2-5-mini-free");
    expect(order.slice(1, 4)).toEqual([
      "openrouter-nex-n2-5-mini-free",
      "openrouter-nex-n2-5-pro-free",
      "openrouter-nemotron-super",
    ]);
  });

  it("defaults the model to qwen3.8-flash", () => {
    expect(qwenCatalogModel()).toBe("qwen3.8-flash");
  });

  it("uses QWEN_MODEL when set and ignores blank values", () => {
    vi.stubEnv("QWEN_MODEL", "  qwen3.7-flash  ");
    expect(qwenCatalogModel()).toBe("qwen3.7-flash");

    vi.stubEnv("QWEN_MODEL", "   ");
    expect(qwenCatalogModel()).toBe("qwen3.8-flash");
  });

  it("sends the QWEN_MODEL override to the default pay-as-you-go host and reports it", async () => {
    vi.stubEnv("APEX_QWEN_BYOK_ENABLED", "true");
    vi.stubEnv("QWEN_API_KEY", QWEN_KEY);
    vi.stubEnv("QWEN_MODEL", "qwen3.7-flash");

    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({
          url: String(url),
          body: JSON.parse(String(init?.body ?? "{}")),
        });
        return new Response(
          JSON.stringify({
            model: "qwen3.7-flash",
            choices: [{ message: { content: "qwen served the request" } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );

    const client = createLLMClient({ role: "QA", maxTokens: 256 });
    const result = await client.complete([{ role: "user", content: "hello" }]);

    expect(result.content).toBe("qwen served the request");
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(
      "https://maas.qwencloudapi.com/compatible-mode/v1/chat/completions",
    );
    expect(requests[0].body.model).toBe("qwen3.7-flash");
    expect(result.model).toBe("qwen-dashscope-byok/qwen3.7-flash");
    expect(result.requestedModels).toEqual(["qwen3.7-flash"]);
  });
});
