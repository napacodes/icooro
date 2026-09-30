# POST /projects/:projectId/production-plans/:id/generate

C8.1 — the media-generation entry point for an approved Production Plan.
It turns the plan's tracked planning output into queued generation jobs using
the existing C6 generation infrastructure. It does not execute, poll, or
download anything itself: the queued jobs are picked up by the existing
generation executor exactly like manual jobs.

## Method and route

```
POST /api/v1/projects/:projectId/production-plans/:planId/generate
```

## Authentication and ownership

- Requires an authenticated session (session cookie); unauthenticated
  requests get `401`.
- The project must exist and belong to the caller. A missing or foreign
  project is an indistinguishable `404` (`"Project not found"`) — never a
  `403`, matching every other plan endpoint. Admin users bypass the
  ownership check.
- The plan must belong to the requested project. A plan addressed under a
  different project is an indistinguishable `404`
  (`"Production plan not found"`).

## Approved-plan requirement

Media generation starts only from a plan in the terminal `approved` status,
reached through the user-driven review flow (`PATCH` with
`ready_for_review`, then `approved`). This endpoint never approves,
un-approves, or otherwise changes plan status.

| Current plan status | Result |
| --- | --- |
| `approved` | Proceeds |
| `planning` | `409 CONFLICT` |
| `ready_for_review` | `409 CONFLICT` |
| `cancelled` | `409 CONFLICT` |
| `failed` | `409 CONFLICT` |

The approval gate is checked before the work starts and re-checked inside
the plan-row-lock transaction, so a plan cancelled while a request was in
flight is refused.

## Request body

None. The request is body-less; the approved plan's tracked production data
is the entire input. A request body, if sent, is ignored.

## Eligible shots and prompts

Eligibility comes from the tracked planning references the C7.4/C7.5 stage
services recorded in the plan payload (`sceneIds` and the `shotIds` map,
scene id → shot ids). Manual scenes and shots are never targets.

A tracked shot is eligible when:

1. Its tracked scene still exists in the plan's anchored episode (the plan
   row's `episodeId`, else the payload's `episodeId`).
2. The tracked shot still exists in that scene.
3. The shot carries a non-empty media prompt (the C7.6 output, or a
   hand-authored prompt on a tracked shot).

Tracked shots that fail any of these checks are reported in `failed` with a
reason; they never abort the whole request and never silently generate from
stale references.

Request-level preconditions (missing/foreign episode, no tracked shots, plan
not anchored) are returned as HTTP errors:

| Condition | Status |
| --- | --- |
| Plan not anchored to an episode | `400 INVALID_REQUEST` |
| Plan has no tracked shots | `400 INVALID_REQUEST` |
| Anchored episode not found in the project | `404 NOT_FOUND` |

## Provider and model routing

The endpoint never names a provider or model. Every job is created through
the existing generation-job service with the fixed job type
`text-to-video` (`PLAN_GENERATION_JOB_TYPE`) and `targetMediaType: "video"`,
so the existing C6.8.2 automatic routing selects the deterministic default:
the earliest-created enabled model bound to an enabled provider whose
capability and declared `jobTypes` cover `text-to-video`.

When no eligible model exists, each affected shot is reported in `failed`
with the routing error (e.g. `No enabled model configured for
"text-to-video"`); no jobs are created.

## Duplicate-submission semantics

Duplicate prevention is per shot and scoped to jobs this plan itself
created (matched on shot id + job type + `metadata.productionPlanId`).

- A tracked shot with a still-active job of this plan (`queued`,
  `submitted`, `processing`, `downloading`) is reported in `alreadyActive`
  instead of getting a second job.
- Terminal jobs (`completed`, `failed`, `cancelled`) never block
  regeneration: submitting the same approved plan again after a job
  finished creates a new job for that shot.
- Manual C6 jobs on the same shot (no `productionPlanId` in their metadata)
  are unrelated work and are never hijacked or deduplicated.

### Concurrency guarantee

The deduplication check and job creation run while the plan's database row
lock is held (`SELECT ... FOR UPDATE` on the plan row — the repository's
established `completeJobWithAssetVersion` pattern). Two concurrent requests
for the same plan serialize: the second one re-reads active jobs inside its
transaction after the first has committed, and therefore reports the first
request's jobs in `alreadyActive` instead of creating duplicates. Requests
for different plans take different row locks and do not block each other.

## Plan payload tracking

Every successfully created job id is appended to the plan payload's
`generatedJobIds` (flat string array, same convention as `promptedShotIds`).
The list is append-only and duplicate-free, and merged over the freshest
payload read inside the lock, so unrelated payload keys (story, scene/shot
tracking, `promptedShotIds`, user keys) survive, and a concurrent payload
edit is not overwritten. The list records provenance only — `ai_jobs`
remains the single source of truth for job status, and no operational job
state is copied into the plan payload.

## Response

`200 OK` with the standard success envelope:

```json
{ "data": { ...PlanGenerationReport } }
```

### PlanGenerationReport fields

| Field | Type | Meaning |
| --- | --- | --- |
| `productionPlanId` | `string` | The plan the work belongs to. |
| `status` | `"completed" \| "partial" \| "failed"` | Aggregate outcome. `completed`: every tracked shot accepted. `partial`: some accepted. `failed`: none accepted. |
| `jobType` | `GenerationJobType` | Always `"text-to-video"` for this endpoint. |
| `created` | `PlanGenerationJobRef[]` | Jobs newly created by this call, always with `status: "queued"`. |
| `alreadyActive` | `PlanGenerationJobRef[]` | This plan's still-active jobs for tracked shots, found by duplicate-submission deduplication. |
| `failed` | `PlanGenerationItemFailure[]` | Tracked shots that were rejected, with the reason. |

Each `PlanGenerationJobRef` is `{ sceneId, shotId, jobId, status }`. Each
`PlanGenerationItemFailure` is `{ sceneId, shotId, reason }`.

`created` and `alreadyActive` carry the identifiers and statuses a UI needs
to display the accepted work. A partial outcome never hides already-created
work.

## Partial success and per-shot failure

Each tracked shot is accepted or rejected independently:

- `status: "completed"` — every eligible shot appears in `created` or
  `alreadyActive`, `failed` is empty.
- `status: "partial"` — some shots were accepted; `failed` lists the rest
  with reasons (e.g. missing prompt, deleted shot, routing failure).
  Everything in `created` is real, committed work.
- `status: "failed"` — no shot was accepted; `failed` explains each one.

## Job lifecycle after this endpoint

Created jobs are ordinary `ai_jobs` rows in `queued` status, linked to the
project, episode, scene, and shot, with the shot's prompt and the plan
reference in metadata. They proceed through the existing generation
executor and polling lifecycle:

```
queued → submitted → processing → downloading → completed
```

with `failed`/`cancelled` as terminal states — the same lifecycle manual C6
jobs use (`POST /jobs/:id/submit`, `POST /jobs/:id/poll`,
`POST /jobs/:id/persist-result`).

## Examples

### Successful initiation

Request:

```
POST /api/v1/projects/p_1/production-plans/plan_1/generate
```

Response (two eligible tracked shots):

```json
{
  "data": {
    "productionPlanId": "plan_1",
    "status": "completed",
    "jobType": "text-to-video",
    "created": [
      {
        "sceneId": "scene_1",
        "shotId": "shot_1",
        "jobId": "job_1",
        "status": "queued"
      },
      {
        "sceneId": "scene_1",
        "shotId": "shot_2",
        "jobId": "job_2",
        "status": "queued"
      }
    ],
    "alreadyActive": [],
    "failed": []
  }
}
```

### Partial failure

One shot has no prompt; the other is fine:

```json
{
  "data": {
    "productionPlanId": "plan_1",
    "status": "partial",
    "jobType": "text-to-video",
    "created": [
      {
        "sceneId": "scene_1",
        "shotId": "shot_1",
        "jobId": "job_1",
        "status": "queued"
      }
    ],
    "alreadyActive": [],
    "failed": [
      {
        "sceneId": "scene_1",
        "shotId": "shot_2",
        "reason": "The tracked shot has no media prompt to generate from."
      }
    ]
  }
}
```

### Duplicate submission

Re-submitting the same approved plan while its jobs are still in flight:

```json
{
  "data": {
    "productionPlanId": "plan_1",
    "status": "completed",
    "jobType": "text-to-video",
    "created": [],
    "alreadyActive": [
      {
        "sceneId": "scene_1",
        "shotId": "shot_1",
        "jobId": "job_1",
        "status": "queued"
      },
      {
        "sceneId": "scene_1",
        "shotId": "shot_2",
        "jobId": "job_2",
        "status": "queued"
      }
    ],
    "failed": []
  }
}
```

### Error responses

Standard error envelope `{ "error": { "code", "message" } }`:

```json
{ "error": { "code": "CONFLICT", "message": "Media generation can only start from an approved production plan (current status: \"ready_for_review\"). Move the plan through review and approval first." } }
```

```json
{ "error": { "code": "NOT_FOUND", "message": "Production plan not found" } }
```

```json
{ "error": { "code": "INVALID_REQUEST", "message": "This production plan has no tracked shots to generate. Generate scenes and shots first (C7.4/C7.5) before starting media generation." } }
```

---

# POST /projects/:projectId/production-plans/:id/execute

C8.2 — execution initiation for the generation jobs C8.1 created from an
approved Production Plan. It hands those EXISTING `ai_jobs` rows to the
existing generation executor so the provider submission starts now, instead
of waiting for a manual `POST /jobs/:id/submit` per job. It creates no jobs,
calls no provider itself, runs no polling, and persists no results: polling,
downloading, and asset-version creation remain the existing lifecycle's
responsibility.

## Method and route

```
POST /api/v1/projects/:projectId/production-plans/:planId/execute
```

## Authentication and ownership

- Requires an authenticated session (session cookie); unauthenticated
  requests get `401`.
- The project must exist and belong to the caller. A missing or foreign
  project is an indistinguishable `404` (`"Project not found"`). Admin
  users bypass the ownership check.
- The plan must belong to the requested project. A plan addressed under a
  different project is an indistinguishable `404`
  (`"Production plan not found"`).

## Approved-plan requirement

Execution starts only from a plan in the terminal `approved` status. This
endpoint never approves, un-approves, or otherwise changes plan status.

| Current plan status | Result |
| --- | --- |
| `approved` | Proceeds |
| any other status | `409 CONFLICT` |

## Request body

None. The jobs to execute come exclusively from the plan payload's durable
`generatedJobIds` tracking list (written by C8.1's `/generate`). Caller
supplied ids are never accepted, so a request cannot execute arbitrary jobs.

| Condition | Status |
| --- | --- |
| Plan has no tracked generation jobs | `400 INVALID_REQUEST` |
| Plan not found / foreign | `404 NOT_FOUND` |
| Plan not approved | `409 CONFLICT` |

## Job selection and eligibility

Each tracked id is resolved and verified independently. A job is submitted
only when:

1. The tracked id resolves to an existing `ai_jobs` row.
2. The row belongs to the requested project.
3. The row's `metadata.productionPlanId` equals the requested plan
   (plan provenance — manual C6 jobs on the same shot are never hijacked).
4. Its job type is `text-to-video` (`PLAN_GENERATION_JOB_TYPE`).
5. It points at a real shot (`shotId` is set).
6. Its status is `queued`.
7. The shot→scene→episode→project chain is intact: the shot exists, sits
   in the job's recorded scene, the scene is anchored to the plan's
   episode in the requesting project, and the scene is a member of the
   plan's tracked `sceneIds` payload set. This check is fail closed: the
   C7.4→C8.1 chain always records `sceneIds`, so a plan payload without
   it cannot prove membership and its tracked jobs are skipped rather
   than submitted.

Tracked ids failing any check are reported per job, never abort the whole
request, and never expose information about unrelated records.

## Active and terminal handling

Status dispatch follows the real `ai_jobs` lifecycle:

| Job status | Outcome |
| --- | --- |
| `queued` | Submitted through the executor (→ `submitted`, or → `failed` on provider error). |
| `submitted` / `processing` / `downloading` | `alreadyActive` — never submitted a second time. |
| `completed` / `failed` / `cancelled` | `skipped` with a reason — terminal jobs are never silently treated as active and never auto-regenerated here. |
| unknown value | `skipped` with a reason. |
| id no longer resolves | `skipped` ("no longer exists"). |
| context mismatch | `skipped` — stale payload ids are never executed. |

### Concurrency guarantee

Submission goes through `GenerationExecutorService.submitJob` — the same
code path as the standalone `POST /jobs/:id/submit` endpoint. Duplicate
prevention is the executor's existing queued-status state check plus its
in-process concurrent-submission guard (`submissionsInFlight`). Two
concurrent plan executions in one process cannot double-submit a job; a job
that moves status between the eligibility read and the submit is reported
as `alreadyActive` (the executor's `ExecutorInvalidStateError` maps there).
Multi-instance deployments were never protected by that guard and this
endpoint does not claim otherwise. No new locking mechanism or schema
migration was added.

## Executor reuse and asynchronous lifecycle

The endpoint is submission-only. On success the executor transitions the
row `queued → submitted`, persists the provider's `externalJobId`, and
provider/model resolution, capability checks and `safeErrorMessage`
sanitization are all the executor's own. A provider-level submission error
is converted by the executor into `queued → failed` with a sanitized
persisted error (URLs → `[url]`, keys → `[redacted]`); the report surfaces
that sanitized reason only — never raw provider responses or secrets.

After submission the job continues through the existing lifecycle untouched
(`POST /jobs/:id/poll`, `POST /jobs/:id/persist-result`):

```
queued → submitted → processing → downloading → completed
```

## Response

`200 OK` with the standard success envelope:

```json
{ "data": { ...PlanExecutionReport } }
```

### PlanExecutionReport fields

| Field | Type | Meaning |
| --- | --- | --- |
| `productionPlanId` | `string` | The plan whose jobs were initiated. |
| `status` | `"completed" \| "partial" \| "failed"` | Aggregate initiation outcome. `completed`: every tracked job submitted or already active. `partial`: some succeeded. `failed`: none did. |
| `jobType` | `GenerationJobType` | Always `"text-to-video"` for this endpoint. |
| `submitted` | `PlanExecutionItem[]` | Jobs handed to the executor by this call; each entry's `status` is `"submitted"`. |
| `alreadyActive` | `PlanExecutionItem[]` | Jobs already in flight, not resubmitted. |
| `skipped` | `PlanExecutionItem[]` | Jobs not attempted (terminal, missing, context-mismatched, unsupported type), with a reason. |
| `failed` | `PlanExecutionItem[]` | Jobs whose submission was attempted and failed, with a sanitized reason. |

Each `PlanExecutionItem` is
`{ jobId, shotId, sceneId, status, outcome, reason? }` — `shotId`/`sceneId`
when the row was resolved (else `null`), `status` the job's current or
resulting status, `outcome` one of `"submitted" \| "already_active" \|
"skipped" \| "failed"`, and `reason` present for skipped/failed entries.
Counts are derived from the per-job entries; no `ai_jobs` records are
returned. `ai_jobs` remains the source of truth for job status — nothing is
written back into `generatedJobIds`.

## Retry semantics

The endpoint is safe to retry:

- Jobs submitted by a previous request are now `submitted`/`processing`
  and come back as `alreadyActive` — never double-submitted.
- Terminal jobs stay `skipped` and are never regenerated by retrying.
- A submission that failed (`failed`) leaves the row in terminal `failed`;
  retrying the endpoint does not resubmit it — creating replacement work
  remains C8.1's `/generate` (which deduplicates against active jobs).

## Examples

### Successful initiation

Request:

```
POST /api/v1/projects/p_1/production-plans/plan_1/execute
```

Response:

```json
{
  "data": {
    "productionPlanId": "plan_1",
    "status": "completed",
    "jobType": "text-to-video",
    "submitted": [
      {
        "jobId": "job_1",
        "shotId": "shot_1",
        "sceneId": "scene_1",
        "status": "submitted",
        "outcome": "submitted"
      }
    ],
    "alreadyActive": [],
    "skipped": [],
    "failed": []
  }
}
```

### Partial outcome

One job submitted, one already processing, one terminal:

```json
{
  "data": {
    "productionPlanId": "plan_1",
    "status": "partial",
    "jobType": "text-to-video",
    "submitted": [
      {
        "jobId": "job_1",
        "shotId": "shot_1",
        "sceneId": "scene_1",
        "status": "submitted",
        "outcome": "submitted"
      }
    ],
    "alreadyActive": [
      {
        "jobId": "job_2",
        "shotId": "shot_2",
        "sceneId": "scene_1",
        "status": "processing",
        "outcome": "already_active"
      }
    ],
    "skipped": [
      {
        "jobId": "job_3",
        "shotId": "shot_3",
        "sceneId": "scene_2",
        "status": "completed",
        "outcome": "skipped",
        "reason": "The tracked job is already in terminal status \"completed\" and will not be regenerated by this endpoint."
      }
    ],
    "failed": []
  }
}
```

### Submission failure

A provider error was sanitized by the executor:

```json
{
  "data": {
    "productionPlanId": "plan_1",
    "status": "failed",
    "jobType": "text-to-video",
    "submitted": [],
    "alreadyActive": [],
    "skipped": [],
    "failed": [
      {
        "jobId": "job_1",
        "shotId": "shot_1",
        "sceneId": "scene_1",
        "status": "failed",
        "outcome": "failed",
        "reason": "ProviderError: upstream exploded apiKey=[redacted] [url]"
      }
    ]
  }
}
```

### Error responses

Standard error envelope `{ "error": { "code", "message" } }`:

```json
{ "error": { "code": "CONFLICT", "message": "Execution can only start from an approved production plan (current status: \"ready_for_review\"). Move the plan through review and approval first." } }
```

```json
{ "error": { "code": "INVALID_REQUEST", "message": "This production plan has no tracked generation jobs to execute. Start media generation first (POST .../generate)." } }
```

```json
{ "error": { "code": "NOT_FOUND", "message": "Production plan not found" } }
```
