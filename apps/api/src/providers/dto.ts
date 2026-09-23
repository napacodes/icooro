import { ProviderRegistry } from "./registry.js";
import { hasSecret, maskSecret } from "./secrets.js";

/**
 * Serialization of AI provider / model rows into API response shapes.
 *
 * Single place enforcing the "never return the raw API key" contract, used
 * by both the Admin Control Plane routes and the generation selection
 * routes. The sealed `api_key_secret` column is never copied into a DTO.
 */

function toDate(v: unknown): string {
  return v instanceof Date ? v.toISOString() : (v as string);
}

export interface ProviderDto {
  id: string;
  name: string;
  providerType: string;
  enabled: boolean;
  baseUrl: string | null;
  hasApiKey: boolean;
  apiKeyMasked: string | null;
  config: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export function toProviderDto(row: Record<string, unknown>): ProviderDto {
  // ProviderRegistry.sanitizeProvider strips credential-like keys from the
  // JSON `config` column. We then rebuild the public shape explicitly so
  // the sealed envelope never reaches a response.
  const sanitizedConfig = ProviderRegistry.sanitizeProvider(row).config as
    | Record<string, unknown>
    | null
    | undefined;
  return {
    id: row.id as string,
    name: row.name as string,
    providerType: row.providerType as string,
    enabled: Boolean(row.enabled),
    baseUrl: (row.baseUrl as string | null | undefined) ?? null,
    hasApiKey: hasSecret(row.apiKeySecret as string | null | undefined),
    apiKeyMasked: maskSecret(row.apiKeySecret as string | null | undefined),
    config: sanitizedConfig ?? null,
    createdAt: toDate(row.createdAt),
    updatedAt: toDate(row.updatedAt),
  };
}

export interface ModelDto {
  id: string;
  providerId: string;
  name: string;
  modelId: string;
  capability: string;
  jobTypes: string[] | null;
  enabled: boolean;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  providerName: string | null;
}

export function parseJsonStringArray(v: unknown): string[] | null {
  if (Array.isArray(v)) return v.filter((x) => typeof x === "string");
  // MySQL JSON columns arrive already parsed, but fakes/other drivers may
  // hand us the serialized form.
  if (typeof v === "string" && v.trim() !== "") {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function toModelDto(
  row: Record<string, unknown>,
  providerName?: string | null,
): ModelDto {
  return {
    id: row.id as string,
    providerId: row.providerId as string,
    name: row.name as string,
    modelId: row.modelId as string,
    capability: row.capability as string,
    jobTypes: parseJsonStringArray(row.jobTypes),
    enabled: Boolean(row.enabled),
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    createdAt: toDate(row.createdAt),
    updatedAt: toDate(row.updatedAt),
    providerName: providerName ?? null,
  };
}
