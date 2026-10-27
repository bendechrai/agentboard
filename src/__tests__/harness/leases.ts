/**
 * Shared fixtures of the lease, queue and grant process tests
 * (add-claim-leases group 5: `lease-race-processes.test.ts`,
 * `lease-queue-processes.test.ts`, `lease-crash-processes.test.ts` and the
 * `lease-replicas-*.test.ts` files): the repetition count, the lease
 * constants, `show` and `rebuild --check` through the built CLI, waiting
 * for a `claim --wait` child's queued line, reading an events directory in
 * fold order, and `expectExclusion`, an independent walk of the fold that
 * checks mutual exclusion at every fold position.
 *
 * The scenarios are split over several files so vitest runs them in
 * parallel workers: each one repeats its scenario `RUNS` times.
 *
 * Time: walls are taken from the real clock when a board is seeded, and a
 * child that must see a later time runs with the harness's clock offset
 * (`clockOffsetMs`, margins of tens of seconds or more) or, to stand
 * exactly on a boundary, on a stopped clock (`clockFixedMs`). No test
 * sleeps to let time pass.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect } from 'vitest';

import { canonicalDecode, sha256Hex } from '../../events/canonical.js';
import {
  applyEvent,
  compareFoldOrder,
  type BoardState,
  type FoldInput,
  type Ticket,
} from '../../events/fold.js';
import { validateEvent, type BoardEvent } from '../../events/schema.js';
import { eventNames } from '../../store/__tests__/helpers.js';
import {
  oneDocument,
  startCli,
  type CliProcess,
  type Invocation,
  type ProcessResult,
  type RunEnv,
} from './processes.js';

/** How often each scenario is repeated (tasks.md 5.1: at least 20 times without a flake). */
export const RUNS = 20;

/** Generous: each scenario spawns hundreds of processes over its runs. */
export const SCENARIO_TIMEOUT_MS = 600_000;

export const T1 = '01ARYZ6S41TSV4RRFFQ69G5FAV';
/** `LEASE_SKEW_MS`. */
export const SKEW = 60_000;
/** The default `lease.grace`. */
export const GRACE = 120_000;
/** The default `queue.window`. */
export const WINDOW = 120_000;
/** `--ttl 30m`. */
export const TTL = 1_800_000;

/** Clock options of one invocation: none, an offset, or a stopped clock. */
export type Clock = { offset: number } | { at: number } | null;

/** The clock fields of an `Invocation` for `clock`. */
export function clockOf(clock: Clock): Pick<Invocation, 'clockOffsetMs' | 'clockFixedMs'> {
  if (clock === null) {
    return {};
  }
  return 'offset' in clock ? { clockOffsetMs: clock.offset } : { clockFixedMs: clock.at };
}

/** Runs `argv` to completion in `cwd` on `clock`, with `env` when given. */
export function cli(
  argv: readonly string[],
  cwd: string,
  clock: Clock = null,
  env?: RunEnv,
): Promise<ProcessResult> {
  return startCli({ argv, ...clockOf(clock), ...(env === undefined ? {} : { env }) }, cwd).exited;
}

/** Like `cli`, and the command must exit 0. */
export async function cliOk(
  argv: readonly string[],
  cwd: string,
  clock: Clock = null,
  env?: RunEnv,
): Promise<ProcessResult> {
  const out = await cli(argv, cwd, clock, env);
  expect(out.code, `${argv.join(' ')}: ${out.stderr}`).toBe(0);
  return out;
}

/** `show T1 --json` (or `ticket`) on `clock`: the ticket document. */
export async function show(
  root: string,
  clock: Clock = null,
  env?: RunEnv,
  ticket = T1,
): Promise<Ticket> {
  const out = await cliOk(['show', ticket, '--json'], root, clock, env);
  return (oneDocument(out) as { ticket: Ticket }).ticket;
}

/** `rebuild --check --json` in `root` reports no divergence. */
export async function expectCheckClean(root: string, env?: RunEnv, label = ''): Promise<void> {
  const out = await cli(['rebuild', '--check', '--json'], root, null, env);
  expect(out.code, `${label} rebuild --check: ${out.stdout} ${out.stderr}`).toBe(0);
  expect(oneDocument(out), label).toMatchObject({ ok: true, differences: [] });
}

/** The `--json` error document of a refused command. */
export function errorOf(result: ProcessResult): { reason: string; message: string } {
  const doc = oneDocument(result) as { error?: { reason: string; message: string } };
  if (doc.error === undefined) {
    throw new Error(`not an error document: ${result.stdout}`);
  }
  return doc.error;
}

/**
 * Resolves once a `claim --wait` child has printed its queued line (human
 * or `--json`), which the wait prints only after its join is written and
 * its signal handlers are in place. Fails if the child exits first.
 */
export async function queuedLine(proc: CliProcess, timeoutMs = 60_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  let exited = false;
  void proc.exited.then(() => {
    exited = true;
  });
  while (!/queued for |"queued":true/.test(proc.stdout())) {
    if (exited) {
      throw new Error(`waiter exited before queuing: ${proc.stdout()} ${proc.stderr()}`);
    }
    if (Date.now() > end) {
      throw new Error(`waiter never printed its queued line: ${proc.stderr()}`);
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}

/**
 * Every correctly named, well-formed event file of `eventsDir`, in fold
 * order, decoded with the events layer only (never the store under test).
 */
export function foldInputs(eventsDir: string): FoldInput[] {
  const inputs: FoldInput[] = [];
  for (const name of eventNames(eventsDir)) {
    const match = /^([0-9a-f]{64})\.json$/.exec(name);
    const bytes = readFileSync(join(eventsDir, name));
    if (match?.[1] === undefined || sha256Hex(bytes) !== match[1]) {
      continue;
    }
    const result = validateEvent(canonicalDecode(bytes));
    if (result.ok) {
      inputs.push({ hash: match[1], event: result.event });
    }
  }
  return inputs.sort(compareFoldOrder);
}

/** The events of `kind` in fold order, with their hashes. */
export function eventsOfKind<K extends BoardEvent['kind']>(
  eventsDir: string,
  kind: K,
): { hash: string; event: Extract<BoardEvent, { kind: K }> }[] {
  return foldInputs(eventsDir)
    .filter((input) => input.event.kind === kind)
    .map((input) => ({
      hash: input.hash,
      event: input.event as Extract<BoardEvent, { kind: K }>,
    }));
}

/** What `expectExclusion` saw. */
export interface WalkSummary {
  /** Applied grants, in fold order: grantee and wall. */
  grants: { to: string; wall: number; hash: string }[];
  /** Applied takeovers (claims that replaced another holder), in fold order. */
  takeovers: { actor: string; wall: number; hash: string }[];
  /** Rejected events, in fold order. */
  rejected: { hash: string; kind: string; reason: string }[];
  /** The folded state after the last event. */
  state: BoardState;
}

/**
 * Walks `inputs` in fold order with the fold's own `applyEvent`, asserting
 * at every position that the ticket has at most one holder at a time: an
 * applied event that gives `ticket` to a new actor while another holds it
 * is a hand-off or assign by its holder, a takeover naming the current
 * lease whose wall is at least its `expiresAt + SKEW`, or a grant after a
 * lapse of the current lease with such a wall; an applied grant to a free
 * ticket follows a release. The assignee is never queued. Returns what it
 * saw.
 */
export function expectExclusion(inputs: readonly FoldInput[], ticket = T1): WalkSummary {
  const state: BoardState = { tickets: {}, meta: {} };
  const summary: WalkSummary = { grants: [], takeovers: [], rejected: [], state };
  const ordered = [...inputs].sort(compareFoldOrder);
  for (const input of ordered) {
    const event = input.event as BoardEvent;
    const before = state.tickets[ticket];
    const prior =
      before === undefined
        ? null
        : { assignee: before.assignee, lease: before.lease === null ? null : { ...before.lease } };
    const outcome = applyEvent(state, input);
    if (outcome.status === 'rejected') {
      summary.rejected.push({
        hash: input.hash,
        kind: outcome.rejected.kind,
        reason: outcome.rejected.reason,
      });
      continue;
    }
    if (!('ticket' in event) || event.ticket !== ticket || prior === null) {
      continue;
    }
    const after = state.tickets[ticket];
    const label = `${event.kind} ${input.hash}`;
    expect(after, label).toBeDefined();
    if (after === undefined) {
      continue;
    }
    expect(
      after.queue.some((w) => w.actor === after.assignee),
      label,
    ).toBe(false);
    const changed = after.assignee !== null && after.assignee !== prior.assignee;
    if (event.kind === 'ticket.grant') {
      summary.grants.push({ to: event.body.to, wall: event.ts.wall, hash: input.hash });
      if (prior.assignee === null) {
        expect('released' in event.body.after, label).toBe(true);
      } else {
        expect(prior.lease, label).not.toBeNull();
        expect(event.body.after, label).toEqual({
          lease: {
            holder: prior.assignee,
            expiresAt: prior.lease?.expiresAt,
            event: prior.lease?.event,
          },
        });
        expect(event.ts.wall, label).toBeGreaterThanOrEqual((prior.lease?.expiresAt ?? 0) + SKEW);
      }
      continue;
    }
    if (!changed || prior.assignee === null) {
      continue;
    }
    if (event.kind === 'ticket.claim') {
      summary.takeovers.push({ actor: event.actor, wall: event.ts.wall, hash: input.hash });
      expect(prior.lease, label).not.toBeNull();
      expect(event.body.supersedes, label).toEqual({
        holder: prior.assignee,
        expiresAt: prior.lease?.expiresAt,
        event: prior.lease?.event,
      });
      expect(event.ts.wall, label).toBeGreaterThanOrEqual((prior.lease?.expiresAt ?? 0) + SKEW);
      continue;
    }
    // Any other change of holder is the holder's own hand-off or an assign.
    expect(['ticket.handoff', 'ticket.assign'], label).toContain(event.kind);
  }
  return summary;
}

/** `expectExclusion` over the event files of `eventsDir`. */
export function expectExclusionIn(eventsDir: string, ticket = T1): WalkSummary {
  return expectExclusion(foldInputs(eventsDir), ticket);
}
