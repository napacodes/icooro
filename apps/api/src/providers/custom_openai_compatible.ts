/**
 * Custom OpenAI-compatible provider adapter (C6.7.2.3).
 *
 * Fourth adapter, built on the C6.7.1 generic provider architecture: the
 * factory (factory.ts) builds a *record-configured* instance from a provider
 * record, and this adapter implements the existing `TextProvider` interface
 * from types.ts.
 *
 * This type represents an arbitrary provider exposing an OpenAI-compatible
 * chat/completions API — NOT OpenAI itself. The wire contract (request and
 * response shapes) is identical to the OpenAI adapter's, so this adapter
 * *extends* `OpenAITextProvider` and re-brands itself rather than duplicating
 * any request/response/error logic. The only behavioural differences:
 *
 *   1. Its own provider identity (`providerType: "custom_openai_compatible"`,
 *      name "Custom OpenAI-compatible", and its own error label) so the rest
 *      of Icooro always sees which provider type served a request.
 *   2. The configured base URL is AUTHORITATIVE and REQUIRED. There is no
 *      default host of any kind — in particular never `api.openai.com`. A
 *      record without a base URL cannot be constructed.
 *   3. No OpenAI-specific default model: the model must come from the AI
 *      model record (or the provider record's `defaultModelId`); the adapter
 *      refuses to guess one.
 *
 * Scope for C6.7.2.3 is deliberately TEXT generation only. Image/video/audio/
 * vision capabilities are NOT claimed (see the catalog).
 *
 * Secrets and error hygiene are inherited unchanged from the OpenAI adapter:
 * the credential is sent as a Bearer Authorization header (never in a URL),
 * never logged, never attached to an error object, and redacted from any
 * provider-supplied message before an error is surfaced.
 */

import {
  type TextGenerationParams,
  ProviderError,
  ProviderResponseError,
} from "./types.js";
import { OpenAITextProvider, type OpenAIProviderOptions } from "./openai.js";

export type CustomOpenAICompatibleProviderOptions = OpenAIProviderOptions;

export class CustomOpenAICompatibleTextProvider extends OpenAITextProvider {
  readonly providerType: string = "custom_openai_compatible";
  readonly name: string = "Custom OpenAI-compatible";

  /**
   * Error label for this type — "Custom provider" keeps messages accurate
   * (a custom gateway is not OpenAI) while reusing the inherited message
   * templates and redaction pipeline.
   */
  protected readonly providerLabel: string = "Custom provider";

  constructor(options?: CustomOpenAICompatibleProviderOptions) {
    // A custom gateway must say where it lives: reject a missing base URL
    // rather than silently falling back to any default host.
    const baseUrl = options?.baseUrl?.trim();
    if (!baseUrl) {
      throw new ProviderError(
        'A base URL is required for the "custom_openai_compatible" provider type — configure the gateway endpoint on the provider record.',
        { provider: "custom_openai_compatible" },
      );
    }

    super({ ...options, baseUrl });

    // The base constructor falls back to an OpenAI-specific default model;
    // a custom gateway's model must come from its own configuration, so it
    // is overridden here (empty = "no default", enforced by the guard below).
    this.defaultModelId = options?.defaultModelId?.trim() ?? "";
  }

  /**
   * Explicit-model guard. The inherited request path is reused unchanged;
   * this only refuses to guess a vendor-specific model when neither the
   * params nor the provider record carries one.
   */
  override async generateText(
    params: TextGenerationParams,
  ): Promise<{ text: string; metadata?: Record<string, unknown> }> {
    if (!params.modelId?.trim() && !this.defaultModelId) {
      throw new ProviderResponseError(
        "No model ID configured for the custom OpenAI-compatible provider — set the model on the AI model record or the provider default.",
        { provider: this.providerType },
      );
    }
    const result = await super.generateText(params);
    // Some gateways answer 200 with empty content; that is a missing result,
    // not a successful one — normalize it into the provider error surface.
    if (result.text === "") {
      throw new ProviderResponseError(
        "Custom provider completion returned empty text",
        { provider: this.providerType },
      );
    }
    return result;
  }
}
