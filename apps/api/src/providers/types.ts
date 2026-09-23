/**
 * Capabilities a provider adapter can implement.
 *
 * Kept in sync with `PROVIDER_CAPABILITIES` in packages/shared so the API and
 * the browser validate against the same list.
 *
 * "vision" is an *input* capability (image → text/recognition); it has no
 * generation job type and therefore no generation job route.
 */
export type ProviderCapability = "text" | "image" | "video" | "audio" | "vision";

export type GenerationJobStatus =
  | "queued"
  | "submitted"
  | "processing"
  | "downloading"
  | "completed"
  | "failed"
  | "cancelled";

export interface JobStatusResult {
  status: GenerationJobStatus;
  progress?: number;
  error?: string;
  resultUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface VideoGenerationParams {
  prompt: string;
  negativePrompt?: string;
  duration?: number;
  width?: number;
  height?: number;
  fps?: number;
  modelId: string;
  metadata?: Record<string, unknown>;
}

export interface ImageGenerationParams {
  prompt: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  modelId: string;
  metadata?: Record<string, unknown>;
}

export interface AudioGenerationParams {
  prompt: string;
  duration?: number;
  modelId: string;
  metadata?: Record<string, unknown>;
}

export interface TextGenerationParams {
  prompt: string;
  modelId: string;
  systemPrompt?: string;
  metadata?: Record<string, unknown>;
}

export interface MediaDownloadResult {
  data: Buffer;
  mimeType: string;
  fileExtension?: string;
  fileName?: string;
  fileSize?: number;
}

export interface BaseProvider {
  readonly providerType: string;
  readonly name: string;
  readonly capabilities: readonly ProviderCapability[];

  testConnection(): Promise<{ ok: boolean; message?: string }>;
}

export interface VideoProvider extends BaseProvider {
  createJob(
    params: VideoGenerationParams,
  ): Promise<{ externalJobId: string; metadata?: Record<string, unknown> }>;
  getJobStatus(externalJobId: string): Promise<JobStatusResult>;
  cancelJob(externalJobId: string): Promise<{ cancelled: boolean }>;
  downloadResult(externalJobId: string): Promise<MediaDownloadResult>;
}

export interface ImageProvider extends BaseProvider {
  createJob(
    params: ImageGenerationParams,
  ): Promise<{ externalJobId: string; metadata?: Record<string, unknown> }>;
  getJobStatus(externalJobId: string): Promise<JobStatusResult>;
  cancelJob(externalJobId: string): Promise<{ cancelled: boolean }>;
  downloadResult(externalJobId: string): Promise<MediaDownloadResult>;
}

export interface AudioProvider extends BaseProvider {
  createJob(
    params: AudioGenerationParams,
  ): Promise<{ externalJobId: string; metadata?: Record<string, unknown> }>;
  getJobStatus(externalJobId: string): Promise<JobStatusResult>;
  cancelJob(externalJobId: string): Promise<{ cancelled: boolean }>;
  downloadResult(externalJobId: string): Promise<MediaDownloadResult>;
}

export interface TextProvider extends BaseProvider {
  generateText(
    params: TextGenerationParams,
  ): Promise<{ text: string; metadata?: Record<string, unknown> }>;
}

export class ProviderError extends Error {
  readonly provider: string;
  readonly statusCode?: number;
  readonly code?: string;

  constructor(
    message: string,
    options?: {
      provider?: string;
      statusCode?: number;
      code?: string;
      cause?: unknown;
    },
  ) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = "ProviderError";
    this.provider = options?.provider ?? "unknown";
    if (options?.statusCode !== undefined) {
      this.statusCode = options.statusCode;
    }
    if (options?.code !== undefined) {
      this.code = options.code;
    }
  }
}

export class ProviderAuthError extends ProviderError {
  constructor(
    message: string,
    options?: {
      provider?: string;
      statusCode?: number;
      code?: string;
      cause?: unknown;
    },
  ) {
    super(message, options);
    this.name = "ProviderAuthError";
  }
}

export class ProviderNetworkError extends ProviderError {
  constructor(
    message: string,
    options?: {
      provider?: string;
      statusCode?: number;
      code?: string;
      cause?: unknown;
    },
  ) {
    super(message, options);
    this.name = "ProviderNetworkError";
  }
}

export class ProviderResponseError extends ProviderError {
  constructor(
    message: string,
    options?: {
      provider?: string;
      statusCode?: number;
      code?: string;
      cause?: unknown;
    },
  ) {
    super(message, options);
    this.name = "ProviderResponseError";
  }
}
