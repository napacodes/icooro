import { env } from "../env.js";
import {
  type GenerationJobStatus,
  type JobStatusResult,
  type MediaDownloadResult,
  type VideoGenerationParams,
  type VideoProvider,
  ProviderAuthError,
  ProviderNetworkError,
  ProviderResponseError,
} from "./types.js";

export interface ChatFireProviderOptions {
  baseUrl?: string;
  apiKey?: string;
  defaultModelId?: string;
  fetchFn?: typeof fetch;
}

export class ChatFireVideoProvider implements VideoProvider {
  readonly providerType = "chatfire";
  readonly name = "ChatFire Seedance 2.5";
  readonly capabilities = ["video"] as const;

  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly defaultModelId: string;
  private readonly fetchFn: typeof fetch;

  constructor(options?: ChatFireProviderOptions) {
    this.baseUrl = (options?.baseUrl ?? env.chatfireBaseUrl ?? "https://api.chatfire.site").replace(/\/+$/, "");
    this.apiKey = options?.apiKey ?? env.chatfireApiKey;
    this.defaultModelId = options?.defaultModelId ?? "doubao-seedance-2-5-260628";
    this.fetchFn = options?.fetchFn ?? globalThis.fetch;
  }

  async createJob(
    params: VideoGenerationParams,
  ): Promise<{ externalJobId: string; metadata?: Record<string, unknown> }> {
    if (!this.apiKey) {
      throw new ProviderAuthError(
        "ChatFire API key is not configured. Please set CHATFIRE_API_KEY in your environment.",
        { provider: this.providerType },
      );
    }

    const model = params.modelId || this.defaultModelId;
    const url = `${this.baseUrl}/volcengine/api/v3/contents/generations/tasks`;
    const body: Record<string, unknown> = {
      model,
      content: [
        {
          type: "text",
          text: params.prompt,
        },
      ],
      ...(params.metadata?.extraParams ? (params.metadata.extraParams as Record<string, unknown>) : {}),
    };

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      });
    } catch (err: unknown) {
      throw new ProviderNetworkError(
        `Failed to connect to ChatFire API: ${err instanceof Error ? err.message : String(err)}`,
        { provider: this.providerType, cause: err },
      );
    }

    if (!response.ok) {
      let errorDetail = "";
      try {
        const errorJson = await response.json();
        errorDetail =
          (errorJson as any)?.error?.message ||
          (errorJson as any)?.message ||
          JSON.stringify(errorJson);
      } catch {
        errorDetail = await response.text().catch(() => "");
      }

      const message = errorDetail
        ? `ChatFire submission error (${response.status}): ${errorDetail}`
        : `ChatFire submission failed with HTTP status ${response.status}`;

      if (response.status === 401 || response.status === 403) {
        throw new ProviderAuthError(message, {
          provider: this.providerType,
          statusCode: response.status,
        });
      }

      throw new ProviderResponseError(message, {
        provider: this.providerType,
        statusCode: response.status,
      });
    }

    let data: any;
    try {
      data = await response.json();
    } catch (err: unknown) {
      throw new ProviderResponseError("Invalid JSON response from ChatFire API submission", {
        provider: this.providerType,
        cause: err,
      });
    }

    const externalJobId =
      data?.id ??
      data?.task_id ??
      data?.data?.id ??
      data?.data?.task_id ??
      data?.task?.id ??
      data?.result?.id;

    if (!externalJobId || typeof externalJobId !== "string") {
      throw new ProviderResponseError(
        "ChatFire submission response did not contain a valid task ID",
        { provider: this.providerType },
      );
    }

    return {
      externalJobId,
      metadata: {
        provider: this.providerType,
        model,
        rawResponse: data,
      },
    };
  }

  async getJobStatus(externalJobId: string): Promise<JobStatusResult> {
    if (!this.apiKey) {
      throw new ProviderAuthError(
        "ChatFire API key is not configured. Please set CHATFIRE_API_KEY in your environment.",
        { provider: this.providerType },
      );
    }

    const url = `${this.baseUrl}/volcengine/api/v3/contents/generations/tasks/${encodeURIComponent(externalJobId)}`;

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      });
    } catch (err: unknown) {
      throw new ProviderNetworkError(
        `Failed to query ChatFire task status: ${err instanceof Error ? err.message : String(err)}`,
        { provider: this.providerType, cause: err },
      );
    }

    if (!response.ok) {
      let errorDetail = "";
      try {
        const errorJson = await response.json();
        errorDetail =
          (errorJson as any)?.error?.message ||
          (errorJson as any)?.message ||
          JSON.stringify(errorJson);
      } catch {
        errorDetail = await response.text().catch(() => "");
      }

      const message = errorDetail
        ? `ChatFire status error (${response.status}): ${errorDetail}`
        : `ChatFire status check failed with HTTP status ${response.status}`;

      if (response.status === 401 || response.status === 403) {
        throw new ProviderAuthError(message, {
          provider: this.providerType,
          statusCode: response.status,
        });
      }

      throw new ProviderResponseError(message, {
        provider: this.providerType,
        statusCode: response.status,
      });
    }

    let data: any;
    try {
      data = await response.json();
    } catch (err: unknown) {
      throw new ProviderResponseError("Invalid JSON response from ChatFire API status check", {
        provider: this.providerType,
        cause: err,
      });
    }

    const rawStatus =
      data?.status ??
      data?.task_status ??
      data?.data?.status ??
      data?.data?.task_status;

    if (!rawStatus || typeof rawStatus !== "string") {
      throw new ProviderResponseError(
        "ChatFire status response did not contain a valid status",
        { provider: this.providerType },
      );
    }

    const normalized = rawStatus.toUpperCase().trim();
    let status: GenerationJobStatus;

    switch (normalized) {
      case "QUEUED":
      case "PENDING":
      case "SUBMITTED":
        status = "submitted";
        break;
      case "RUNNING":
      case "PROCESSING":
        status = "processing";
        break;
      case "SUCCEEDED":
      case "SUCCESS":
      case "COMPLETED":
        status = "completed";
        break;
      case "FAILED":
      case "ERROR":
        status = "failed";
        break;
      case "CANCELLED":
      case "CANCELED":
        status = "cancelled";
        break;
      default:
        throw new ProviderResponseError(
          `Unexpected provider status from ChatFire: "${rawStatus}"`,
          { provider: this.providerType },
        );
    }

    const resultUrl =
      data?.content?.video_url ??
      data?.data?.content?.video_url ??
      data?.data?.video_url ??
      data?.output?.video_url ??
      data?.result?.video_url ??
      data?.video_url ??
      data?.data?.url ??
      data?.url;

    let progress: number | undefined;
    const rawProgress = data?.progress ?? data?.data?.progress;
    if (typeof rawProgress === "number") {
      progress = rawProgress;
    }

    let errorMsg: string | undefined;
    if (status === "failed") {
      errorMsg =
        data?.error?.message ??
        data?.data?.error?.message ??
        data?.error_message ??
        data?.data?.error_message ??
        data?.message ??
        "Video generation failed";
    }

    const result: JobStatusResult = {
      status,
      ...(progress !== undefined ? { progress } : {}),
      ...(errorMsg !== undefined ? { error: errorMsg } : {}),
      ...(typeof resultUrl === "string" ? { resultUrl } : {}),
      metadata: {
        rawStatus,
        provider: this.providerType,
      },
    };

    return result;
  }

  async cancelJob(_externalJobId: string): Promise<{ cancelled: boolean }> {
    return { cancelled: false };
  }

  async downloadResult(externalJobId: string): Promise<MediaDownloadResult> {
    const jobStatus = await this.getJobStatus(externalJobId);
    if (jobStatus.status !== "completed" || !jobStatus.resultUrl) {
      throw new ProviderResponseError(
        `Cannot download result: job "${externalJobId}" is in status "${jobStatus.status}" and has no valid resultUrl`,
        { provider: this.providerType },
      );
    }

    let response: Response;
    try {
      response = await this.fetchFn(jobStatus.resultUrl);
    } catch (err: unknown) {
      throw new ProviderNetworkError(
        `Failed to download media file for ChatFire job "${externalJobId}": ${err instanceof Error ? err.message : String(err)}`,
        { provider: this.providerType, cause: err },
      );
    }

    if (!response.ok) {
      throw new ProviderNetworkError(
        `Failed to download media file: HTTP status ${response.status}`,
        { provider: this.providerType, statusCode: response.status },
      );
    }

    const arrayBuffer = await response.arrayBuffer();
    const data = Buffer.from(arrayBuffer);
    const mimeType = response.headers.get("content-type") || "video/mp4";

    return {
      data,
      mimeType,
      fileExtension: "mp4",
      fileName: `${externalJobId}.mp4`,
      fileSize: data.byteLength,
    };
  }

  async testConnection(): Promise<{ ok: boolean; message?: string }> {
    if (!this.apiKey) {
      return {
        ok: false,
        message: "ChatFire API key is not configured",
      };
    }

    return {
      ok: true,
      message: "ChatFire provider configuration is present",
    };
  }
}

export const chatfireVideoProvider = new ChatFireVideoProvider();
