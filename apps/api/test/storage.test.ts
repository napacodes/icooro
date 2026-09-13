import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { LocalStorageProvider } from "../src/storage/local.js";
import { StorageNotFoundError, StoragePathTraversalError } from "../src/storage/types.js";

test("LocalStorageProvider - Scenario 13: write, read, exists, delete, metadata", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "icooro-storage-test-"));
  const storage = new LocalStorageProvider(tmpDir);

  try {
    const testKey = "projects/proj_1/assets/image.png";
    const testData = Buffer.from("fake-png-content-data");

    // 1. Check exists (should be false before put)
    const existsBefore = await storage.exists(testKey);
    assert.equal(existsBefore, false);

    // 2. Put object
    const putResult = await storage.put(testKey, testData, {
      mimeType: "image/png",
    });
    assert.equal(putResult.key, testKey);
    assert.equal(putResult.size, testData.length);

    // 3. Check exists (should be true)
    const existsAfter = await storage.exists(testKey);
    assert.equal(existsAfter, true);

    // 4. Get object
    const readBuffer = await storage.get(testKey);
    assert.deepEqual(readBuffer, testData);

    // 5. Get metadata
    const metadata = await storage.getMetadata(testKey);
    assert.ok(metadata);
    assert.equal(metadata.size, testData.length);
    assert.ok(metadata.lastModified instanceof Date);

    // 6. Delete object
    await storage.delete(testKey);

    // 7. Check exists after delete
    const existsAfterDelete = await storage.exists(testKey);
    assert.equal(existsAfterDelete, false);

    // 8. Getting non-existent object throws StorageNotFoundError
    await assert.rejects(async () => {
      await storage.get(testKey);
    }, StorageNotFoundError);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("LocalStorageProvider - Scenario 14: strict path traversal prevention", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "icooro-traversal-test-"));
  const storage = new LocalStorageProvider(tmpDir);

  try {
    const maliciousKeys = [
      "../outside.txt",
      "..\\outside.txt",
      "assets/../../secret.txt",
      "assets\\..\\..\\secret.txt",
      "/etc/passwd",
      "C:\\Windows\\System32\\cmd.exe",
      "D:/some/file.txt",
      "foo\0bar.txt",
      "..",
      ".",
      "assets/./../../etc/hosts",
    ];

    for (const key of maliciousKeys) {
      // put should reject
      await assert.rejects(
        async () => {
          await storage.put(key, Buffer.from("malicious"));
        },
        StoragePathTraversalError,
        `Expected path traversal rejection for key: ${key}`,
      );

      // get should reject
      await assert.rejects(
        async () => {
          await storage.get(key);
        },
        StoragePathTraversalError,
        `Expected path traversal rejection for key: ${key}`,
      );

      // exists should reject
      await assert.rejects(
        async () => {
          await storage.exists(key);
        },
        StoragePathTraversalError,
        `Expected path traversal rejection for key: ${key}`,
      );

      // delete should reject
      await assert.rejects(
        async () => {
          await storage.delete(key);
        },
        StoragePathTraversalError,
        `Expected path traversal rejection for key: ${key}`,
      );
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
