/**
 * C6.7.2.1 — OpenAI provider adapter tests.
 *
 * Scope: the OpenAI *text* adapter only (chat/completions). All requests run
 * through an injected `fetchFn` — `globalThis.fetch` is additionally replaced
 * by a tripwire so that ANY attempt to reach the real OpenAI API (or any
 * other host) makes the test fail loudly rather than silently succeeding.
 *
 * The adapter is always constructed with `fetchFn` already injected — the
 * fetch-capture-before-construction pitfall called out in the task does not
 * arise, and the tripwire below would catch it if it did.
 */

process.env.ICOORO_API_DISABLE_LISTENER = "1";
process.env.NODE_ENV = "test";

import test from "node:test";
import assert from "node:assert/strict";

import { OpenAITextProvider } from "../src/providers/openai.js";
import {
  ProviderAuthError,
  ProviderError,
  ProviderNetworkError,
  ProviderResponseError,
  getAdapterFactory,
  isConfigurableAdapterType,
  resolveTextProvider,
  adapterConfigFromRecord,
} from "../src/providers/index.js";
import { providerSecretStore } from "../src/providers/secrets.js";

const API_KEY = "sk-test-openai-abcdef0123456789";
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

/**
 * Builds an adapter whose transport is fully controlled by the test. Every
 * request is captured; the responder decides what comes back.
 */
function makeAdapter(
  responder: (captured: CapturedRequest) => Response,
  options: Partial<{
    baseUrl: string;
    apiKey: string;
    defaultModelId: string;
  }> = {},
): { provider: OpenAITextProvider; requests: CapturedRequest[] } {
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
  const provider = new OpenAITextProvider({
    baseUrl: options.baseUrl ?? "https://api.openai.test/v1",
    apiKey: options.apiKey ?? API_KEY,
    defaultModelId: options.defaultModelId ?? "gpt-4o-mini",
    fetchFn,
  });
  return { provider, requests };
}

// ---------------------------------------------------------------------------
// 1–4. Request construction: auth, base URL, model, payload
// ---------------------------------------------------------------------------

test("OpenAI adapter - sends the API key as a Bearer Authorization header", async () => {
  const { provider, requests } = makeAdapter(() => okJson({
    choices: [{ message: { role: "assistant", content: "hello" } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }));

  await provider.generateText({ prompt: "hi", modelId: "gpt-4o-mini" });

  assert.equal(requests.length, 1);
  const headers = requests[0]!.init.headers as Record<string, string>;
  assert.equal(headers["Authorization"], `Bearer ${API_KEY}`);
  assert.equal(headers["Content-Type"], "application/json");
});

test("OpenAI adapter - respects the configured base URL (path + trailing slash)", async () => {
  const cases = [
    "https://gateway.internal.test/openai/v1",
    "https://gateway.internal.test/openai/v1/",
  ];
  for (const baseUrl of cases) {
    const { provider, requests } = makeAdapter(
      () => okJson({ choices: [{ message: { content: "ok" } }] }),
      { baseUrl },
    );
    await provider.generateText({ prompt: "p", modelId: "m" });
    assert.equal(
      requests[0]!.url,
      "https://gateway.internal.test/openai/v1/chat/completions",
      `base URL "${baseUrl}" must join onto /chat/completions`,
    );
  }
});

test("OpenAI adapter - sends the configured model ID (param wins over default)", async () => {
  const { provider, requests } = makeAdapter(
    () => okJson({ choices: [{ message: { content: "ok" } }] }),
    { defaultModelId: "gpt-4o-mini" },
  );

  await provider.generateText({ prompt: "p", modelId: "gpt-4.1-turbo" });
  assert.equal((requests[0]!.body as { model: string }).model, "gpt-4.1-turbo");

  await provider.generateText({ prompt: "p", modelId: "" });
  assert.equal((requests[requests.length - 1]!.body as { model: string }).model, "gpt-4o-mini");
});

test("OpenAI adapter - request payload is the OpenAI chat completions shape", async () => {
  const { provider, requests } = makeAdapter(
    () => okJson({ choices: [{ message: { content: "ok" } }] }),
  );

  await provider.generateText({
    prompt: "Write a haiku about video editing",
    modelId: "gpt-4o-mini",
    systemPrompt: "You are concise.",
  });

  assert.equal(requests[0]!.init.method, "POST");
  assert.equal(requests[0]!.url, "https://api.openai.test/v1/chat/completions");
  const body = requests[0]!.body as {
    model: string;
    messages: Array<{ role: string; content: string }>;
  };
  assert.equal(body.model, "gpt-4o-mini");
  assert.deepEqual(body.messages, [
    { role: "system", content: "You are concise." },
    { role: "user", content: "Write a haiku about video editing" },
  ]);
});

test("OpenAI adapter - omitting the system prompt sends only the user message", async () => {
  const { provider, requests } = makeAdapter(
    () => okJson({ choices: [{ message: { content: "ok" } }] }),
  );

  await provider.generateText({ prompt: "p", modelId: "m" });
  const body = requests[0]!.body as { messages: Array<{ role: string }> };
  assert.deepEqual(
    body.messages.map((m) => m.role),
    ["user"],
  );
});

// ---------------------------------------------------------------------------
// 5. Successful response -> normalized Icooro result
// ---------------------------------------------------------------------------

test("OpenAI adapter - successful response normalizes to the Icooro result shape", async () => {
  const { provider } = makeAdapter(() =>
    okJson({
      id: "chatcmpl-123",
      object: "chat.completion",
      model: "gpt-4o-mini",
      choices: [{ index: 0, message: { role: "assistant", content: "A crisp cut." } }],
      usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
    }),
  );

  const result = await provider.generateText({ prompt: "p", modelId: "gpt-4o-mini" });

  assert.equal(result.text, "A crisp cut.");
  assert.equal(result.metadata?.provider, "openai");
  assert.equal(result.metadata?.model, "gpt-4o-mini");
  assert.equal(result.metadata?.promptTokens, 12);
  assert.equal(result.metadata?.completionTokens, 5);
  assert.equal(result.metadata?.totalTokens, 17);

  // The OpenAI-specific objects (`choices`, the raw response) never leave
  // the adapter: only { text, metadata } is exposed.
  assert.deepEqual(Object.keys(result), ["text", "metadata"]);
  const metadataKeys = Object.keys(result.metadata ?? {}).sort();
  assert.deepEqual(
    metadataKeys,
    ["completionTokens", "model", "promptTokens", "provider", "totalTokens"],
  );
});

// ---------------------------------------------------------------------------
// 6–7. Error normalization + credential hygiene
// ---------------------------------------------------------------------------

test("OpenAI adapter - provider error responses normalize to ProviderError subclasses", async () => {
  const cases: Array<{
    status: number;
    payload: unknown;
    expected: new (...args: never[]) => ProviderError;
    messagePattern: RegExp;
  }> = [
    {
      status: 401,
      payload: { error: { message: "Invalid API key provided", type: "invalid_request_error" } },
      expected: ProviderAuthError,
      messagePattern: /Invalid API key provided/,
    },
    {
      status: 403,
      payload: { error: { message: "Not allowed" } },
      expected: ProviderAuthError,
      messagePattern: /Not allowed/,
    },
    {
      status: 429,
      payload: { error: { message: "Rate limit reached" } },
      expected: ProviderError,
      messagePattern: /rate limited \(HTTP 429\)/,
    },
    {
      status: 500,
      payload: { error: { message: "The server had an error" } },
      expected: ProviderResponseError,
      messagePattern: /The server had an error/,
    },
    {
      status: 503,
      payload: "<html>503 Service Unavailable</html>",
      expected: ProviderResponseError,
      messagePattern: /HTTP 503/,
    },
  ];

  for (const tc of cases) {
    const { provider } = makeAdapter(
      () =>
        new Response(typeof tc.payload === "string" ? tc.payload : JSON.stringify(tc.payload), {
          status: tc.status,
          headers: { "content-type": "application/json" },
        }),
    );
    await assert.rejects(
      () => provider.generateText({ prompt: "p", modelId: "m" }),
      (err: unknown) => {
        assert.ok(err instanceof tc.expected, `HTTP ${tc.status}: wrong error class`);
        assert.ok(tc.messagePattern.test(err.message), `HTTP ${tc.status}: unexpected message "${err.message}"`);
        assert.equal(err.provider, "openai");
        return true;
      },
    );
  }
});

test("OpenAI adapter - malformed and empty-choices responses become ProviderResponseError", async () => {
  // Broken JSON on HTTP 200.
  const broken = makeAdapter(
    () => new Response("<html>not json</html>", { status: 200, headers: { "content-type": "text/html" } }),
  );
  await assert.rejects(
    () => broken.provider.generateText({ prompt: "p", modelId: "m" }),
    (err: unknown) => {
      assert.ok(err instanceof ProviderResponseError);
      assert.match(err.message, /Invalid JSON response from OpenAI completion/);
      return true;
    },
  );

  // No choices at all.
  const noChoices = makeAdapter(() => okJson({ id: "chatcmpl-x", choices: [] }));
  await assert.rejects(
    () => noChoices.provider.generateText({ prompt: "p", modelId: "m" }),
    (err: unknown) => {
      assert.ok(err instanceof ProviderResponseError);
      assert.match(err.message, /did not contain any choices/);
      return true;
    },
  );

  // Choice without message content.
  const noContent = makeAdapter(() => okJson({ choices: [{ index: 0 }] }));
  await assert.rejects(
    () => noContent.provider.generateText({ prompt: "p", modelId: "m" }),
    (err: unknown) => {
      assert.ok(err instanceof ProviderResponseError);
      assert.match(err.message, /did not contain message content/);
      return true;
    },
  );
});

test("OpenAI adapter - transport failures become ProviderNetworkError", async () => {
  const fetchFn: typeof fetch = async () => {
    throw new TypeError("fetch failed: connect ECONNREFUSED 127.0.0.1:443");
  };
  const provider = new OpenAITextProvider({
    baseUrl: "https://api.openai.test/v1",
    apiKey: API_KEY,
    fetchFn,
  });

  await assert.rejects(
    () => provider.generateText({ prompt: "p", modelId: "m" }),
    (err: unknown) => {
      assert.ok(err instanceof ProviderNetworkError);
      assert.match(err.message, /Failed to connect to OpenAI/);
      assert.equal(err.provider, "openai");
      return true;
    },
  );
});

test("OpenAI adapter - the API key never appears in any error", async () => {
  const errorBodies: Array<Error> = [];

  // Provider error body that tries to echo the key.
  const echo = makeAdapter(
    () =>
      new Response(
        JSON.stringify({
          error: {
            message: `Invalid API key provided: ${API_KEY}`,
            type: "invalid_request_error",
          },
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

  // Network error constructed from an exception message mentioning the key.
  const leakyFetch: typeof fetch = async () => {
    throw new TypeError(`fetch failed: invalid URL for Bearer ${API_KEY}`);
  };
  const leaky = new OpenAITextProvider({
    baseUrl: "https://api.openai.test/v1",
    apiKey: API_KEY,
    fetchFn: leakyFetch,
  });
  try {
    await leaky.generateText({ prompt: "p", modelId: "m" });
    assert.fail("expected rejection");
  } catch (err) {
    errorBodies.push(err as Error);
  }

  // A missing key is reported without ever showing anything sensitive.
  const keyless = new OpenAITextProvider({
    baseUrl: "https://api.openai.test/v1",
    apiKey: "",
    fetchFn: async () => okJson({ choices: [] }),
  });
  try {
    await keyless.generateText({ prompt: "p", modelId: "m" });
    assert.fail("expected rejection");
  } catch (err) {
    errorBodies.push(err as Error);
  }

  for (const err of errorBodies) {
    const serialized = `${err.name}: ${err.message}`;
    assert.ok(
      !serialized.includes(API_KEY),
      `error leaked the API key: "${serialized}"`,
    );
  }
});

test("OpenAI adapter - non-JSON error body snippets are credential-redacted", async () => {
  const { provider } = makeAdapter(
    () =>
      new Response(
        `Gateway error: Authorization: Bearer ${API_KEY} (sk-0123456789abcdef) api_key=${API_KEY}`,
        { status: 502 },
      ),
  );

  await assert.rejects(
    () => provider.generateText({ prompt: "p", modelId: "m" }),
    (err: unknown) => {
      assert.ok(err instanceof ProviderResponseError);
      const msg = err.message;
      assert.ok(!msg.includes(API_KEY), `error leaked the API key: "${msg}"`);
      assert.ok(!/Bearer\s+sk-/.test(msg), `error leaked a bearer token: "${msg}"`);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// 8. Factory integration + transport injection (no real network anywhere)
// ---------------------------------------------------------------------------

test("OpenAI adapter - is registered as a configurable factory adapter type", () => {
  assert.ok(isConfigurableAdapterType("openai"));
  const factory = getAdapterFactory("openai");
  assert.ok(factory, "openai must have a registered factory");
  const instance = factory({ apiKey: "k", fetchFn: async () => okJson({ choices: [] }) });
  assert.equal(instance.providerType, "openai");
  assert.deepEqual([...instance.capabilities], ["text"]);
});

test("OpenAI adapter - factory resolves a record-configured text provider", async () => {
  const record = {
    providerType: "openai",
    baseUrl: "https://record-configured.test/v1",
    apiKeySecret: SECRET_ENVELOPE,
  };

  const config = adapterConfigFromRecord(record);
  assert.equal(config.apiKey, API_KEY, "the record's sealed key must be unsealed for the adapter");
  assert.equal(config.baseUrl, "https://record-configured.test/v1");

  const requests: CapturedRequest[] = [];
  const injected: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), init: init ?? {}, body: null });
    return okJson({ choices: [{ message: { content: "record ok" } }] });
  };

  const provider = resolveTextProvider({ ...record, fetchFn: injected });
  assert.ok(provider, "an openai record must resolve a text provider");
  assert.equal(provider!.providerType, "openai");

  // resolveTextProvider does not forward fetchFn (the record type has no
  // such field) — build via the factory with the injected transport for the
  // network-touching assertion.
  const factory = getAdapterFactory("openai")!;
  const configured = factory({ ...config, fetchFn: injected });
  const result = await (configured as OpenAITextProvider).generateText({
    prompt: "p",
    modelId: "gpt-4o-mini",
  });

  assert.equal(result.text, "record ok");
  assert.equal(requests[0]!.url, "https://record-configured.test/v1/chat/completions");
  assert.equal(
    (requests[0]!.init.headers as Record<string, string>)["Authorization"],
    `Bearer ${API_KEY}`,
  );
});

test("OpenAI adapter - capability discipline: text only, no image/video/audio claims", () => {
  const { provider } = makeAdapter(() => okJson({ choices: [] }));
  assert.deepEqual([...provider.capabilities], ["text"]);
  // And via the descriptor the rest of the app sees.
  assert.equal(isConfigurableAdapterType("openai"), true);
});

test("OpenAI adapter - testConnection probes /models with the key in headers only", async () => {
  const { provider, requests } = makeAdapter(() => okJson({ data: [] }));
  const result = await provider.testConnection();
  assert.equal(result.ok, true);
  assert.equal(requests[0]!.url, "https://api.openai.test/v1/models");
  assert.equal(
    (requests[0]!.init.headers as Record<string, string>)["Authorization"],
    `Bearer ${API_KEY}`,
  );

  const unreachable = new OpenAITextProvider({
    baseUrl: "https://api.openai.test/v1",
    apiKey: API_KEY,
    fetchFn: async () => {
      throw new TypeError("fetch failed");
    },
  });
  const down = await unreachable.testConnection();
  assert.equal(down.ok, false);
  assert.match(down.message ?? "", /unreachable/);
});

test("OpenAI adapter - no real network call was made (tripwire never hit)", async () => {
  assert.equal(
    tripwireHits,
    0,
    "globalThis.fetch must never be used by the OpenAI adapter tests",
  );
});
