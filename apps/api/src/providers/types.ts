export type ProviderCapability = "text" | "image" | "video" | "audio";

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
