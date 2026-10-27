/**
 * The lease and queue hints (add-claim-leases task 3.2; board-cli: "Lease
 * and queue hints"): `already-assigned` on a leased ticket names the time
 * from which it can be claimed and the `--wait` form, `queued` names the
 * `--wait` form (replacing group 1's provisional `show` hint),
 * `not-assignee` from `renew` says the lock was lost, `wait-timeout` names
 * `inbox`, on both surfaces, each suggested command parsing with the real
 * parser or the tool argument validator. Pure (`renderHint`, `hintFor`).
 */

import { describe, expect, it } from 'vitest';

import { ClaimRefusedError } from '../../board/actions.js';
import { parseArgs } from '../../cli/parse.js';
import { findTool, toolArguments } from '../../mcp/tools.js';
import { BoardError } from '../../store/errors.js';
import { HINT_EXIT_CODES, HINT_REASONS, hintFor, renderHint, type HintContext } from '../hints.js';
import { splitCommandLine } from './command-line.js';

const CLAIMABLE = Date.UTC(2026, 9, 26, 12, 3, 0);
const ISO = '2026-10-26T12:03:00.000Z';
const ID = '01J9K3';

function ctx(
  surface: 'cli' | 'mcp',
  command: string | null,
  extra: Partial<HintContext> = {},
): HintContext {
  return { surface, command, id: ID, actor: 'merger-2', ...extra };
}

const CLI_WAIT = `'agentboard claim ${ID} --ttl <duration> --wait --timeout <duration> --as merger-2'`;
const MCP_WAIT = `board_claim {"id":"${ID}","ttl":"<duration>","wait":true,"as":"merger-2"}`;
const CLI_BASE = `another actor holds this ticket, so do not work on it: see who with 'agentboard show ${ID}', or find your own work with 'agentboard inbox --as merger-2'`;
const MCP_BASE = `another actor holds this ticket, so do not work on it: see who with board_show {"id":"${ID}"}, or find your own work with board_inbox {"as":"merger-2"}`;

describe('already-assigned on a leased ticket', () => {
  it('CLI: names the claimable time and the --wait form', () => {
    expect(renderHint('already-assigned', ctx('cli', 'claim', { claimableAt: CLAIMABLE }))).toBe(
      `${CLI_BASE}; it can be claimed from ${ISO}, or wait in its queue with ${CLI_WAIT}`,
    );
  });

  it('MCP: the board_claim step has ttl and wait and no timeout', () => {
    expect(renderHint('already-assigned', ctx('mcp', 'claim', { claimableAt: CLAIMABLE }))).toBe(
      `${MCP_BASE}; it can be claimed from ${ISO}, or wait in its queue with ${MCP_WAIT}`,
    );
  });

  it('without a claimable time the hint is unchanged', () => {
    expect(renderHint('already-assigned', ctx('cli', 'claim'))).toBe(CLI_BASE);
    expect(renderHint('already-assigned', ctx('mcp', 'claim'))).toBe(MCP_BASE);
  });

  it('with unknown id and actor the placeholders are used', () => {
    const hint = renderHint('already-assigned', {
      surface: 'cli',
      command: null,
      claimableAt: CLAIMABLE,
    });
    expect(hint).toContain(
      "'agentboard claim <id> --ttl <duration> --wait --timeout <duration> --as <actor>'",
    );
  });

  it('hintFor fills the claimable time from a ClaimRefusedError with a lease', () => {
    const leased = new ClaimRefusedError('already-assigned', 'held', 'merger-1', {
      expiresAt: CLAIMABLE - 60_000,
      claimableAt: CLAIMABLE,
    });
    expect(leased).toBeInstanceOf(BoardError);
    expect({ exitCode: leased.exitCode, reason: leased.reason }).toEqual({
      exitCode: 4,
      reason: 'already-assigned',
    });
    expect(hintFor(leased, ctx('cli', 'claim'))).toBe(
      `${CLI_BASE}; it can be claimed from ${ISO}, or wait in its queue with ${CLI_WAIT}`,
    );
    expect(hintFor(leased, ctx('mcp', 'claim'))).toContain(MCP_WAIT);
    const plain = new ClaimRefusedError('already-assigned', 'held', 'impl', null);
    expect(hintFor(plain, ctx('cli', 'claim'))).toBe(CLI_BASE);
  });
});

describe('queued', () => {
  it('CLI: names the --wait form (no longer only show)', () => {
    expect(renderHint('queued', ctx('cli', 'claim'))).toBe(
      `other actors are waiting for this ticket and have priority; wait in its queue with ${CLI_WAIT}`,
    );
  });

  it('MCP: names board_claim with wait', () => {
    expect(renderHint('queued', ctx('mcp', 'claim'))).toBe(
      `other actors are waiting for this ticket and have priority; wait in its queue with ${MCP_WAIT}`,
    );
  });

  it('hintFor of a queued ClaimRefusedError is the same', () => {
    const err = new ClaimRefusedError('queued', 'waiting', 'merger-1', null);
    expect(hintFor(err, ctx('cli', 'claim'))).toBe(renderHint('queued', ctx('cli', 'claim')));
  });
});

describe('not-assignee from renew', () => {
  it('says the lock was lost and names show, on both surfaces', () => {
    expect(renderHint('not-assignee', ctx('cli', 'renew'))).toBe(
      `the lock was lost: you no longer hold this ticket, so stop the work it protects; see who holds it with 'agentboard show ${ID}'`,
    );
    expect(renderHint('not-assignee', ctx('mcp', 'renew'))).toBe(
      `the lock was lost: you no longer hold this ticket, so stop the work it protects; see who holds it with board_show {"id":"${ID}"}`,
    );
  });

  it('from any other command it is unchanged', () => {
    expect(renderHint('not-assignee', ctx('cli', 'release'))).toBe(
      `only the assignee can do this; see who holds the ticket with 'agentboard show ${ID}'`,
    );
  });
});

describe('wait-timeout', () => {
  it('is a hinted reason of exit 4', () => {
    expect(HINT_REASONS).toContain('wait-timeout');
    expect(HINT_EXIT_CODES['wait-timeout']).toBe(4);
  });

  it('names inbox --as <actor> on both surfaces', () => {
    expect(renderHint('wait-timeout', ctx('cli', 'claim'))).toBe(
      "the wait timed out and you left the queue; see what happened with 'agentboard inbox --as merger-2', then wait again or report ready",
    );
    expect(renderHint('wait-timeout', ctx('mcp', 'claim'))).toBe(
      'the wait timed out and you left the queue; see what happened with board_inbox {"as":"merger-2"}, then wait again or report ready',
    );
  });
});

describe('wait-interrupted (add-claim-leases task 4.1)', () => {
  it('is a hinted reason of exit 4', () => {
    expect(HINT_REASONS).toContain('wait-interrupted');
    expect(HINT_EXIT_CODES['wait-interrupted']).toBe(4);
  });

  it('says the actor left the queue and names the --wait form on both surfaces', () => {
    expect(renderHint('wait-interrupted', ctx('cli', 'claim'))).toBe(
      `the wait was interrupted and you left the queue; to wait again run ${CLI_WAIT}`,
    );
    expect(renderHint('wait-interrupted', ctx('mcp', 'claim'))).toBe(
      `the wait was interrupted and you left the queue; to wait again run ${MCP_WAIT}`,
    );
  });

  it('a BoardError(4, wait-interrupted) from claim gets that hint', () => {
    const error = new BoardError(4, 'wait-interrupted', `wait on ticket ${ID} interrupted`);
    expect(hintFor(error, ctx('cli', 'claim'))).toBe(
      `the wait was interrupted and you left the queue; to wait again run ${CLI_WAIT}`,
    );
  });
});

describe('busy from claim (review round 1: a wait whose leave stayed busy)', () => {
  it('names unqueue on both surfaces', () => {
    expect(renderHint('busy', ctx('cli', 'claim'))).toBe(
      `another process held the board cache too long; if you were waiting, you are still in the queue: leave it with 'agentboard unqueue ${ID} --as merger-2', or run the command again`,
    );
    expect(renderHint('busy', ctx('mcp', 'claim'))).toBe(
      `another process held the board cache too long; if you were waiting, you are still in the queue: leave it with board_unqueue {"id":"${ID}","as":"merger-2"}, or run the command again`,
    );
  });

  it('from any other command it is unchanged', () => {
    expect(renderHint('busy', ctx('cli', 'renew'))).toBe(
      'another process held the board cache too long; run the command again',
    );
  });
});

describe('every suggested step parses', () => {
  const contexts: [string, HintContext][] = [
    ['already-assigned', ctx('cli', 'claim', { claimableAt: CLAIMABLE })],
    ['already-assigned', ctx('mcp', 'claim', { claimableAt: CLAIMABLE })],
    ['queued', ctx('cli', 'claim')],
    ['queued', ctx('mcp', 'claim')],
    ['not-assignee', ctx('cli', 'renew')],
    ['not-assignee', ctx('mcp', 'renew')],
    ['wait-timeout', ctx('cli', 'claim')],
    ['wait-timeout', ctx('mcp', 'claim')],
    ['wait-interrupted', ctx('cli', 'claim')],
    ['wait-interrupted', ctx('mcp', 'claim')],
    ['busy', ctx('cli', 'claim')],
    ['busy', ctx('mcp', 'claim')],
  ];

  it.each(contexts)('%s (%o)', (reason, context) => {
    const hint = renderHint(reason, context) ?? '';
    expect(hint).toMatch(/^[\x20-\x7e]+$/);
    const cli = [...hint.matchAll(/'(agentboard [^']*)'/g)].map((m) => m[1] ?? '');
    const tools = [...hint.matchAll(/\b(board_[a-z_]+) (\{[^}]*\})/g)].map((m) => ({
      tool: m[1] ?? '',
      args: JSON.parse(m[2] ?? '') as unknown,
    }));
    expect(cli.length + tools.length).toBeGreaterThan(0);
    if (context.surface === 'cli') {
      expect(tools).toEqual([]);
    }
    for (const step of cli) {
      expect(() => parseArgs(splitCommandLine(step).slice(1)), step).not.toThrow();
    }
    for (const { tool, args } of tools) {
      const found = findTool(tool);
      expect(found, tool).toBeDefined();
      if (found !== undefined) {
        expect(
          () => toolArguments(found.command, args),
          `${tool} ${JSON.stringify(args)}`,
        ).not.toThrow();
      }
    }
  });
});
