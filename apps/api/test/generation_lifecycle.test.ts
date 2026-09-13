import test from "node:test";
import assert from "node:assert/strict";
import { isValidJobStatusTransition } from "../src/services/generation.js";
import type { GenerationJobStatus } from "../src/providers/types.js";

test("GenerationJob Lifecycle - Scenario 16: valid and invalid state transitions", () => {
  // 1. Valid transitions
  assert.equal(isValidJobStatusTransition("queued", "submitted"), true);
  assert.equal(isValidJobStatusTransition("queued", "cancelled"), true);
  assert.equal(isValidJobStatusTransition("queued", "failed"), true);
  assert.equal(isValidJobStatusTransition("queued", "queued"), true);

  assert.equal(isValidJobStatusTransition("submitted", "processing"), true);
  assert.equal(isValidJobStatusTransition("submitted", "cancelled"), true);
  assert.equal(isValidJobStatusTransition("submitted", "failed"), true);

  assert.equal(isValidJobStatusTransition("processing", "downloading"), true);
  assert.equal(isValidJobStatusTransition("processing", "completed"), true);
  assert.equal(isValidJobStatusTransition("processing", "cancelled"), true);
  assert.equal(isValidJobStatusTransition("processing", "failed"), true);

  assert.equal(isValidJobStatusTransition("downloading", "completed"), true);
  assert.equal(isValidJobStatusTransition("downloading", "failed"), true);

  // 2. Terminal states cannot transition to anything other than themselves
  const terminalStates: GenerationJobStatus[] = ["completed", "failed", "cancelled"];
  const allStates: GenerationJobStatus[] = [
    "queued",
    "submitted",
    "processing",
    "downloading",
    "completed",
    "failed",
    "cancelled",
  ];

  for (const terminal of terminalStates) {
    for (const target of allStates) {
      if (terminal === target) {
        assert.equal(isValidJobStatusTransition(terminal, target), true);
      } else {
        assert.equal(
          isValidJobStatusTransition(terminal, target),
          false,
          `Terminal state ${terminal} must NOT transition to ${target}`,
        );
      }
    }
  }

  // 3. Disallowed skip transitions
  assert.equal(isValidJobStatusTransition("queued", "completed"), false);
  assert.equal(isValidJobStatusTransition("queued", "downloading"), false);
  assert.equal(isValidJobStatusTransition("submitted", "completed"), false);
  assert.equal(isValidJobStatusTransition("downloading", "processing"), false);
  assert.equal(isValidJobStatusTransition("downloading", "submitted"), false);
});
