import { randomUUID } from "node:crypto";
import type {
  ImageGenerationParams,
  ImageProvider,
  JobStatusResult,
  MediaDownloadResult,
  ProviderCapability,
  VideoGenerationParams,
  VideoProvider,
} from "./types.js";

// Deterministic 1x1 transparent PNG buffer
const MOCK_PNG_BUFFER = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

// Minimal MP4 mock buffer
const MOCK_MP4_BUFFER = Buffer.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, // ftyp
  0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
  0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32,
]);

export class MockMediaProvider implements VideoProvider, ImageProvider {
  readonly providerType = "mock";
  readonly name = "Deterministic Mock Provider";
  readonly capabilities: readonly ProviderCapability[] = ["video", "image"];

  private readonly jobs = new Map<
    string,
    {
      type: "video" | "image";
      params: VideoGenerationParams | ImageGenerationParams;
      status: JobStatusResult;
    }
  >();

  async testConnection(): Promise<{ ok: boolean; message?: string }> {
    return { ok: true, message: "Mock provider is ready" };
  }

  async createJob(
    params: VideoGenerationParams | ImageGenerationParams,
  ): Promise<{ externalJobId: string; metadata?: Record<string, unknown> }> {
    const externalJobId = `mock_job_${randomUUID()}`;
    const isVideo = "duration" in params;

    this.jobs.set(externalJobId, {
      type: isVideo ? "video" : "image",
      params,
      status: {
        status: "processing",
        progress: 50,
      },
    });

    return {
      externalJobId,
      metadata: {
        engine: "mock",
        requestedAt: new Date().toISOString(),
      },
    };
  }

  async getJobStatus(externalJobId: string): Promise<JobStatusResult> {
    const job = this.jobs.get(externalJobId);
    if (!job) {
      return {
        status: "failed",
        error: `Mock job ${externalJobId} not found`,
      };
    }

    // Advance processing to completed
    if (job.status.status === "processing") {
      job.status = {
        status: "completed",
        progress: 100,
      };
    }

    return job.status;
  }

  async cancelJob(externalJobId: string): Promise<{ cancelled: boolean }> {
    const job = this.jobs.get(externalJobId);
    if (!job) {
      return { cancelled: false };
    }

    job.status = {
      status: "cancelled",
      error: "Job cancelled by user",
    };
    return { cancelled: true };
  }

  async downloadResult(externalJobId: string): Promise<MediaDownloadResult> {
    const job = this.jobs.get(externalJobId);
    if (!job) {
      throw new Error(`Mock job ${externalJobId} not found`);
    }

    if (job.type === "video") {
      return {
        data: MOCK_MP4_BUFFER,
        mimeType: "video/mp4",
        fileExtension: "mp4",
        fileName: `${externalJobId}.mp4`,
        fileSize: MOCK_MP4_BUFFER.byteLength,
      };
    }

    return {
      data: MOCK_PNG_BUFFER,
      mimeType: "image/png",
      fileExtension: "png",
      fileName: `${externalJobId}.png`,
      fileSize: MOCK_PNG_BUFFER.byteLength,
    };
  }
}

export const mockMediaProvider = new MockMediaProvider();
