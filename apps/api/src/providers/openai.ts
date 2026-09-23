/**
 * OpenAI provider adapter (C6.7.2.1).
 *
 * First adapter beyond ChatFire, built on the C6.7.1 generic provider
 * architecture: the factory (factory.ts) builds a *record-configured*
 * instance from a provider record, and this adapter implements the existing
 * `TextProvider` interface from types.ts. Nothing outside the adapter knows
 * OpenAI exists beyond:
 *
 *   - the factory registration in providers/index.ts (one entry),
 *   - the provider-type catalog entry in @icooro/shared (adapterAvailable).
 *
 * Scope for C6.7.2.1 is deliberately TEXT generation only — the chat
 * completions endpoint (`POST {baseUrl}/chat/completions`). Image and audio
 * capabilities are NOT claimed (see the catalog), so the capability layer
 * will never route image/audio jobs to OpenAI.
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

export interface OpenAIProviderOptions {
  baseUrl?: string;
  apiKey?: string;
  defaultModelId?: string;
  /** Injectable transport. When omitted, `globalThis.fetch` is used. */
  fetchFn?: typeof fetch;
}

/**
 * Splits "https://host/base" into origin + base path, tolerating a trailing
 * slash, so `{baseUrl}/chat/completions` joins correctly regardless of how
 * the admin configured the record (with or without a path component).
 */
function splitBaseUrl(baseUrl: string): { origin: string; basePath: string } {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  if (!normalized) {
    throw new ProviderError("OpenAI base URL must not be empty", { provider: "openai" });
  }
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new ProviderError(`OpenAI base URL is invalid: "${baseUrl}"`, { provider: "openai" });
  }
  return { origin: parsed.origin, basePath: parsed.pathname.replace(/\/+$/, "") };
}

/**
 * Redacts credential-looking material from free text that ends up in error
 * messages (e.g. non-JSON gateway error bodies). The adapter never places
 * the key in a message itself; this is defence in depth for provider- or
 * proxy-supplied text.
 */
function sanitizeCredentialText(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, "Bearer [REDACTED]")
    .replace(/(api[-_]?key|authorization|token|secret|password)\s*[:=]\s*\S+/gi, "$1=[REDACTED]")
    .replace(/sk-[A-Za-z0-9\-_]{8,}/g, "[REDACTED]");
}

/**
 * Extracts a human-readable message from an OpenAI error body. OpenAI errors
 * look like `{ "error": { "message": "...", "type": "...", "code": "..." } }`;
 * some gateways return `{ "message": "..." }` instead. Malformed bodies fall
 * back to a generic message — the raw body is never surfaced unredacted.
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

export class OpenAITextProvider implements TextProvider {
  // Typed as `string` (and re-branded by subclasses, e.g. the custom
  // OpenAI-compatible adapter) while keeping the same runtime values.
  readonly providerType: string = "openai";
  readonly name: string = "OpenAI";
  readonly capabilities = ["text"] as const;

  /**
   * Human label used in error messages. Kept separate from `providerType`
   * so a subclass can re-brand its errors without duplicating any request/
   * response logic. The default keeps every message byte-identical to the
   * pre-C6.7.2.3 OpenAI adapter.
   */
  protected readonly providerLabel: string = "OpenAI";

  private readonly origin: string;
  private readonly basePath: string;
  private readonly apiKey?: string;
  // Protected (mutable) so the custom OpenAI-compatible subclass can clear
  // the OpenAI-specific default model — it must never leak into a custom
  // gateway's requests.
  protected defaultModelId: string;
  private readonly fetchFn: typeof fetch;

  constructor(options?: OpenAIProviderOptions) {
    const configured = splitBaseUrl(options?.baseUrl?.trim() || "https://api.openai.com/v1");
    this.origin = configured.origin;
    this.basePath = configured.basePath;

    // Empty string means "not configured" — same convention as ChatFire —
    // so a keyless record still constructs and reports the gap at call time.
    this.apiKey = options?.apiKey ?? "";
    this.defaultModelId = options?.defaultModelId?.trim() || "gpt-4o-mini";
    this.fetchFn = options?.fetchFn ?? globalThis.fetch;
  }

  private endpointUrl(suffix: string): string {
    return `${this.origin}${this.basePath}${suffix}`;
  }

  /**
   * Auth header builder. Assembled fresh per request; never stored, logged,
   * or attached to an error object.
   */
  private authHeader(): string {
    return `Bearer ${this.apiKey ?? ""}`;
  }

  /**
   * Shared non-2xx handling. `action` keeps messages readable ("completion",
   * "connection test"). Messages carry only the HTTP status plus a sanitized
   * provider detail — never the API key, Authorization header, or the full
   * request URL.
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
      ? `${this.providerLabel} ${action} failed (HTTP ${status}): ${detail}`
      : `${this.providerLabel} ${action} failed with HTTP status ${status}`;

    if (status === 401 || status === 403) {
      return new ProviderAuthError(message, {
        provider: this.providerType,
        statusCode: status,
      });
    }
    if (status === 429) {
      return new ProviderError(`${this.providerLabel} ${action} was rate limited (HTTP 429)`, {
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

  /** POSTs JSON with the auth header, mapping transport failures to ProviderNetworkError. */
  private async postJson(url: string, payload: unknown, action: string): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: this.authHeader(),
        },
        body: JSON.stringify(payload),
      });
    } catch (err: unknown) {
      // Defense in depth: an exception message (e.g. from a fetch
      // implementation) could theoretically embed the key; redact before it
      // enters our error surface.
      const reason =
        err instanceof Error ? sanitizeCredentialText(err.message) : String(err);
      throw new ProviderNetworkError(`Failed to connect to ${this.providerLabel}: ${reason}`, {
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
        `${this.providerLabel} API key is not configured. Please set the provider's API key in the Admin Control Plane.`,
        { provider: this.providerType },
      );
    }

    const model = params.modelId?.trim() || this.defaultModelId;

    // OpenAI-specific request structure, contained here. `messages` carries
    // the optional system prompt plus the user prompt; extraParams from the
    // caller's metadata are forwarded (the same escape hatch ChatFire uses)
    // so an admin can pass e.g. temperature without adapter changes.
    const body: Record<string, unknown> = {
      model,
      messages: [
        ...(params.systemPrompt ? [{ role: "system", content: params.systemPrompt }] : []),
        { role: "user", content: params.prompt },
      ],
      ...(params.metadata?.extraParams
        ? (params.metadata.extraParams as Record<string, unknown>)
        : {}),
    };

    const response = await this.postJson(this.endpointUrl("/chat/completions"), body, "completion");

    let data: unknown;
    try {
      data = await response.json();
    } catch (err: unknown) {
      throw new ProviderResponseError(`Invalid JSON response from ${this.providerLabel} completion`, {
        provider: this.providerType,
        cause: err,
      });
    }

    // OpenAI-specific response structure, contained here. Malformed shapes
    // become ProviderResponseError — no OpenAI object ever leaves the adapter.
    const choices = (data as { choices?: unknown }).choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      throw new ProviderResponseError(
        `${this.providerLabel} completion response did not contain any choices`,
        { provider: this.providerType },
      );
    }
    const first = choices[0] as { message?: unknown } | undefined;
    const message = first?.message as { content?: unknown } | undefined;
    const text = typeof message?.content === "string" ? message.content : undefined;
    if (typeof text !== "string") {
      throw new ProviderResponseError(
        `${this.providerLabel} completion response did not contain message content`,
        { provider: this.providerType },
      );
    }

    const usage = (data as { usage?: Record<string, unknown> | undefined }).usage;
    const metadata: Record<string, unknown> = {
      provider: this.providerType,
      model,
    };
    if (usage && typeof usage === "object") {
      const promptTokens = normalizeUsageNumber(usage.prompt_tokens);
      const completionTokens = normalizeUsageNumber(usage.completion_tokens);
      const totalTokens = normalizeUsageNumber(usage.total_tokens);
      if (promptTokens !== undefined) metadata.promptTokens = promptTokens;
      if (completionTokens !== undefined) metadata.completionTokens = completionTokens;
      if (totalTokens !== undefined) metadata.totalTokens = totalTokens;
    }

    return { text, metadata };
  }

  /**
   * Configuration-level connectivity probe. The API key is required for a
   * real probe, but the probe never sends it anywhere unreachable: it calls
   * the provider's `/models` list endpoint, which requires only the key in
   * the Authorization header (never a query string), so the credential
   * cannot leak through URLs or logs.
   */
  async testConnection(): Promise<{ ok: boolean; message?: string }> {
    if (!this.apiKey) {
      return {
        ok: false,
        message: `${this.providerLabel} API key is not configured`,
      };
    }

    let response: Response;
    try {
      response = await this.fetchFn(this.endpointUrl("/models"), {
        method: "GET",
        headers: { Authorization: this.authHeader() },
      });
    } catch {
      return {
        ok: false,
        message: `${this.providerLabel} endpoint is unreachable (network error)`,
      };
    }

    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        message: `${this.providerLabel} rejected the configured API key (HTTP ${response.status})`,
      };
    }
    if (!response.ok) {
      return {
        ok: false,
        message: `${this.providerLabel} endpoint returned HTTP ${response.status}`,
      };
    }
    return {
      ok: true,
      message: `${this.providerLabel} endpoint is reachable and the API key is accepted`,
    };
  }
}

/** Rounds nothing; just narrows `unknown` usage fields to finite numbers. */
function normalizeUsageNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Module-level factory used by providers/index.ts registration. Kept as a
 * tiny wrapper so the registration site reads uniformly with ChatFire's.
 */
export function createOpenAITextProvider(config: {
  baseUrl?: string;
  apiKey?: string;
  defaultModelId?: string;
  fetchFn?: typeof fetch;
}): OpenAITextProvider {
  return new OpenAITextProvider(config);
}
