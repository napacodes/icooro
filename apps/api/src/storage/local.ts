import * as fs from "node:fs";
import * as path from "node:path";
import {
  StorageError,
  StorageNotFoundError,
  StoragePathTraversalError,
  type StorageMetadata,
  type StorageProvider,
  type StoragePutResult,
} from "./types.js";

export class LocalStorageProvider implements StorageProvider {
  private readonly storageRoot: string;

  constructor(storageRoot: string) {
    this.storageRoot = path.resolve(storageRoot);
  }

  getStorageRoot(): string {
    return this.storageRoot;
  }

  /**
   * Safely normalizes and resolves a storage key within the storage root.
   * Throws StoragePathTraversalError if the key attempts path traversal
   * or attempts to escape the storage root.
   */
  public resolveSafePath(key: string): { normalizedKey: string; fullPath: string } {
    if (!key || typeof key !== "string" || key.trim() === "") {
      throw new StoragePathTraversalError(key);
    }

    // Reject null bytes
    if (key.includes("\0")) {
      throw new StoragePathTraversalError(key);
    }

    // Reject Windows drive letters (e.g. C:)
    if (/^[a-zA-Z]:/.test(key)) {
      throw new StoragePathTraversalError(key);
    }

    // Normalize slashes to POSIX
    const posixKey = key.replace(/\\/g, "/").trim();

    // Reject leading slashes (absolute paths)
    if (posixKey.startsWith("/")) {
      throw new StoragePathTraversalError(key);
    }

    // Check individual path segments for '.' or '..'
    const segments = posixKey.split("/").filter(Boolean);
    for (const segment of segments) {
      if (segment === ".." || segment === ".") {
        throw new StoragePathTraversalError(key);
      }
    }

    if (segments.length === 0) {
      throw new StoragePathTraversalError(key);
    }

    const normalizedKey = segments.join("/");
    const resolvedRoot = path.resolve(this.storageRoot);
    const fullPath = path.resolve(resolvedRoot, ...segments);

    // Verify the resolved path is strictly within the root
    if (!fullPath.startsWith(resolvedRoot + path.sep) && fullPath !== resolvedRoot) {
      throw new StoragePathTraversalError(key);
    }

    return { normalizedKey, fullPath };
  }

  async put(
    key: string,
    data: Buffer | Uint8Array | string,
    _options?: { mimeType?: string },
  ): Promise<StoragePutResult> {
    const { normalizedKey, fullPath } = this.resolveSafePath(key);

    try {
      await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
      const buffer = Buffer.isBuffer(data)
        ? data
        : typeof data === "string"
          ? Buffer.from(data, "utf8")
          : Buffer.from(data);

      await fs.promises.writeFile(fullPath, buffer);
      return {
        key: normalizedKey,
        size: buffer.byteLength,
      };
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw new StorageError(
        `Failed to write to storage at "${normalizedKey}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async get(key: string): Promise<Buffer> {
    const { normalizedKey, fullPath } = this.resolveSafePath(key);

    try {
      return await fs.promises.readFile(fullPath);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code: string }).code === "ENOENT"
      ) {
        throw new StorageNotFoundError(normalizedKey);
      }
      if (error instanceof StorageError) throw error;
      throw new StorageError(
        `Failed to read from storage at "${normalizedKey}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      const { fullPath } = this.resolveSafePath(key);
      await fs.promises.stat(fullPath);
      return true;
    } catch (error) {
      if (error instanceof StoragePathTraversalError) {
        throw error;
      }
      return false;
    }
  }

  async delete(key: string): Promise<boolean> {
    const { fullPath } = this.resolveSafePath(key);

    try {
      await fs.promises.unlink(fullPath);
      return true;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code: string }).code === "ENOENT"
      ) {
        return false;
      }
      if (error instanceof StorageError) throw error;
      throw new StorageError(
        `Failed to delete from storage: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async getMetadata(key: string): Promise<StorageMetadata | null> {
    const { fullPath } = this.resolveSafePath(key);

    try {
      const stat = await fs.promises.stat(fullPath);
      return {
        size: stat.size,
        lastModified: stat.mtime,
      };
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code: string }).code === "ENOENT"
      ) {
        return null;
      }
      if (error instanceof StorageError) throw error;
      throw new StorageError(
        `Failed to get metadata: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async getUrl(key: string): Promise<string> {
    const { normalizedKey } = this.resolveSafePath(key);
    return `/api/v1/storage/${normalizedKey}`;
  }
}
