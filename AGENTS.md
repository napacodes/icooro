\# Icooro — Agent Engineering Protocol



\## 1. Project Identity



Icooro is an AI video production platform.



The system is developed incrementally through controlled engineering phases.



Completed phases:



\- C1 — Projects Foundation

\- C2 — Storytelling Foundation

\- C3 — Creative Production Foundation

\- C4 — Media / Asset Foundation
\- C5 — Real AI Generation



Stable C5 baseline:



\- Main merge commit: `dd56e44`



Historical C4 baseline:

\- Main merge commit: `c35ceed`
\- C4 implementation commit: `b824945`



\---



\# 2. Architecture Ownership



The Icooro architecture is controlled by the project owner and external architectural review.



The coding agent is an implementation worker.



The agent MUST NOT independently redesign:



\- database architecture

\- domain model

\- project hierarchy

\- episode / scene / shot model

\- asset / asset-version model

\- API architecture

\- provider architecture

\- storage architecture

\- generation lifecycle

\- production workflow



If the agent believes the architecture should change:



1\. Do not redesign it.

2\. Do not implement the redesign.

3\. Report the observation in the final report.



\---



\# 3. Scope Lock



Implement ONLY the requirements explicitly stated in the current task.



Do not:



\- add unrelated features

\- refactor unrelated code

\- redesign completed phases

\- introduce speculative abstractions

\- upgrade dependencies without approval

\- modify authentication unless requested

\- modify billing unless requested

\- modify SaaS infrastructure unless requested

\- add providers unless requested

\- add timeline/rendering functionality unless requested

\- generate real media unless explicitly requested



If an unrelated issue is discovered:



\- do not fix it

\- do not expand scope

\- report it under `Unresolved Observations`



\---



\# 4. Repository Safety



Before modifying code:



1\. Inspect the current Git branch.

2\. Confirm the working tree state.

3\. Inspect the relevant existing files.

4\. Understand the existing implementation before changing it.



The agent MUST NOT:



\- reset

\- rebase

\- cherry-pick

\- force push

\- delete branches

\- merge branches

\- modify `main`

\- commit

\- push



unless explicitly instructed.



The human controls Git checkpoints.



\---



\# 5. Phase Discipline



Each phase follows:



Design

â†’ Specification

â†’ Implementation

â†’ Tests

â†’ Independent Audit

â†’ Targeted Corrections

â†’ Verification

â†’ Commit

â†’ Push

â†’ Merge to main

â†’ Main Verification

â†’ Next Phase



Never skip the independent audit because the implementation agent reports success.



\---



\# 6. Database Rules



Database changes must include:



\- Drizzle schema updates

\- migration

\- appropriate foreign keys

\- appropriate indexes

\- validation where applicable

\- regression tests



Never modify an already committed migration.



Create a new migration for subsequent schema changes.



Preserve existing data and relationships unless the task explicitly requires a migration strategy.



\---



\# 7. API Rules



API endpoints must:



\- validate input

\- enforce project ownership/isolation

\- return appropriate HTTP errors

\- prevent cross-project resource access

\- preserve existing contracts unless explicitly changed



Never bypass service-layer ownership checks merely for convenience.



\---



\# 8. Frontend Rules



Frontend changes must:



\- use the existing Nuxt/Vue architecture

\- preserve existing workflows

\- remain aligned with backend contracts

\- avoid unnecessary redesign

\- avoid introducing UI for future-phase functionality



Prefer small focused UI changes.



\---



\# 9. Asset and Media Architecture



Icooro owns the media domain.



Icooro is the source of truth for:



\- Assets

\- Asset Versions

\- prompts

\- generation jobs

\- media metadata

\- storage metadata

\- production state

\- approval state



External AI providers generate media.



External providers MUST NOT become the source of truth for Icooro's asset model.



\---



\# 10. Provider Architecture



Providers must fit the existing provider abstraction.



Do not couple application domain logic directly to a specific provider.



Provider-specific code belongs behind the provider interface.



The system should remain capable of supporting multiple providers.



Do not introduce a provider-specific architecture that prevents future providers.



\---



\# 11. Storage Architecture



Media storage belongs behind the storage abstraction.



The current implementation may use local storage.



Future storage providers such as S3 or R2 must fit the existing abstraction.



Do not bypass the storage abstraction for convenience.



\---



\# 12. Generation Architecture



The intended lifecycle is:



queued

â†’ submitted

â†’ processing

â†’ downloading

â†’ completed



Failure and cancellation are terminal states.



Generation jobs must remain associated with Icooro's asset/version model.



Provider-specific job identifiers are implementation details.



Icooro's generation job remains the application source of truth.



\---



\# 13. Testing Requirements



Every implementation must include appropriate tests.



Before declaring a task complete, run:



```text

corepack pnpm test

corepack pnpm typecheck

corepack pnpm build

git diff --check
```

\---

\# 14. Production Plan Orchestration (C7.7)

Planning-time AI generation is orchestrated by one synchronous, user-triggered endpoint:

\- `POST /projects/:projectId/production-plans/:id/orchestrate`

An optional body `{ "to": stage }` bounds the sequence to the requested stage:

\- story → script → scenes → shots → prompts

The orchestrator calls the existing C7.2–C7.6 stage services directly.
It performs no internal HTTP calls and adds no new validation.

Orchestration is gap-fill ONLY:

\- existing valid story and script outputs are skipped, never regenerated
\- existing tracked scenes and shots are kept as-is
\- prompts are generated only for tracked shots whose prompt is still empty
\- manual scenes, shots and prompts are never targets and never overwritten

Missing tracked content is reported, never recreated:

\- tracked scenes or shots that no longer exist are listed in `missingTrackedIds`
\- the affected stage is reported `partial` and the run continues
\- recreate them explicitly with the per-stage C7.4 / C7.5 endpoints

Stage behavior and reporting:

\- the run stops at the first failed stage; later stages are reported `not_run`
\- earlier successful stages keep their persisted output
\- the response is a structured report: overall `completed` / `partial` / `failed`, per-stage status, counts, reasons and the final plan payload
\- stage failures are report data (HTTP 200); only preflight failures (body, ownership, plan status, concurrency) are HTTP errors

Plan status discipline:

\- orchestration never changes the plan status; it stays `planning`
\- review and approval remain user-triggered via the C7.1 PATCH endpoint

Concurrency:

\- a second concurrent orchestration of the same plan is rejected with 409
\- the guard is process-local; it is NOT a distributed lock
\- multi-instance deployments could run the same plan concurrently

Execution boundary:

\- orchestration is synchronous; each stage completes before the next starts
\- no `ai_jobs`, `shot_versions`, assets or media generation are created or triggered
\- the media-generation handoff remains a later milestone

Verification baseline (main merge commit `2c661f5`):

\- 12 focused orchestration tests passed
\- 378 full API tests passed
