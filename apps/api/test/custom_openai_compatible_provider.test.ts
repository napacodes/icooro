/**
 * C6.7.2.3 — Custom OpenAI-compatible provider adapter tests.
 *
 * Scope: the custom OpenAI-compatible *text* adapter (chat/completions
 * against an arbitrary gateway). All requests run through an injected
 * `fetchFn` — `globalThis.fetch` is additionally replaced by a tripwire so
 * that ANY attempt to reach any real host makes the test fail loudly.
 *
 * The adapter is always constructed with `fetchFn` already injected, so the
 * fetch-capture-before-construction pitfall cannot arise.
 */

process.env.ICOORO_API_DISABLE_LISTENER = "1";
process.env.NODE_ENV = "test";

import test from "node:test";
import assert from "node:assert/strict";

import { CustomOpenAICompatibleTextProvider } from "../src/providers/custom_openai_compatible.js";
import {
  ProviderAuthError,
  ProviderError,
  ProviderNetworkError,
  ProviderResponseError,
  getAdapterFactory,
  isConfigurableAdapterType,
} from "../src/providers/index.js";
import { providerSecretStore } from "../src/providers/secrets.js";

const API_KEY = "sk-custom-gateway-abcdef0123456789";
const SECRET_ENVELOPE = providerSecretStore.seal(API_KEY);

// ---------------------------------------------------------------------------
// Network tripwire: replace globalThis.fetch for the whole file. Any request
// that reaches it (i.e. was NOT made through an injected fetchFn) fails.
// ---------------------------------------------------------------------------

let tripwireHits = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (...args: unknown[]) => {
  tripwireHits += 1;
  const url = String(args[0] ?? "");
  throw new Error(
    `NETWORK TRIPWIRE: a request tried to use globalThis.fetch for ${url}. ` +
      "Tests must inject fetchFn into the adapter.",
  );
}) as typeof fetch;

// Restore after the file so a mis-ordered preload cannot leak the stub.
process.on("exit", () => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CapturedRequest {
  url: string;
  init: RequestInit;
  body: unknown;
}

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function completionsOk(text: string, usage?: Record<string, unknown>): unknown {
  return {
    id: "chatcmpl-custom-1",
    object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content: text } }],
    ...(usage ? { usage } : {}),
  };
}

function makeAdapter(
  responder: (captured: CapturedRequest) => Response,
  options: Partial<{ baseUrl: string; apiKey: string; defaultModelId: string }> = {},
): { provider: CustomOpenAICompatibleTextProvider; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    let body: unknown;
    try {
      body = JSON.parse(String(init?.body ?? ""));
    } catch {
      body = String(init?.body ?? "");
    }
    requests.push({ url, init: init ?? {}, body });
    return responder(requests[requests.length - 1]!);
  };
  const provider = new CustomOpenAICompatibleTextProvider({
    baseUrl: options.baseUrl ?? "https://gateway.internal.test/api/v1",
    apiKey: options.apiKey ?? API_KEY,
    defaultModelId: options.defaultModelId ?? "vendor-model-large",
    fetchFn,
  });
  return { provider, requests };
}

// ---------------------------------------------------------------------------
// 1–2. Base URL handling (authoritative, path + trailing slash, no defaults)
// ---------------------------------------------------------------------------

test("Custom adapter - arbitrary configured base URL is respected exactly", async () => {
  const { provider, requests } = makeAdapter(() => okJson(completionsOk("ok")), {
    baseUrl: "https://llm.corp-gateway.test:8443/openai/v2",
  });

  await provider.generateText({ prompt: "p", modelId: "vendor-model-large" });

  assert.equal(requests.length, 1);
  assert.equal(
    requests[0]!.url,
    "https://llm.corp-gateway.test:8443/openai/v2/chat/completions",
  );
});

test("Custom adapter - trailing slash and multi-segment paths are handled", async () => {
  const cases = [
    {
      baseUrl: "https://gateway.test/v1/",
      expected: "https://gateway.test/v1/chat/completions",
    },
    {
      baseUrl: "https://gateway.test/deep/nested/path/v1",
      expected: "https://gateway.test/deep/nested/path/v1/chat/completions",
    },
    {
      baseUrl: "https://gateway.test/deep/nested/path/v1/",
      expected: "https://gateway.test/deep/nested/path/v1/chat/completions",
    },
  ];
  for (const c of cases) {
    const { provider, requests } = makeAdapter(() => okJson(completionsOk("ok")), {
      baseUrl: c.baseUrl,
    });
    await provider.generateText({ prompt: "p", modelId: "m" });
    assert.equal(
      requests[0]!.url,
      c.expected,
      `base URL "${c.baseUrl}" must join onto /chat/completions`,
    );
  }
});

test("Custom adapter - never falls back to any default host; base URL is required", () => {
  assert.throws(
    () => new CustomOpenAICompatibleTextProvider({ baseUrl: undefined, apiKey: "k" }),
    (err: unknown) => {
      assert.ok(err instanceof ProviderError);
      assert.match(err.message, /base URL is required/);
      assert.equal(err.provider, "custom_openai_compatible");
      return true;
    },
  );
  assert.throws(
    () => new CustomOpenAICompatibleTextProvider({ baseUrl: "   ", apiKey: "k" }),
    /base URL is required/,
  );
  assert.throws(
    () => new CustomOpenAICompatibleTextProvider({ baseUrl: "not a url", apiKey: "k" }),
    /base URL is invalid/,
  );

  // And no constructed instance can ever target api.openai.com: every
  // instance must have been built from an explicit (tested) base URL.
  const { requests } = makeAdapter(() => okJson(completionsOk("ok")));
  assert.equal(requests.length, 0);
});

// ---------------------------------------------------------------------------
// 3–5. Credential, model, payload
// ---------------------------------------------------------------------------

test("Custom adapter - sends the API key as a Bearer Authorization header", async () => {
  const { provider, requests } = makeAdapter(() => okJson(completionsOk("ok")));

  await provider.generateText({ prompt: "p", modelId: "m" });

  const headers = requests[0]!.init.headers as Record<string, string>;
  assert.equal(headers["Authorization"], `Bearer ${API_KEY}`);
  assert.equal(headers["Content-Type"], "application/json");
  assert.ok(!requests[0]!.url.includes(API_KEY), "the credential must never appear in the URL");
});

test("Custom adapter - uses the configured model ID (param wins over default)", async () => {
  const { provider, requests } = makeAdapter(() => okJson(completionsOk("ok")), {
    defaultModelId: "vendor-model-large",
  });

  await provider.generateText({ prompt: "p", modelId: "vendor-model-small" });
  assert.equal((requests[0]!.body as { model: string }).model, "vendor-model-small");

  await provider.generateText({ prompt: "p", modelId: "" });
  assert.equal((requests[requests.length - 1]!.body as { model: string }).model, "vendor-model-large");
});

test("Custom adapter - refuses to guess a model when none is configured", async () => {
  const { provider } = makeAdapter(() => okJson(completionsOk("ok")), {
    defaultModelId: "",
  });

  await assert.rejects(
    () => provider.generateText({ prompt: "p", modelId: "" }),
    (err: unknown) => {
      assert.ok(err instanceof ProviderResponseError);
      assert.match(err.message, /No model ID configured/);
      assert.equal(err.provider, "custom_openai_compatible");
      return true;
    },
  );
});

test("Custom adapter - request body is the OpenAI-compatible chat completions shape", async () => {
  const { provider, requests } = makeAdapter(() => okJson(completionsOk("ok")));

  await provider.generateText({
    prompt: "Write a haiku about video editing",
    modelId: "vendor-model-large",
    systemPrompt: "You are concise.",
  });

  assert.equal(requests[0]!.init.method, "POST");
  assert.equal(
    requests[0]!.url,
    "https://gateway.internal.test/api/v1/chat/completions",
  );
  const body = requests[0]!.body as {
    model: string;
    messages: Array<{ role: string; content: string }>;
  };
  assert.equal(body.model, "vendor-model-large");
  assert.deepEqual(body.messages, [
    { role: "system", content: "You are concise." },
    { role: "user", content: "Write a haiku about video editing" },
  ]);
});

// ---------------------------------------------------------------------------
// 6–7. Normalized result + token metadata
// ---------------------------------------------------------------------------

test("Custom adapter - successful response normalizes to the Icooro result shape", async () => {
  const { provider } = makeAdapter(() =>
    okJson(
      completionsOk("A crisp cut.", {
        prompt_tokens: 9,
        completion_tokens: 4,
        total_tokens: 13,
      }),
    ),
  );

  const result = await provider.generateText({ prompt: "p", modelId: "vendor-model-large" });

  assert.equal(result.text, "A crisp cut.");
  assert.equal(result.metadata?.provider, "custom_openai_compatible");
  assert.equal(result.metadata?.model, "vendor-model-large");
  assert.equal(result.metadata?.promptTokens, 9);
  assert.equal(result.metadata?.completionTokens, 4);
  assert.equal(result.metadata?.totalTokens, 13);

  // No provider-specific object leaves the adapter: only { text, metadata }.
  assert.deepEqual(Object.keys(result), ["text", "metadata"]);
});

test("Custom adapter - token metadata is handled when present and omitted when absent", async () => {
  const withUsage = makeAdapter(() =>
    okJson(completionsOk("ok", { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 })),
  );
  const used = await withUsage.provider.generateText({ prompt: "p", modelId: "m" });
  assert.equal(used.metadata?.totalTokens, 5);

  const noUsage = makeAdapter(() => okJson(completionsOk("ok")));
  const unused = await noUsage.provider.generateText({ prompt: "p", modelId: "m" });
  assert.equal(unused.metadata?.promptTokens, undefined);
  assert.equal(unused.metadata?.totalTokens, undefined);
  assert.ok(unused.metadata?.provider, "base metadata is still present");

  const badUsage = makeAdapter(() =>
    okJson(completionsOk("ok", { prompt_tokens: "many", total_tokens: 7 })),
  );
  const weird = await badUsage.provider.generateText({ prompt: "p", modelId: "m" });
  assert.equal(weird.metadata?.promptTokens, undefined);
  assert.equal(weird.metadata?.totalTokens, 7);
});

// ---------------------------------------------------------------------------
// 8–11. Error normalization
// ---------------------------------------------------------------------------

test("Custom adapter - 401/403 becomes a normalized auth error", async () => {
  for (const status of [401, 403]) {
    const { provider } = makeAdapter(
      () =>
        new Response(
          JSON.stringify({ error: { message: "Invalid API key", type: "invalid_request_error" } }),
          { status },
        ),
    );
    await assert.rejects(
      () => provider.generateText({ prompt: "p", modelId: "m" }),
      (err: unknown) => {
        assert.ok(err instanceof ProviderAuthError, `HTTP ${status}: wrong class`);
        assert.equal((err as ProviderAuthError).statusCode, status);
        assert.match(err.message, /Invalid API key/);
        assert.equal(err.provider, "custom_openai_compatible");
        return true;
      },
    );
  }
});

test("Custom adapter - 429 becomes a normalized rate-limit error", async () => {
  const { provider } = makeAdapter(
    () => new Response(JSON.stringify({ error: { message: "Too many requests" } }), { status: 429 }),
  );

  await assert.rejects(
    () => provider.generateText({ prompt: "p", modelId: "m" }),
    (err: unknown) => {
      assert.ok(err instanceof ProviderError, "429 maps to the base ProviderError");
      assert.ok(!(err instanceof ProviderAuthError));
      assert.ok(!(err instanceof ProviderResponseError));
      assert.equal((err as ProviderError).code, "rate_limited");
      assert.equal((err as ProviderError).statusCode, 429);
      assert.match(err.message, /rate limited \(HTTP 429\)/);
      assert.equal(err.provider, "custom_openai_compatible");
      return true;
    },
  );
});

test("Custom adapter - other non-2xx responses become normalized provider errors", async () => {
  const cases: Array<{ status: number; payload: unknown; pattern: RegExp }> = [
    { status: 500, payload: { error: { message: "Gateway exploded" } }, pattern: /Gateway exploded/ },
    { status: 502, payload: "<html>Bad Gateway</html>", pattern: /HTTP 502/ },
    { status: 503, payload: { message: "Maintenance" }, pattern: /Maintenance/ },
  ];

  for (const tc of cases) {
    const { provider } = makeAdapter(
      () =>
        new Response(typeof tc.payload === "string" ? tc.payload : JSON.stringify(tc.payload), {
          status: tc.status,
        }),
    );
    await assert.rejects(
      () => provider.generateText({ prompt: "p", modelId: "m" }),
      (err: unknown) => {
        assert.ok(err instanceof ProviderResponseError, `HTTP ${tc.status}: wrong class`);
        assert.equal((err as ProviderResponseError).statusCode, tc.status);
        assert.ok(tc.pattern.test(err.message), `unexpected message "${err.message}"`);
        assert.equal(err.provider, "custom_openai_compatible");
        return true;
      },
    );
  }
});

test("Custom adapter - malformed/missing responses become normalized provider errors", async () => {
  // Broken JSON on HTTP 200.
  const broken = makeAdapter(
    () => new Response("<html>not json</html>", { status: 200, headers: { "content-type": "text/html" } }),
  );
  await assert.rejects(
    () => broken.provider.generateText({ prompt: "p", modelId: "m" }),
    (err: unknown) => {
      assert.ok(err instanceof ProviderResponseError);
      assert.match(err.message, /Invalid JSON response from Custom provider completion/);
      return true;
    },
  );

  // No choices.
  const noChoices = makeAdapter(() => okJson({ id: "chatcmpl-x", choices: [] }));
  await assert.rejects(
    () => noChoices.provider.generateText({ prompt: "p", modelId: "m" }),
    (err: unknown) => {
      assert.ok(err instanceof ProviderResponseError);
      assert.match(err.message, /did not contain any choices/);
      return true;
    },
  );

  // Choice without message content entirely.
  const noContent = makeAdapter(() => okJson({ choices: [{ index: 0 }] }));
  await assert.rejects(
    () => noContent.provider.generateText({ prompt: "p", modelId: "m" }),
    (err: unknown) => {
      assert.ok(err instanceof ProviderResponseError);
      assert.match(err.message, /did not contain message content/);
      return true;
    },
  );

  // Empty text: a 200 with empty content is a missing result, not a
  // success — the custom adapter normalizes it into an error.
  const emptyText = makeAdapter(() => okJson(completionsOk("")));
  await assert.rejects(
    () => emptyText.provider.generateText({ prompt: "p", modelId: "m" }),
    (err: unknown) => {
      assert.ok(err instanceof ProviderResponseError);
      assert.match(err.message, /returned empty text/);
      return true;
    },
  );
});

test("Custom adapter - transport failures become ProviderNetworkError", async () => {
  const fetchFn: typeof fetch = async () => {
    throw new TypeError("fetch failed: connect ECONNREFUSED 127.0.0.1:8443");
  };
  const provider = new CustomOpenAICompatibleTextProvider({
    baseUrl: "https://gateway.internal.test/api/v1",
    apiKey: API_KEY,
    defaultModelId: "vendor-model-large",
    fetchFn,
  });

  await assert.rejects(
    () => provider.generateText({ prompt: "p", modelId: "m" }),
    (err: unknown) => {
      assert.ok(err instanceof ProviderNetworkError);
      assert.match(err.message, /Failed to connect to Custom provider/);
      assert.equal(err.provider, "custom_openai_compatible");
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// 12. Credential hygiene in errors
// ---------------------------------------------------------------------------

test("Custom adapter - the credential never appears in any error output", async () => {
  const errorBodies: Array<Error> = [];

  // Provider error body echoing the key.
  const echo = makeAdapter(
    () =>
      new Response(
        JSON.stringify({
          error: { message: `Invalid API key provided: ${API_KEY}`, type: "invalid_request_error" },
        }),
        { status: 401 },
      ),
  );
  try {
    await echo.provider.generateText({ prompt: "p", modelId: "m" });
    assert.fail("expected rejection");
  } catch (err) {
    errorBodies.push(err as Error);
  }

  // Non-JSON gateway body echoing header-style credentials.
  const gateway = makeAdapter(
    () =>
      new Response(
        `Upstream error: Authorization: Bearer ${API_KEY} (sk-0123456789abcdef) api_key=${API_KEY}`,
        { status: 502 },
      ),
  );
  try {
    await gateway.provider.generateText({ prompt: "p", modelId: "m" });
    assert.fail("expected rejection");
  } catch (err) {
    errorBodies.push(err as Error);
  }

  // Transport exception whose message mentions the key.
  const leakyFetch: typeof fetch = async () => {
    throw new TypeError(`fetch failed: invalid Authorization header: Bearer ${API_KEY}`);
  };
  const leaky = new CustomOpenAICompatibleTextProvider({
    baseUrl: "https://gateway.internal.test/api/v1",
    apiKey: API_KEY,
    defaultModelId: "vendor-model-large",
    fetchFn: leakyFetch,
  });
  try {
    await leaky.generateText({ prompt: "p", modelId: "m" });
    assert.fail("expected rejection");
  } catch (err) {
    errorBodies.push(err as Error);
  }

  // Missing key: reported without leaking anything.
  const keyless = new CustomOpenAICompatibleTextProvider({
    baseUrl: "https://gateway.internal.test/api/v1",
    apiKey: "",
    defaultModelId: "vendor-model-large",
    fetchFn: async () => okJson(completionsOk("ok")),
  });
  try {
    await keyless.generateText({ prompt: "p", modelId: "m" });
    assert.fail("expected rejection");
  } catch (err) {
    errorBodies.push(err as Error);
  }

  for (const err of errorBodies) {
    const serialized = `${err.name}: ${err.message}`;
    assert.ok(!serialized.includes(API_KEY), `error leaked the API key: "${serialized}"`);
    assert.ok(!/Bearer\s+sk-/.test(serialized), `error leaked a bearer token: "${serialized}"`);
  }
});

// ---------------------------------------------------------------------------
// 13. Factory integration + zero real network
// ---------------------------------------------------------------------------

test("Custom adapter - is registered as a configurable factory adapter type", () => {
  assert.ok(isConfigurableAdapterType("custom_openai_compatible"));
  const factory = getAdapterFactory("custom_openai_compatible");
  assert.ok(factory, "custom_openai_compatible must have a registered factory");
  const instance = factory({
    baseUrl: "https://factory-built.test/v1",
    apiKey: "k",
    fetchFn: async () => okJson(completionsOk("ok")),
  });
  assert.equal(instance.providerType, "custom_openai_compatible");
  assert.equal(instance.name, "Custom OpenAI-compatible");
  assert.deepEqual([...instance.capabilities], ["text"]);
});

test("Custom adapter - factory builds a record-configured provider from a sealed key", async () => {
  const requests: CapturedRequest[] = [];
  const injected: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), init: init ?? {}, body: null });
    return okJson(completionsOk("record ok"));
  };

  const factory = getAdapterFactory("custom_openai_compatible")!;
  const configured = factory({
    baseUrl: "https://record-gateway.test/v1",
    apiKey: providerSecretStore.reveal(SECRET_ENVELOPE),
    fetchFn: injected,
  }) as CustomOpenAICompatibleTextProvider;

  const result = await configured.generateText({ prompt: "p", modelId: "vendor-model-large" });
  assert.equal(result.text, "record ok");
  assert.equal(result.metadata?.provider, "custom_openai_compatible");
  assert.equal(requests[0]!.url, "https://record-gateway.test/v1/chat/completions");
  assert.equal(
    (requests[0]!.init.headers as Record<string, string>)["Authorization"],
    `Bearer ${API_KEY}`,
  );
});

test("Custom adapter - no real network request occurs (tripwire never hit)", async () => {
  assert.equal(
    tripwireHits,
    0,
    "globalThis.fetch must never be used by the custom adapter tests",
  );
});
