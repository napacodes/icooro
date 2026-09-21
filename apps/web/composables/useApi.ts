/**
 * useApi — thin typed wrapper around `$fetch` for the Icooro REST API.
 *
 * Envelope contract (one-level):
 *   success: `{ data: T }`        -> returns T
 *   error:   `{ error: { code, message } }` -> throws `ApiError`
 *
 * Every API route is expected to return `{ data: <payload> }` for success
 * and `{ error: { code, message } }` for failure. Callers ask for the
 * payload type directly (e.g. `api.get<Project[]>("/projects")`).
 *
 * - Prepends `runtimeConfig.public.apiBase + "/api/v1"` automatically.
 * - Sends the session cookie (`credentials: "include"`).
 * - Normalizes error responses into `ApiError` instances.
 */
import { ApiError, type ApiErrorCode, type ApiErrorBody, type ApiSuccess } from "@icooro/shared";

export interface UseApi {
  request<T>(path: string, options?: UseApiRequestOptions): Promise<T>;
  get<T>(path: string, options?: UseApiRequestOptions): Promise<T>;
  post<T>(path: string, body?: unknown, options?: UseApiRequestOptions): Promise<T>;
  patch<T>(path: string, body?: unknown, options?: UseApiRequestOptions): Promise<T>;
  delete<T>(path: string, options?: UseApiRequestOptions): Promise<T>;
}

interface UseApiRequestOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, unknown>;
  headers?: HeadersInit;
  credentials?: RequestCredentials;
  /** Per-request timeout in ms; overrides the default. */
  timeout?: number;
}

/** Ceiling so an unresponsive API can never leave a form spinning forever. */
const DEFAULT_TIMEOUT_MS = 30_000;

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (!value || typeof value !== "object") return false;
  const err = (value as { error?: unknown }).error;
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  const message = (err as { message?: unknown }).message;
  return typeof code === "string" && typeof message === "string";
}

function statusToErrorCode(status: number): ApiErrorCode {
  if (status === 401) return "UNAUTHORIZED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND";
  if (status === 409) return "CONFLICT";
  return "INTERNAL_ERROR";
}

function isSuccess<T>(value: unknown): value is ApiSuccess<T> {
  if (!value || typeof value !== "object") return false;
  // Strict one-level envelope: success is `data` without a competing
  // `error` field. Anything else (non-enveloped payloads) is passed
  // through so the caller's `T` matches the API contract.
  const obj = value as Record<string, unknown>;
  return "data" in obj && !("error" in obj);
}

function unwrap<T>(value: unknown): T {
  if (isSuccess<T>(value)) return value.data;
  return value as T;
}

export function useApi(): UseApi {
  const config = useRuntimeConfig();
  const base = `${config.public.apiBase}/api/v1`;

  async function request<T>(path: string, options: UseApiRequestOptions = {}): Promise<T> {
    const { timeout = DEFAULT_TIMEOUT_MS, ...fetchOptions } = options;
    try {
      const response = await $fetch<T>(`${base}${path}`, {
        credentials: "include",
        timeout,
        ...fetchOptions,
      } as Parameters<typeof $fetch<T>>[1]);
      return unwrap<T>(response);
    } catch (cause: unknown) {
      // $fetch throws FetchError with `.data` (response body) and `.status`.
      const fetchError = cause as { data?: unknown; status?: number; statusCode?: number; message?: string } | null;
      const data = fetchError?.data;
      if (isApiErrorBody(data)) {
        throw new ApiError(data.error.message, data.error.code, fetchError?.status ?? fetchError?.statusCode ?? 0);
      }
      const status = fetchError?.status ?? fetchError?.statusCode ?? 0;
      const message = fetchError?.message ?? "Request failed";
      throw new ApiError(message, statusToErrorCode(status), status);
    }
  }

  return {
    request,
    get<T>(path: string, options: UseApiRequestOptions = {}): Promise<T> {
      return request<T>(path, { ...options, method: "GET" });
    },
    post<T>(path: string, body?: unknown, options: UseApiRequestOptions = {}): Promise<T> {
      return request<T>(path, { ...options, method: "POST", body });
    },
    patch<T>(path: string, body?: unknown, options: UseApiRequestOptions = {}): Promise<T> {
      return request<T>(path, { ...options, method: "PATCH", body });
    },
    delete<T>(path: string, options: UseApiRequestOptions = {}): Promise<T> {
      return request<T>(path, { ...options, method: "DELETE" });
    },
  };
}
