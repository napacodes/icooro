/**
 * Google Gemini provider adapter (C6.7.2.2).
 *
 * Third adapter, built on the C6.7.1 generic provider architecture: the
 * factory (factory.ts) builds a *record-configured* instance from a provider
 * record, and this adapter implements the existing `TextProvider` interface
 * from types.ts. Nothing outside the adapter knows Gemini exists beyond:
 *
 *   - the factory registration in providers/index.ts (one entry),
 *   - the provider-type catalog entry in @icooro/shared (adapterAvailable).
 *
 * Scope for C6.7.2.2 is deliberately TEXT generation only — the
 * `generateContent` endpoint (`POST {baseUrl}/models/{model}:generateContent`).
 * Image/video/audio capabilities are NOT claimed (see the catalog), so the
 * capability layer will never route media jobs to Gemini.
 *
 * Auth: the API key is sent in the `x-goog-api-key` header — the currently
 * documented header-based scheme — so the credential never appears in a URL.
 * (Gemini also historically accepted `?key=` query parameters; this adapter
 * deliberately does not use that scheme, so credential-bearing URLs cannot
 * leak into logs.)
 *
 * Secrets and error hygiene follow the C6.3 rules: the API key is never
 * logged, never attached to an error object, and is redacted from any
 * provider-supplied message before an error is surfaced.
 */

import {
  type TextGenerationParams,
  type TextProvider,
  ProviderAuthError,
  ProviderError,
  ProviderNetworkError,
  ProviderResponseError,
} from "./types.js";

export interface GeminiProviderOptions {
  baseUrl?: string;
  apiKey?: string;
  defaultModelId?: string;
  /** Injectable transport. When omitted, `globalThis.fetch` is used. */
  fetchFn?: typeof fetch;
}

/**
 * Splits "https://host/base" into origin + base path, tolerating a trailing
 * slash, so `{baseUrl}/models/{model}:generateContent` joins correctly
 * regardless of how the admin configured the record.
 */
function splitBaseUrl(baseUrl: string): { origin: string; basePath: string } {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  if (!normalized) {
    throw new ProviderError("Gemini base URL must not be empty", { provider: "google_gemini" });
  }
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new ProviderError(`Gemini base URL is invalid: "${baseUrl}"`, {
      provider: "google_gemini",
    });
  }
  return { origin: parsed.origin, basePath: parsed.pathname.replace(/\/+$/, "") };
}

/**
 * Redacts credential-looking material from free text that ends up in error
 * messages (e.g. non-JSON gateway error bodies). The adapter never places
 * the key in a message itself; this is defence in depth for provider- or
 * proxy-supplied text. Covers the Gemini key shapes (`AIza…`) and generic
 * header/query credential patterns.
 */
function sanitizeCredentialText(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, "Bearer [REDACTED]")
    .replace(/x-goog-api-key\s*[:=]\s*\S+/gi, "x-goog-api-key=[REDACTED]")
    .replace(/(api[-_]?key|authorization|token|secret|password|key)\s*[:=]\s*\S+/gi, "$1=[REDACTED]")
    .replace(/AIza[0-9A-Za-z\-_]{20,}/g, "[REDACTED]")
    .replace(/[?&]key=[^&\s'"]+/gi, "[REDACTED]");
}

/**
 * Extracts a human-readable message from a Gemini error body without ever
 * echoing credential material. Google error payloads look like:
 *
 *   { "error": { "code": 429, "message": "...", "status": "RESOURCE_EXHAUSTED" } }
 *
 * Some gateways return `{ "message": "..." }` instead. Malformed bodies fall
 * back to a generic message; the raw body is never surfaced unredacted.
 */
function extractErrorMessage(data: unknown, fallback: string): string {
  if (data && typeof data === "object") {
    const errorField = (data as { error?: unknown }).error;
    if (typeof errorField === "string" && errorField.trim() !== "") return errorField.trim();
    if (errorField && typeof errorField === "object") {
      const message = (errorField as { message?: unknown }).message;
      if (typeof message === "string" && message.trim() !== "") return message.trim();
    }
    const message = (data as { message?: unknown }).message;
    if (typeof message === "string" && message.trim() !== "") return message.trim();
  }
  return fallback;
}

/** Narrows `unknown` usage fields to finite numbers. */
function normalizeUsageNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Maps a Gemini finish reason / prompt-feedback block to a readable message,
 * or `undefined` when there is nothing actionable. Safety blocks are
 * reported explicitly rather than as a generic "no content" failure.
 */
function blockedReasonMessage(finishReason: unknown, promptFeedback: unknown): string | undefined {
  if (finishReason === "SAFETY" || finishReason === "BLOCKLIST" || finishReason === "PROHIBITED_CONTENT") {
    return "Gemini blocked the response for safety reasons";
  }
  if (
    promptFeedback &&
    typeof promptFeedback === "object" &&
    (promptFeedback as { blockReason?: unknown }).blockReason
  ) {
    const reason = (promptFeedback as { blockReason?: unknown }).blockReason;
    return `Gemini blocked the prompt (${typeof reason === "string" ? reason : "safety filter"})`;
  }
  return undefined;
}

export class GeminiTextProvider implements TextProvider {
  readonly providerType = "google_gemini";
  readonly name = "Google Gemini";
  readonly capabilities = ["text"] as const;

  private readonly origin: string;
  private readonly basePath: string;
  private readonly apiKey: string;
  private readonly defaultModelId: string;
  private readonly fetchFn: typeof fetch;

  constructor(options?: GeminiProviderOptions) {
    const configured = splitBaseUrl(options?.baseUrl?.trim() || "https://generativelanguage.googleapis.com/v1beta");
    this.origin = configured.origin;
    this.basePath = configured.basePath;

    // Empty string means "not configured" — the ChatFire/OpenAI convention —
    // so a keyless record still constructs and reports the gap at call time.
    this.apiKey = options?.apiKey ?? "";
    this.defaultModelId = options?.defaultModelId?.trim() || "gemini-2.0-flash";
    this.fetchFn = options?.fetchFn ?? globalThis.fetch;
  }

  private endpointUrl(model: string, suffix: string): string {
    return `${this.origin}${this.basePath}/models/${encodeURIComponent(model)}${suffix}`;
  }

  /**
   * Auth header builder. The credential is assembled fresh per request and
   * is never stored beyond the field, logged, or attached to an error.
   */
  private authHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "x-goog-api-key": this.apiKey,
    };
  }

  /**
   * Shared non-2xx handling. `action` keeps messages readable. Messages
   * carry only the HTTP status plus a sanitized provider detail — never the
   * API key, the auth header name/value pair, or the full request URL.
   */
  private async errorFromResponse(response: Response, action: string): Promise<ProviderError> {
    const status = response.status;

    let detail = "";
    try {
      const bodyText = await response.text();
      try {
        detail = extractErrorMessage(JSON.parse(bodyText), "");
      } catch {
        // Non-JSON error body: bounded snippet, credential-redacted.
        detail = sanitizeCredentialText(bodyText.slice(0, 300));
      }
    } catch {
      detail = "";
    }
    detail = sanitizeCredentialText(detail);

    const message = detail
      ? `Gemini ${action} failed (HTTP ${status}): ${detail}`
      : `Gemini ${action} failed with HTTP status ${status}`;

    if (status === 401 || status === 403) {
      return new ProviderAuthError(message, {
        provider: this.providerType,
        statusCode: status,
      });
    }
    if (status === 429) {
      return new ProviderError(`Gemini ${action} was rate limited (HTTP 429)`, {
        provider: this.providerType,
        statusCode: status,
        code: "rate_limited",
      });
    }
    return new ProviderResponseError(message, {
      provider: this.providerType,
      statusCode: status,
    });
  }

  /** POSTs JSON with the auth headers, mapping transport failures to ProviderNetworkError. */
  private async postJson(url: string, payload: unknown, action: string): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: "POST",
        headers: this.authHeaders(),
        body: JSON.stringify(payload),
      });
    } catch (err: unknown) {
      // Defence in depth: an exception message could theoretically embed the
      // key; redact before it enters our error surface.
      const reason = err instanceof Error ? sanitizeCredentialText(err.message) : String(err);
      throw new ProviderNetworkError(`Failed to connect to Gemini: ${reason}`, {
        provider: this.providerType,
        cause: err,
      });
    }
    if (!response.ok) {
      throw await this.errorFromResponse(response, action);
    }
    return response;
  }

  async generateText(
    params: TextGenerationParams,
  ): Promise<{ text: string; metadata?: Record<string, unknown> }> {
    if (!this.apiKey) {
      throw new ProviderAuthError(
        "Google Gemini API key is not configured. Please set the provider's API key in the Admin Control Plane.",
        { provider: this.providerType },
      );
    }

    const model = params.modelId?.trim() || this.defaultModelId;

    // Gemini-specific request structure, contained here. The optional system
    // prompt maps onto Gemini's `systemInstruction` field; the user prompt
    // becomes a `user`-role generateContent part. extraParams from the
    // caller's metadata are forwarded (the same escape hatch the other
    // adapters use) so an admin can pass e.g. temperature without adapter
    // changes — generationConfig keys are merged last.
    const generationConfig: Record<string, unknown> = {
      ...(params.metadata?.extraParams
        ? (params.metadata.extraParams as Record<string, unknown>)
        : {}),
    };

    const body: Record<string, unknown> = {
      contents: [
        {
          role: "user",
          parts: [{ text: params.prompt }],
        },
      ],
      ...(params.systemPrompt ? { systemInstruction: { parts: [{ text: params.systemPrompt }] } } : {}),
      ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
    };

    const response = await this.postJson(
      this.endpointUrl(model, ":generateContent"),
      body,
      "completion",
    );

    let data: unknown;
    try {
      data = await response.json();
    } catch (err: unknown) {
      throw new ProviderResponseError("Invalid JSON response from Gemini completion", {
        provider: this.providerType,
        cause: err,
      });
    }

    // Gemini-specific response structure, contained here. Malformed shapes
    // become ProviderResponseError — no Gemini object ever leaves the adapter.
    const candidates = (data as { candidates?: unknown }).candidates;
    const first = Array.isArray(candidates)
      ? (candidates[0] as { content?: { parts?: unknown }; finishReason?: unknown } | undefined)
      : undefined;
    const parts = first?.content?.parts;
    const text = Array.isArray(parts)
      ? parts
          .filter((p): p is { text?: unknown } => p !== null && typeof p === "object" && "text" in p)
          .map((p) => (typeof p.text === "string" ? p.text : ""))
          .join("")
      : undefined;

    const finishReason = first?.finishReason;
    const blocked = blockedReasonMessage(finishReason, (data as { promptFeedback?: unknown }).promptFeedback);
    if (typeof text !== "string" || text === "") {
      throw new ProviderResponseError(
        blocked ??
          "Gemini completion response did not contain any generated text",
        { provider: this.providerType },
      );
    }

    const usage = (data as { usageMetadata?: Record<string, unknown> | undefined }).usageMetadata;
    const metadata: Record<string, unknown> = {
      provider: this.providerType,
      model,
    };
    if (usage && typeof usage === "object") {
      const promptTokens = normalizeUsageNumber(usage.promptTokenCount);
      const completionTokens = normalizeUsageNumber(usage.candidatesTokenCount);
      const totalTokens = normalizeUsageNumber(usage.totalTokenCount);
      if (promptTokens !== undefined) metadata.promptTokens = promptTokens;
      if (completionTokens !== undefined) metadata.completionTokens = completionTokens;
      if (totalTokens !== undefined) metadata.totalTokens = totalTokens;
    }
    if (finishReason !== undefined) {
      metadata.finishReason = finishReason;
    }

    return { text, metadata };
  }

  /**
   * Configuration-level connectivity probe. Calls the provider's `models`
   * list endpoint with the key in the `x-goog-api-key` header (never a
   * query string), so the credential cannot leak through URLs or logs.
   */
  async testConnection(): Promise<{ ok: boolean; message?: string }> {
    if (!this.apiKey) {
      return {
        ok: false,
        message: "Google Gemini API key is not configured",
      };
    }

    let response: Response;
    try {
      response = await this.fetchFn(`${this.origin}${this.basePath}/models`, {
        method: "GET",
        headers: { "x-goog-api-key": this.apiKey },
      });
    } catch {
      return {
        ok: false,
        message: "Gemini endpoint is unreachable (network error)",
      };
    }

    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        message: `Gemini rejected the configured API key (HTTP ${response.status})`,
      };
    }
    if (!response.ok) {
      return {
        ok: false,
        message: `Gemini endpoint returned HTTP ${response.status}`,
      };
    }
    return {
      ok: true,
      message: "Gemini endpoint is reachable and the API key is accepted",
    };
  }
}
