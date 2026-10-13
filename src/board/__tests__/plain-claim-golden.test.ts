/**
 * Golden test (board-events: "Plain claim bytes are unchanged"): a claim
 * written without a lease is byte for byte the claim written before leases
 * existed. The fixture `src/events/__tests__/fixtures/plain-claim.json` was
 * written by this exact sequence on the code at commit ce7766d, before any
 * lease code (see the note in src/events/__tests__/schema.test.ts).
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { claimTicket } from '../actions.js';
import { putEvent, setup } from './helpers.js';

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'events',
  '__tests__',
  'fixtures',
  'plain-claim.json',
);
const T1 = '01ARYZ6S41TSV4RRFFQ69G5FAV';

describe('golden: claim without a lease', () => {
  it('writes the same file name and bytes as before leases existed', () => {
    const { board } = setup();
    putEvent(board.eventsDir, {
      v: 1,
      kind: 'ticket.create',
      ticket: T1,
      actor: 'orch',
      ts: { wall: 1_700_000_000_000, counter: 0, actor: 'orch' },
      body: { title: 'Merge lock' },
    });
    const out = claimTicket(board, 'merger-1', { id: T1 }, { now: () => 1_700_000_060_000 });
    expect(out.hash).toBe('fcee29059bbe23f90d5b51a2544714af61b8d1b0d985cbb105ab6f50f94aec64');
    const written = readFileSync(join(board.eventsDir, `${String(out.hash)}.json`));
    expect(new Uint8Array(written)).toEqual(new Uint8Array(readFileSync(FIXTURE)));
    expect(out.ticket.lease).toBeNull();
  });
});
