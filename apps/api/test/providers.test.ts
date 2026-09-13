import test from "node:test";
import assert from "node:assert/strict";
import { ProviderRegistry } from "../src/providers/registry.js";
import { MockMediaProvider } from "../src/providers/mock.js";

test("ProviderRegistry - Scenario 15: registration, capability lookups, and credential stripping", () => {
  const registry = new ProviderRegistry();
  const mockProvider = new MockMediaProvider();

  // 1. Initially empty
  assert.equal(registry.get("mock"), undefined);
  assert.equal(registry.listProviders().length, 0);

  // 2. Register
  registry.register(mockProvider);
  assert.ok(registry.get("mock"));
  assert.equal(registry.get("MOCK")?.providerType, "mock"); // Case-insensitive

  // 3. Capability lookups
  assert.ok(registry.getVideoProvider("mock"));
  assert.ok(registry.getImageProvider("mock"));
  assert.equal(registry.getAudioProvider("mock"), undefined);
  assert.equal(registry.getTextProvider("mock"), undefined);

  // 4. List providers
  const list = registry.listProviders();
  assert.equal(list.length, 1);
  assert.equal(list[0]?.name, "Deterministic Mock Provider");
  assert.deepEqual(list[0]?.capabilities, ["video", "image"]);

  // 5. Credential stripping
  const rawProviderRecord = {
    id: "prov_123",
    name: "Vendor AI",
    providerType: "vendor",
    config: {
      baseUrl: "https://api.vendor.com",
      apiKey: "sk-super-secret-key-12345",
      secretKey: "shhh",
      token: "bearer-xyz",
      password: "pass",
      auth: "basic",
      credentials: { user: "admin" },
      timeoutMs: 30000,
    },
  };

  const sanitized = ProviderRegistry.sanitizeProvider(rawProviderRecord) as typeof rawProviderRecord;
  assert.equal(sanitized.id, "prov_123");
  assert.equal(sanitized.config.baseUrl, "https://api.vendor.com");
  assert.equal(sanitized.config.timeoutMs, 30000);
  assert.equal((sanitized.config as any).apiKey, undefined);
  assert.equal((sanitized.config as any).secretKey, undefined);
  assert.equal((sanitized.config as any).token, undefined);
  assert.equal((sanitized.config as any).password, undefined);
  assert.equal((sanitized.config as any).auth, undefined);
  assert.equal((sanitized.config as any).credentials, undefined);

  // 6. Unregister
  const unregistered = registry.unregister("mock");
  assert.equal(unregistered, true);
  assert.equal(registry.get("mock"), undefined);
});

test("MockMediaProvider - Scenario 16 (Provider media generation): deterministic image and video mock outputs", async () => {
  const provider = new MockMediaProvider();

  // Test image generation
  const imageJob = await provider.createJob({
    prompt: "a cinematic landscape",
    width: 512,
    height: 512,
  });
  assert.ok(imageJob.externalJobId.startsWith("mock_job_"));

  const imageStatus = await provider.getJobStatus(imageJob.externalJobId);
  assert.equal(imageStatus.status, "completed");
  assert.equal(imageStatus.progress, 100);

  const imageMedia = await provider.downloadResult(imageJob.externalJobId);
  assert.equal(imageMedia.mimeType, "image/png");
  assert.equal(imageMedia.fileExtension, "png");
  assert.ok(imageMedia.data.length > 0);
  // PNG signature check
  assert.equal(imageMedia.data[0], 0x89);
  assert.equal(imageMedia.data[1], 0x50); // P
  assert.equal(imageMedia.data[2], 0x4e); // N
  assert.equal(imageMedia.data[3], 0x47); // G

  // Test video generation
  const videoJob = await provider.createJob({
    prompt: "a cinematic scene panning across a river",
    duration: 5,
    width: 1280,
    height: 720,
    fps: 24,
  });
  assert.ok(videoJob.externalJobId.startsWith("mock_job_"));

  const videoStatus = await provider.getJobStatus(videoJob.externalJobId);
  assert.equal(videoStatus.status, "completed");
  assert.equal(videoStatus.progress, 100);

  const videoMedia = await provider.downloadResult(videoJob.externalJobId);
  assert.equal(videoMedia.mimeType, "video/mp4");
  assert.equal(videoMedia.fileExtension, "mp4");
  assert.ok(videoMedia.data.length > 0);
  // MP4 ftyp box signature check
  assert.equal(videoMedia.data.toString("ascii", 4, 8), "ftyp");
});
