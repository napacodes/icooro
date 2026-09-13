import test from "node:test";
import assert from "node:assert/strict";
import {
  ChatFireVideoProvider,
  ProviderAuthError,
  ProviderNetworkError,
  ProviderResponseError,
  providerRegistry,
} from "../src/providers/index.js";

// Helper to create a mocked Response
function mockResponse(body: unknown, init?: { status?: number; statusText?: string; headers?: Record<string, string> }): Response {
  const status = init?.status ?? 200;
  const statusText = init?.statusText ?? "OK";
  const headers = new Headers(init?.headers);
  const jsonString = typeof body === "string" ? body : JSON.stringify(body);

  return new Response(jsonString, {
    status,
    statusText,
    headers,
  });
}

test("ChatFireVideoProvider - Scenario 1: Successful generation submission", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;

  const mockFetch: typeof fetch = async (input, init) => {
    capturedUrl = String(input);
    capturedInit = init;
    return mockResponse({
      id: "task-test-12345",
      status: "QUEUED",
      created_at: 1700000000,
    });
  };

  const provider = new ChatFireVideoProvider({
    baseUrl: "https://test.chatfire.site",
    apiKey: "test-api-key-abc",
    fetchFn: mockFetch,
  });

  const result = await provider.createJob({
    prompt: "a cinematic wide shot of a neon city at dusk",
    modelId: "doubao-seedance-2-5-260628",
  });

  assert.equal(capturedUrl, "https://test.chatfire.site/volcengine/api/v3/contents/generations/tasks");
  assert.equal(capturedInit?.method, "POST");

  const headers = capturedInit?.headers as Record<string, string>;
  assert.equal(headers["Authorization"], "Bearer test-api-key-abc");
  assert.equal(headers["Content-Type"], "application/json");

  const sentBody = JSON.parse(String(capturedInit?.body));
  assert.equal(sentBody.model, "doubao-seedance-2-5-260628");
  assert.deepEqual(sentBody.content, [{ type: "text", text: "a cinematic wide shot of a neon city at dusk" }]);

  assert.equal(result.externalJobId, "task-test-12345");
  assert.equal(result.metadata?.provider, "chatfire");
  assert.equal(result.metadata?.model, "doubao-seedance-2-5-260628");
});

test("ChatFireVideoProvider - Scenario 2: Submission response missing task ID", async () => {
  const mockFetch: typeof fetch = async () => {
    return mockResponse({
      message: "success but missing id",
    });
  };

  const provider = new ChatFireVideoProvider({
    baseUrl: "https://test.chatfire.site",
    apiKey: "test-api-key-abc",
    fetchFn: mockFetch,
  });

  await assert.rejects(
    async () => {
      await provider.createJob({
        prompt: "test prompt",
        modelId: "doubao-seedance-2-5-260628",
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof ProviderResponseError);
      assert.match(err.message, /did not contain a valid task ID/i);
      assert.equal(err.provider, "chatfire");
      return true;
    },
  );
});

test("ChatFireVideoProvider - Scenario 3: Authentication/API failure (401/403 and unconfigured key)", async () => {
  // Test 401
  const mockFetch401: typeof fetch = async () => {
    return mockResponse(
      { error: { message: "Invalid authentication token" } },
      { status: 401, statusText: "Unauthorized" },
    );
  };

  const provider401 = new ChatFireVideoProvider({
    baseUrl: "https://test.chatfire.site",
    apiKey: "invalid-key",
    fetchFn: mockFetch401,
  });

  await assert.rejects(
    async () => {
      await provider401.createJob({
        prompt: "test prompt",
        modelId: "doubao-seedance-2-5-260628",
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof ProviderAuthError);
      assert.equal(err.statusCode, 401);
      assert.match(err.message, /Invalid authentication token/i);
      return true;
    },
  );

  // Test 403 on status check
  const mockFetch403: typeof fetch = async () => {
    return mockResponse(
      { message: "Access forbidden" },
      { status: 403, statusText: "Forbidden" },
    );
  };

  const provider403 = new ChatFireVideoProvider({
    baseUrl: "https://test.chatfire.site",
    apiKey: "forbidden-key",
    fetchFn: mockFetch403,
  });

  await assert.rejects(
    async () => {
      await provider403.getJobStatus("task-xyz");
    },
    (err: unknown) => {
      assert.ok(err instanceof ProviderAuthError);
      assert.equal(err.statusCode, 403);
      assert.match(err.message, /Access forbidden/i);
      return true;
    },
  );

  // Test unconfigured key (empty or undefined)
  const providerNoKey = new ChatFireVideoProvider({
    apiKey: "",
    fetchFn: mockFetch401,
  });

  await assert.rejects(
    async () => {
      await providerNoKey.createJob({
        prompt: "test prompt",
        modelId: "doubao-seedance-2-5-260628",
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof ProviderAuthError);
      assert.match(err.message, /not configured/i);
      return true;
    },
  );
});

test("ChatFireVideoProvider - Scenario 4: Successful processing-status response", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;

  const mockFetch: typeof fetch = async (input, init) => {
    capturedUrl = String(input);
    capturedInit = init;
    return mockResponse({
      id: "task-status-123",
      status: "RUNNING",
      progress: 60,
    });
  };

  const provider = new ChatFireVideoProvider({
    baseUrl: "https://test.chatfire.site",
    apiKey: "test-api-key",
    fetchFn: mockFetch,
  });

  const statusResult = await provider.getJobStatus("task-status-123");

  assert.equal(
    capturedUrl,
    "https://test.chatfire.site/volcengine/api/v3/contents/generations/tasks/task-status-123",
  );
  assert.equal(capturedInit?.method, "GET");
  assert.equal(
    (capturedInit?.headers as Record<string, string>)["Authorization"],
    "Bearer test-api-key",
  );

  assert.equal(statusResult.status, "processing");
  assert.equal(statusResult.progress, 60);
  assert.equal(statusResult.metadata?.rawStatus, "RUNNING");
});

test("ChatFireVideoProvider - Scenario 5: Provider processing status mapping", async () => {
  const cases: Array<{ raw: string; expected: "submitted" | "processing" }> = [
    { raw: "QUEUED", expected: "submitted" },
    { raw: "PENDING", expected: "submitted" },
    { raw: "SUBMITTED", expected: "submitted" },
    { raw: "queued", expected: "submitted" },
    { raw: "RUNNING", expected: "processing" },
    { raw: "PROCESSING", expected: "processing" },
    { raw: "running", expected: "processing" },
  ];

  for (const c of cases) {
    const mockFetch: typeof fetch = async () =>
      mockResponse({ id: "task-map", status: c.raw });

    const provider = new ChatFireVideoProvider({
      apiKey: "key",
      fetchFn: mockFetch,
    });

    const res = await provider.getJobStatus("task-map");
    assert.equal(res.status, c.expected, `Expected ${c.raw} to map to ${c.expected}`);
  }
});

test("ChatFireVideoProvider - Scenario 6: Provider succeeded status mapping", async () => {
  const cases = [
    {
      payload: {
        id: "task-succ-1",
        status: "SUCCEEDED",
        content: { video_url: "https://cdn.example.com/videos/output1.mp4" },
      },
      expectedUrl: "https://cdn.example.com/videos/output1.mp4",
    },
    {
      payload: {
        id: "task-succ-2",
        status: "SUCCESS",
        video_url: "https://cdn.example.com/videos/output2.mp4",
      },
      expectedUrl: "https://cdn.example.com/videos/output2.mp4",
    },
    {
      payload: {
        id: "task-succ-3",
        status: "COMPLETED",
        data: { video_url: "https://cdn.example.com/videos/output3.mp4" },
      },
      expectedUrl: "https://cdn.example.com/videos/output3.mp4",
    },
  ];

  for (const c of cases) {
    const mockFetch: typeof fetch = async () => mockResponse(c.payload);
    const provider = new ChatFireVideoProvider({
      apiKey: "key",
      fetchFn: mockFetch,
    });

    const res = await provider.getJobStatus("task-succ");
    assert.equal(res.status, "completed");
    assert.equal(res.resultUrl, c.expectedUrl);
  }
});

test("ChatFireVideoProvider - Scenario 7: Provider failed status mapping", async () => {
  const cases = [
    {
      payload: {
        id: "task-fail-1",
        status: "FAILED",
        error: { message: "Prompt contains unsafe keywords" },
      },
      expectedErr: "Prompt contains unsafe keywords",
    },
    {
      payload: {
        id: "task-fail-2",
        status: "ERROR",
        message: "Internal rendering timeout",
      },
      expectedErr: "Internal rendering timeout",
    },
  ];

  for (const c of cases) {
    const mockFetch: typeof fetch = async () => mockResponse(c.payload);
    const provider = new ChatFireVideoProvider({
      apiKey: "key",
      fetchFn: mockFetch,
    });

    const res = await provider.getJobStatus("task-fail");
    assert.equal(res.status, "failed");
    assert.equal(res.error, c.expectedErr);
  }
});

test("ChatFireVideoProvider - Scenario 8: Malformed or unexpected provider response", async () => {
  // Case A: Broken non-JSON payload from server
  const mockFetchNonJson: typeof fetch = async () =>
    new Response("<html>502 Bad Gateway</html>", {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });

  const providerA = new ChatFireVideoProvider({
    apiKey: "key",
    fetchFn: mockFetchNonJson,
  });

  await assert.rejects(
    async () => {
      await providerA.getJobStatus("task-broken");
    },
    (err: unknown) => {
      assert.ok(err instanceof ProviderResponseError);
      assert.match(err.message, /Invalid JSON response/i);
      return true;
    },
  );

  // Case B: Missing status property entirely
  const mockFetchNoStatus: typeof fetch = async () =>
    mockResponse({ id: "task-xyz", somethingElse: 123 });

  const providerB = new ChatFireVideoProvider({
    apiKey: "key",
    fetchFn: mockFetchNoStatus,
  });

  await assert.rejects(
    async () => {
      await providerB.getJobStatus("task-xyz");
    },
    (err: unknown) => {
      assert.ok(err instanceof ProviderResponseError);
      assert.match(err.message, /did not contain a valid status/i);
      return true;
    },
  );

  // Case C: Unrecognized status string
  const mockFetchUnknownStatus: typeof fetch = async () =>
    mockResponse({ id: "task-xyz", status: "EXPLODED" });

  const providerC = new ChatFireVideoProvider({
    apiKey: "key",
    fetchFn: mockFetchUnknownStatus,
  });

  await assert.rejects(
    async () => {
      await providerC.getJobStatus("task-xyz");
    },
    (err: unknown) => {
      assert.ok(err instanceof ProviderResponseError);
      assert.match(err.message, /Unexpected provider status.*EXPLODED/i);
      return true;
    },
  );
});

test("ChatFireVideoProvider - Scenario 9: Network/request failure", async () => {
  const mockFetchNetworkError: typeof fetch = async () => {
    throw new TypeError("fetch failed: connect ECONNREFUSED 127.0.0.1:443");
  };

  const provider = new ChatFireVideoProvider({
    apiKey: "key",
    fetchFn: mockFetchNetworkError,
  });

  await assert.rejects(
    async () => {
      await provider.createJob({
        prompt: "test",
        modelId: "doubao-seedance-2-5-260628",
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof ProviderNetworkError);
      assert.match(err.message, /Failed to connect to ChatFire API/i);
      assert.equal(err.provider, "chatfire");
      return true;
    },
  );

  await assert.rejects(
    async () => {
      await provider.getJobStatus("task-123");
    },
    (err: unknown) => {
      assert.ok(err instanceof ProviderNetworkError);
      assert.match(err.message, /Failed to query ChatFire task status/i);
      assert.equal(err.provider, "chatfire");
      return true;
    },
  );
});

test("ChatFireVideoProvider - Scenario 10: Configuration loaded from options/env rather than hardcoded", async () => {
  let requestedBase = "";
  const mockFetch: typeof fetch = async (input) => {
    requestedBase = String(input);
    return mockResponse({ id: "task-custom-cfg" });
  };

  const customBase = "https://custom-proxy.internal.icooro.com";
  const customKey = "secret-custom-token-xyz";
  const customModel = "custom-seedance-model-v2";

  const provider = new ChatFireVideoProvider({
    baseUrl: customBase,
    apiKey: customKey,
    defaultModelId: customModel,
    fetchFn: mockFetch,
  });

  await provider.createJob({
    prompt: "custom prompt",
    modelId: customModel,
  });

  assert.ok(requestedBase.startsWith(customBase));

  // Verify Provider Registry integration
  const registered = providerRegistry.getVideoProvider("chatfire");
  assert.ok(registered, "chatfire must be registered in providerRegistry");
  assert.equal(registered.providerType, "chatfire");
  assert.equal(registered.name, "ChatFire Seedance 2.5");
  assert.deepEqual(registered.capabilities, ["video"]);

  // Test provider connection testing
    const connProvider = new ChatFireVideoProvider({
      apiKey: "valid-key",
    });

    const connResult = await connProvider.testConnection();

    assert.equal(connResult.ok, true);
    assert.match(connResult.message ?? "", /configuration is present/i);

    const connProviderNoKey = new ChatFireVideoProvider({
      apiKey: "",
    });

    const connNoKeyResult = await connProviderNoKey.testConnection();

    assert.equal(connNoKeyResult.ok, false);
    assert.match(connNoKeyResult.message ?? "", /not configured/i);

    test("ChatFireVideoProvider - cancellation is unsupported without a documented provider endpoint", async () => {
    let called = false;

    const provider = new ChatFireVideoProvider({
      apiKey: "key",
      fetchFn: async () => {
        called = true;
        throw new Error("fetch should not be called");
      },
    });

    const result = await provider.cancelJob("task-123");

    assert.deepEqual(result, { cancelled: false });
    assert.equal(called, false);
  });

});
