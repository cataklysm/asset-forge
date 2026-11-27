# Parallel Requests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the owner set how many analysis requests a vision provider entry gets at the same time.

**Architecture:** A new option on the vision entry; the scheduler asks a per-lane limit function before every claim; the desktop host answers it from the provider store.

**Tech Stack:** TypeScript, Zod 4, Vitest (+ jsdom), React. No new dependency, no migration.

**Spec:** `docs/superpowers/specs/2026-11-27-parallel-requests-design.md` — binding; read it first.

## Global Constraints

- Everything in the repository is English. No attribution lines in commit messages. Commit, do not push.
- Never launch the app, a browser or a dialog. Never call the network, host port 11434, a real provider or
  Docker; tests start the mock provider in-process and use the key literal `test-key-not-real`.
- Exact values: range 1–64, default 1, label `Parallel requests`, tooltip `Analysis requests sent at the same time`.
- The settings file stays version 4; an existing file must never lose an entry because of the new field.
- `parallelRequests` never reaches a request body, a job payload, the DB or a log line.
- With default values the behaviour of every existing test is unchanged.
- Renderer: no explanatory text in the layout (tooltips through `title`), tokens only, labels in `labels.ts`.
- Verification: `pnpm typecheck` and `pnpm test` (no `--` separator with `--filter`). Known flakes:
  `inbox.test.tsx > filters and scroll offset survive navigation`,
  `venice-image.test.ts > maps a refused connection to provider_unreachable`.

## Review Focus

- A settings file written before this change: every entry survives and reads as 1.
- Lowering the value while more requests run than the new value: none is aborted, none starts until below.
- A `laneLimit` that throws or answers nonsense: the scheduler keeps running with the class limit.
- A paused provider with a high value claims nothing; resuming starts up to the value.
- A `venice` lane keeps two generations at a time whatever any vision entry is set to.

Each has a test in Task 1.

---

### Task 1: Parallel requests end to end

**Files:**
- Modify: `packages/contracts/src/settings.ts`
- Modify: `packages/jobs/src/scheduler.ts`
- Modify: `apps/desktop/src/main/provider-store.ts`, `job-host.ts`, `composition.ts`
- Modify: `apps/desktop/src/renderer/src/components/ProviderSettings.tsx`, `labels.ts`
- Modify: `ReadMe.md`, `docs/backlog.md`
- Tests: the existing test files beside each of these

**Interfaces (produces):**
- `PARALLEL_REQUESTS_MIN`, `PARALLEL_REQUESTS_MAX`, `PARALLEL_REQUESTS_DEFAULT`; `ProviderOptions.parallelRequests: number`
- `SchedulerOptions.laneLimit?(resourceClass: ResourceClass, lane: string | null): number | undefined`
- `JobHostDeps.laneLimit?` with the same signature

- [ ] Write the failing tests of the spec's Tests section and the five Review Focus lines.
- [ ] Run them and see them fail.
- [ ] Implement per the spec. Fix every fixture that builds `ProviderOptions` by hand.
- [ ] Update `ReadMe.md` and `docs/backlog.md` per the spec's Documentation section.
- [ ] `pnpm typecheck` and `pnpm test` green.
- [ ] Commit: `feat: parallel analysis requests per vision provider`.
