export class StorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageError";
  }
}

export class StoragePathTraversalError extends StorageError {
  constructor(key: string) {
    super(`Storage path traversal detected for key: "${key}"`);
    this.name = "StoragePathTraversalError";
  }
}

export class StorageNotFoundError extends StorageError {
  constructor(key: string) {
    super(`Storage object not found for key: "${key}"`);
    this.name = "StorageNotFoundError";
  }
}

export interface StorageMetadata {
  size: number;
  lastModified: Date;
  mimeType?: string;
}

export interface StoragePutResult {
  key: string;
  size: number;
}

export interface StorageProvider {
  put(
    key: string,
    data: Buffer | Uint8Array | string,
    options?: { mimeType?: string },
  ): Promise<StoragePutResult>;
  get(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<boolean>;
  getMetadata(key: string): Promise<StorageMetadata | null>;
  getUrl(key: string): Promise<string>;
}
