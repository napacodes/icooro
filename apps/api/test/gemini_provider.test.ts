/**
 * C6.7.2.2 — Google Gemini provider adapter tests.
 *
 * Scope: the Gemini *text* adapter only (generateContent). All requests run
 * through an injected `fetchFn` — `globalThis.fetch` is additionally replaced
 * by a tripwire so that ANY attempt to reach the real Gemini/Google API (or
 * any other host) makes the test fail loudly rather than silently succeeding.
 *
 * The adapter is always constructed with `fetchFn` already injected — the
 * fetch-capture-before-construction pitfall cannot arise, and the tripwire
 * below would catch it if it did.
 */

process.env.ICOORO_API_DISABLE_LISTENER = "1";
process.env.NODE_ENV = "test";

import test from "node:test";
import assert from "node:assert/strict";

import { GeminiTextProvider } from "../src/providers/gemini.js";
import {
  ProviderAuthError,
  ProviderError,
  ProviderNetworkError,
  ProviderResponseError,
  getAdapterFactory,
  isConfigurableAdapterType,
} from "../src/providers/index.js";
import { providerSecretStore } from "../src/providers/secrets.js";

const API_KEY = "AIzaSyTestGeminiKey0123456789abcdefghi";
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

function geminiOkResponse(text: string, usage?: Record<string, unknown>): unknown {
  return {
    candidates: [
      {
        content: { parts: [{ text }], role: "model" },
        finishReason: "STOP",
      },
    ],
    ...(usage ? { usageMetadata: usage } : {}),
  };
}

/**
 * Builds an adapter whose transport is fully controlled by the test. Every
 * request is captured; the responder decides what comes back.
 */
function makeAdapter(
  responder: (captured: CapturedRequest) => Response,
  options: Partial<{ baseUrl: string; apiKey: string; defaultModelId: string }> = {},
): { provider: GeminiTextProvider; requests: CapturedRequest[] } {
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
  const provider = new GeminiTextProvider({
    baseUrl: options.baseUrl ?? "https://generativelanguage.test/v1beta",
    apiKey: options.apiKey ?? API_KEY,
    defaultModelId: options.defaultModelId ?? "gemini-2.0-flash",
    fetchFn,
  });
  return { provider, requests };
}

// ---------------------------------------------------------------------------
// 1–4. Request construction: model, credential, base URL, payload
// ---------------------------------------------------------------------------

test("Gemini adapter - uses the configured model ID (param wins over default)", async () => {
  const { provider, requests } = makeAdapter(() =>
    okJson(geminiOkResponse("ok")),
  );

  await provider.generateText({ prompt: "p", modelId: "gemini-1.5-pro" });
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0]!.url,
    "https://generativelanguage.test/v1beta/models/gemini-1.5-pro:generateContent",
  );

  await provider.generateText({ prompt: "p", modelId: "" });
  assert.equal(
    requests[requests.length - 1]!.url,
    "https://generativelanguage.test/v1beta/models/gemini-2.0-flash:generateContent",
    "an empty modelId falls back to the configured default",
  );
});

test("Gemini adapter - sends the credential in the x-goog-api-key header, never in the URL", async () => {
  const { provider, requests } = makeAdapter(() =>
    okJson(geminiOkResponse("ok")),
  );

  await provider.generateText({ prompt: "p", modelId: "gemini-2.0-flash" });

  const headers = requests[0]!.init.headers as Record<string, string>;
  assert.equal(headers["x-goog-api-key"], API_KEY);
  assert.equal(headers["Content-Type"], "application/json");
  assert.ok(!requests[0]!.url.includes(API_KEY), "the credential must never appear in the URL");
  assert.ok(!requests[0]!.url.includes("key="), "no key= query parameter may be used");
});

test("Gemini adapter - respects the configured base URL (path + trailing slash)", async () => {
  const cases = [
    "https://gemini-proxy.internal.test/v1beta",
    "https://gemini-proxy.internal.test/v1beta/",
  ];
  for (const baseUrl of cases) {
    const { provider, requests } = makeAdapter(() => okJson(geminiOkResponse("ok")), {
      baseUrl,
    });
    await provider.generateText({ prompt: "p", modelId: "gemini-2.0-flash" });
    assert.equal(
      requests[0]!.url,
      "https://gemini-proxy.internal.test/v1beta/models/gemini-2.0-flash:generateContent",
      `base URL "${baseUrl}" must join onto /models/{model}:generateContent`,
    );
  }
});

test("Gemini adapter - request payload is the Gemini generateContent shape", async () => {
  const { provider, requests } = makeAdapter(() => okJson(geminiOkResponse("ok")));

  await provider.generateText({
    prompt: "Write a haiku about video editing",
    modelId: "gemini-2.0-flash",
    systemPrompt: "You are concise.",
  });

  assert.equal(requests[0]!.init.method, "POST");
  const body = requests[0]!.body as {
    contents: Array<{ role: string; parts: Array<{ text: string }> }>;
    systemInstruction?: { parts: Array<{ text: string }> };
    generationConfig?: Record<string, unknown>;
  };
  assert.deepEqual(body.contents, [
    {
      role: "user",
      parts: [{ text: "Write a haiku about video editing" }],
    },
  ]);
  assert.deepEqual(body.systemInstruction, {
    parts: [{ text: "You are concise." }],
  });
  assert.equal(body.generationConfig, undefined);
});

test("Gemini adapter - omitting the system prompt sends no systemInstruction", async () => {
  const { provider, requests } = makeAdapter(() => okJson(geminiOkResponse("ok")));

  await provider.generateText({ prompt: "p", modelId: "m" });
  const body = requests[0]!.body as { systemInstruction?: unknown };
  assert.equal(body.systemInstruction, undefined);
});

// ---------------------------------------------------------------------------
// 5–6. Successful response -> normalized Icooro result + token metadata
// ---------------------------------------------------------------------------

test("Gemini adapter - successful response normalizes to the Icooro result shape", async () => {
  const { provider } = makeAdapter(() =>
    okJson(
      geminiOkResponse("A crisp cut.", {
        promptTokenCount: 11,
        candidatesTokenCount: 6,
        totalTokenCount: 17,
      }),
    ),
  );

  const result = await provider.generateText({ prompt: "p", modelId: "gemini-2.0-flash" });

  assert.equal(result.text, "A crisp cut.");
  assert.equal(result.metadata?.provider, "google_gemini");
  assert.equal(result.metadata?.model, "gemini-2.0-flash");
  assert.equal(result.metadata?.promptTokens, 11);
  assert.equal(result.metadata?.completionTokens, 6);
  assert.equal(result.metadata?.totalTokens, 17);

  // No Gemini-specific object leaves the adapter: only { text, metadata }.
  assert.deepEqual(Object.keys(result), ["text", "metadata"]);
});

test("Gemini adapter - token metadata is handled safely when present and omitted when absent", async () => {
  // With usage.
  const withUsage = makeAdapter(() =>
    okJson(
      geminiOkResponse("ok", {
        promptTokenCount: 3,
        candidatesTokenCount: 2,
        totalTokenCount: 5,
      }),
    ),
  );
  const used = await withUsage.provider.generateText({ prompt: "p", modelId: "m" });
  assert.equal(used.metadata?.promptTokens, 3);
  assert.equal(used.metadata?.completionTokens, 2);
  assert.equal(used.metadata?.totalTokens, 5);

  // Without usage — metadata must not require fields Gemini may omit.
  const noUsage = makeAdapter(() => okJson(geminiOkResponse("ok")));
  const unused = await noUsage.provider.generateText({ prompt: "p", modelId: "m" });
  assert.equal(unused.metadata?.promptTokens, undefined);
  assert.equal(unused.metadata?.completionTokens, undefined);
  assert.equal(unused.metadata?.totalTokens, undefined);
  assert.ok(unused.metadata?.provider, "base metadata is still present");

  // Malformed usage values are dropped, not propagated.
  const badUsage = makeAdapter(() =>
    okJson(geminiOkResponse("ok", {
      promptTokenCount: "lots",
      candidatesTokenCount: Number.NaN,
      totalTokenCount: 9,
    })),
  );
  const weird = await badUsage.provider.generateText({ prompt: "p", modelId: "m" });
  assert.equal(weird.metadata?.promptTokens, undefined);
  assert.equal(weird.metadata?.completionTokens, undefined);
  assert.equal(weird.metadata?.totalTokens, 9);

  // Multi-part text is concatenated into one string.
  const multiPart = makeAdapter(() =>
    okJson({
      candidates: [
        {
          content: { parts: [{ text: "alpha " }, { text: "beta" }], role: "model" },
          finishReason: "STOP",
        },
      ],
    }),
  );
  const joined = await multiPart.provider.generateText({ prompt: "p", modelId: "m" });
  assert.equal(joined.text, "alpha beta");
});

// ---------------------------------------------------------------------------
// 7. Error normalization (auth / rate limit / server errors)
// ---------------------------------------------------------------------------

test("Gemini adapter - error responses normalize to ProviderError subclasses", async () => {
  const cases: Array<{
    status: number;
    payload: unknown;
    expected: new (...args: never[]) => ProviderError;
    messagePattern: RegExp;
  }> = [
    {
      status: 401,
      payload: { error: { code: 401, message: "API key not valid", status: "INVALID_ARGUMENT" } },
      expected: ProviderAuthError,
      messagePattern: /API key not valid/,
    },
    {
      status: 403,
      payload: { error: { code: 403, message: "Permission denied" } },
      expected: ProviderAuthError,
      messagePattern: /Permission denied/,
    },
    {
      status: 429,
      payload: { error: { code: 429, message: "Resource exhausted", status: "RESOURCE_EXHAUSTED" } },
      expected: ProviderError,
      messagePattern: /rate limited \(HTTP 429\)/,
    },
    {
      status: 500,
      payload: { error: { code: 500, message: "Internal error" } },
      expected: ProviderResponseError,
      messagePattern: /Internal error/,
    },
    {
      status: 502,
      payload: "<html>Bad Gateway</html>",
      expected: ProviderResponseError,
      messagePattern: /HTTP 502/,
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
        assert.ok(
          tc.messagePattern.test(err.message),
          `HTTP ${tc.status}: unexpected message "${err.message}"`,
        );
        assert.equal(err.provider, "google_gemini");
        return true;
      },
    );
  }
});

// ---------------------------------------------------------------------------
// 8. Malformed / missing responses
// ---------------------------------------------------------------------------

test("Gemini adapter - malformed and missing-text responses become ProviderResponseError", async () => {
  // Broken JSON on HTTP 200.
  const broken = makeAdapter(
    () => new Response("<html>not json</html>", { status: 200, headers: { "content-type": "text/html" } }),
  );
  await assert.rejects(
    () => broken.provider.generateText({ prompt: "p", modelId: "m" }),
    (err: unknown) => {
      assert.ok(err instanceof ProviderResponseError);
      assert.match(err.message, /Invalid JSON response from Gemini completion/);
      return true;
    },
  );

  // No candidates at all.
  const noCandidates = makeAdapter(() => okJson({}));
  await assert.rejects(
    () => noCandidates.provider.generateText({ prompt: "p", modelId: "m" }),
    (err: unknown) => {
      assert.ok(err instanceof ProviderResponseError);
      assert.match(err.message, /did not contain any generated text/);
      return true;
    },
  );

  // Candidate without content parts.
  const noParts = makeAdapter(() => okJson({ candidates: [{ finishReason: "STOP" }] }));
  await assert.rejects(
    () => noParts.provider.generateText({ prompt: "p", modelId: "m" }),
    (err: unknown) => {
      assert.ok(err instanceof ProviderResponseError);
      assert.match(err.message, /did not contain any generated text/);
      return true;
    },
  );

  // Empty text is treated as missing.
  const emptyText = makeAdapter(() => okJson(geminiOkResponse("")));
  await assert.rejects(
    () => emptyText.provider.generateText({ prompt: "p", modelId: "m" }),
    (err: unknown) => {
      assert.ok(err instanceof ProviderResponseError);
      assert.match(err.message, /did not contain any generated text/);
      return true;
    },
  );

  // Safety block is reported explicitly, not as a generic failure.
  const blocked = makeAdapter(() =>
    okJson({
      candidates: [{ finishReason: "SAFETY" }],
      promptFeedback: { blockReason: "SAFETY" },
    }),
  );
  await assert.rejects(
    () => blocked.provider.generateText({ prompt: "p", modelId: "m" }),
    (err: unknown) => {
      assert.ok(err instanceof ProviderResponseError);
      assert.match(err.message, /blocked.*safety/i);
      return true;
    },
  );

  // A missing key is reported without ever contacting the network.
  const keyless = new GeminiTextProvider({
    baseUrl: "https://generativelanguage.test/v1beta",
    apiKey: "",
    fetchFn: async () => {
      throw new Error("must not be called");
    },
  });
  await assert.rejects(
    () => keyless.generateText({ prompt: "p", modelId: "m" }),
    (err: unknown) => {
      assert.ok(err instanceof ProviderAuthError);
      assert.match(err.message, /not configured/i);
      return true;
    },
  );
});

test("Gemini adapter - transport failures become ProviderNetworkError", async () => {
  const fetchFn: typeof fetch = async () => {
    throw new TypeError("fetch failed: connect ECONNREFUSED 127.0.0.1:443");
  };
  const provider = new GeminiTextProvider({
    baseUrl: "https://generativelanguage.test/v1beta",
    apiKey: API_KEY,
    fetchFn,
  });

  await assert.rejects(
    () => provider.generateText({ prompt: "p", modelId: "m" }),
    (err: unknown) => {
      assert.ok(err instanceof ProviderNetworkError);
      assert.match(err.message, /Failed to connect to Gemini/);
      assert.equal(err.provider, "google_gemini");
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// 9. Credential hygiene in errors
// ---------------------------------------------------------------------------

test("Gemini adapter - the credential never appears in any error", async () => {
  const errorBodies: Array<Error> = [];

  // Provider error body that tries to echo the key.
  const echo = makeAdapter(
    () =>
      new Response(
        JSON.stringify({
          error: { code: 400, message: `API key not valid. Please pass a valid API key. (${API_KEY})` },
        }),
        { status: 400 },
      ),
  );
  try {
    await echo.provider.generateText({ prompt: "p", modelId: "m" });
    assert.fail("expected rejection");
  } catch (err) {
    errorBodies.push(err as Error);
  }

  // Non-JSON gateway body that echoes header-style credentials.
  const gateway = makeAdapter(
    () =>
      new Response(
        `Upstream error: x-goog-api-key: ${API_KEY} (AIzaSyREALKEY1234567890abcdef) key=${API_KEY}`,
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
    throw new TypeError(`fetch failed: invalid header value for x-goog-api-key: ${API_KEY}`);
  };
  const leaky = new GeminiTextProvider({
    baseUrl: "https://generativelanguage.test/v1beta",
    apiKey: API_KEY,
    fetchFn: leakyFetch,
  });
  try {
    await leaky.generateText({ prompt: "p", modelId: "m" });
    assert.fail("expected rejection");
  } catch (err) {
    errorBodies.push(err as Error);
  }

  for (const err of errorBodies) {
    const serialized = `${err.name}: ${err.message}`;
    assert.ok(!serialized.includes(API_KEY), `error leaked the credential: "${serialized}"`);
    assert.ok(!/AIza[0-9A-Za-z\-_]{20,}/.test(serialized), `error leaked a key-shaped token: "${serialized}"`);
  }
});

// ---------------------------------------------------------------------------
// 10. Factory integration + zero real network calls
// ---------------------------------------------------------------------------

test("Gemini adapter - is registered as a configurable factory adapter type", () => {
  assert.ok(isConfigurableAdapterType("google_gemini"));
  const factory = getAdapterFactory("google_gemini");
  assert.ok(factory, "google_gemini must have a registered factory");
  const instance = factory({ apiKey: "k", fetchFn: async () => okJson({ models: [] }) });
  assert.equal(instance.providerType, "google_gemini");
  assert.deepEqual([...instance.capabilities], ["text"]);
});

test("Gemini adapter - factory builds a record-configured provider from a sealed key", async () => {
  const record = {
    providerType: "google_gemini",
    baseUrl: "https://record-gemini.test/v1beta",
    apiKeySecret: SECRET_ENVELOPE,
  };

  const requests: CapturedRequest[] = [];
  const injected: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), init: init ?? {}, body: null });
    return okJson(geminiOkResponse("record ok"));
  };

  const factory = getAdapterFactory("google_gemini")!;
  const configured = factory({
    baseUrl: record.baseUrl,
    apiKey: providerSecretStore.reveal(record.apiKeySecret),
    fetchFn: injected,
  }) as GeminiTextProvider;

  const result = await configured.generateText({ prompt: "p", modelId: "gemini-2.0-flash" });
  assert.equal(result.text, "record ok");
  assert.equal(result.metadata?.provider, "google_gemini");
  assert.equal(
    requests[0]!.url,
    "https://record-gemini.test/v1beta/models/gemini-2.0-flash:generateContent",
  );
  assert.equal(
    (requests[0]!.init.headers as Record<string, string>)["x-goog-api-key"],
    API_KEY,
  );
});

test("Gemini adapter - no real network call was made (tripwire never hit)", async () => {
  assert.equal(
    tripwireHits,
    0,
    "globalThis.fetch must never be used by the Gemini adapter tests",
  );
});
