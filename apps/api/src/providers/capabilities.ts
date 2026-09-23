/**
 * Capability lookup foundation (C6.7.1).
 *
 * The future capability-routing layer needs to be able to ask:
 *
 *     "Find an enabled model for capability X and job type Y"
 *
 * without knowing anything about providers, provider types or adapters. This
 * module is the data layer that answers that question. It is deliberately
 * *not* a routing system: it offers no scoring, no failover and no automatic
 * selection — only a single, well-defined query against the enabled
 * provider/model configuration. The routing layer of a later phase builds on
 * top of it.
 *
 * Rules encoded here mirror the ones the UI already applies:
 *   - the model must be enabled, and its provider must be enabled;
 *   - the model's capability must match the requested one exactly;
 *   - a model with no declared `jobTypes` serves any job type for its
 *     capability; otherwise the requested job type must be in the list.
 */

import { and, eq } from "drizzle-orm";
import { aiProviders } from "../db/schema/ai_providers.js";
import { aiModels } from "../db/schema/ai_models.js";
import type { BaseProvider, ProviderCapability } from "./types.js";
import { toModelDto, type ModelDto } from "./dto.js";
import { resolveAdapter, type ProviderRecordLike } from "./factory.js";

/**
 * The database handle, structurally typed. `getDb()` returns a Drizzle
 * client; tests inject a fake. Keeping this structural avoids importing the
 * (side-effectful) `db/index.ts` module and lets the fake in
 * `provider_config.test.ts` satisfy the shape.
 */
export type DbLike = {
  select(projection?: Record<string, unknown>): {
    from(table: unknown): {
      where(condition: unknown): Promise<Record<string, unknown>[]>;
      orderBy(...columns: unknown[]): Promise<Record<string, unknown>[]>;
    };
  };
};

/**
 * Selector input for the lookup. `db` is accepted explicitly (rather than
 * pulled from `getDb()`) so callers — including tests — control the store.
 */
export interface CapabilityQuery {
  db: DbLike;
  capability: ProviderCapability;
  /** Optional job type the model must support. */
  jobType?: string;
  /** Restrict the search to models bound to this provider. */
  providerId?: string;
}

export interface CapabilityModel extends ModelDto {
  providerName: string;
  providerType: string;
  providerEnabled: boolean;
}

/**
 * Finds enabled models for a capability (+ optional job type), joined to
 * their enabled provider. Results are ordered by model creation time, which
 * makes the set stable and predictable for whatever consumes it later.
 */
export async function findModelsForCapability(
  query: CapabilityQuery,
): Promise<CapabilityModel[]> {
  const { db, capability, jobType, providerId } = query;

  const conditions = [eq(aiModels.enabled, true), eq(aiModels.capability, capability)];
  if (providerId) {
    conditions.push(eq(aiModels.providerId, providerId));
  }

  const modelRows = (await db.select().from(aiModels).where(and(...conditions))) as unknown as Array<
    Record<string, unknown>
  >;

  // Providers are fetched once: a disabled provider hides every bound model.
  const providerRows = (await db.select().from(aiProviders)) as unknown as Array<
    Record<string, unknown>
  >;
  const providerById = new Map(providerRows.map((p) => [p.id as string, p]));

  const out: CapabilityModel[] = [];
  for (const model of modelRows) {
    const provider = providerById.get(model.providerId as string);
    if (!provider || !Boolean(provider.enabled)) continue;

    const jobTypes = normalizeJobTypes(model.jobTypes);
    if (jobTypes !== null && jobType !== undefined && !jobTypes.includes(jobType)) {
      continue;
    }

    out.push({
      ...toModelDto(model, (provider.name as string) ?? null),
      providerName: (provider.name as string) ?? "",
      providerType: (provider.providerType as string) ?? "",
      providerEnabled: Boolean(provider.enabled),
    });
  }

  return out;
}

/**
 * Normalizes the `job_types` JSON column into a list of strings, or `null`
 * when the model declares no constraint (meaning "any job type").
 */
export function normalizeJobTypes(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const list = raw.filter((x): x is string => typeof x === "string");
  return list.length > 0 ? list : null;
}

/**
 * Adapter view of a capability match: the model bound to a provider record
 * whose adapter can actually serve the requested capability. This is the
 * seam the future routing layer will call once it has chosen a model — it
 * keeps "which model?" and "which adapter instance?" as separate decisions.
 */
export interface AdapterCandidate {
  model: CapabilityModel;
  adapter: BaseProvider;
}

/**
 * Turns capability matches into usable adapter instances. A match is only
 * kept when the provider record's adapter type both *supports* the
 * capability and has an implementation (`adapterAvailable`), so an enabled
 * model bound to a reserved type is reported as "no usable adapter" rather
 * than silently working.
 */
export async function findAdaptersForCapability(
  query: CapabilityQuery,
): Promise<AdapterCandidate[]> {
  const models = await findModelsForCapability(query);
  const out: AdapterCandidate[] = [];

  for (const model of models) {
    const providerRow = (await query.db
      .select()
      .from(aiProviders)
      .where(eq(aiProviders.id, model.providerId))) as unknown as Array<Record<string, unknown>>;
    const record = providerRow[0] as ProviderRecordLike | undefined;
    if (!record) continue;

    const adapter = resolveAdapter(record, query.capability);
    if (!adapter) continue;

    out.push({ model, adapter });
  }

  return out;
}

/** True when at least one enabled model can serve the capability (+ job type). */
export async function hasModelForCapability(query: CapabilityQuery): Promise<boolean> {
  const models = await findModelsForCapability(query);
  return models.length > 0;
}
