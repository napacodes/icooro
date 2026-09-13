import type {
  AudioProvider,
  BaseProvider,
  ImageProvider,
  TextProvider,
  VideoProvider,
} from "./types.js";

export class ProviderRegistry {
  private readonly providers = new Map<string, BaseProvider>();

  register(provider: BaseProvider): void {
    this.providers.set(provider.providerType.toLowerCase(), provider);
  }

  unregister(providerType: string): boolean {
    return this.providers.delete(providerType.toLowerCase());
  }

  get(providerType: string): BaseProvider | undefined {
    return this.providers.get(providerType.toLowerCase());
  }

  getVideoProvider(providerType: string): VideoProvider | undefined {
    const provider = this.get(providerType);
    if (provider && provider.capabilities.includes("video")) {
      return provider as unknown as VideoProvider;
    }
    return undefined;
  }

  getImageProvider(providerType: string): ImageProvider | undefined {
    const provider = this.get(providerType);
    if (provider && provider.capabilities.includes("image")) {
      return provider as unknown as ImageProvider;
    }
    return undefined;
  }

  getAudioProvider(providerType: string): AudioProvider | undefined {
    const provider = this.get(providerType);
    if (provider && provider.capabilities.includes("audio")) {
      return provider as unknown as AudioProvider;
    }
    return undefined;
  }

  getTextProvider(providerType: string): TextProvider | undefined {
    const provider = this.get(providerType);
    if (provider && provider.capabilities.includes("text")) {
      return provider as unknown as TextProvider;
    }
    return undefined;
  }

  listProviders(): Array<{
    providerType: string;
    name: string;
    capabilities: readonly string[];
  }> {
    return Array.from(this.providers.values()).map((p) => ({
      providerType: p.providerType,
      name: p.name,
      capabilities: p.capabilities,
    }));
  }

  /**
   * Sanitizes provider records before returning them to client/frontend,
   * guaranteeing no credentials or sensitive tokens are exposed.
   */
  static sanitizeProvider(providerRecord: Record<string, unknown>): Record<string, unknown> {
    const sanitized = { ...providerRecord };
    if ("config" in sanitized && sanitized.config && typeof sanitized.config === "object") {
      const config = { ...(sanitized.config as Record<string, unknown>) };
      // Strip any credential-like fields
      delete config.apiKey;
      delete config.secretKey;
      delete config.password;
      delete config.token;
      delete config.auth;
      delete config.credentials;
      sanitized.config = config;
    }
    return sanitized;
  }
}

export const providerRegistry = new ProviderRegistry();
