import { describe, expect, it } from 'vitest';

import * as actions from '../../board/actions.js';
import * as library from '../../index.js';
import { DECISION_PREFIX, RETRACTED_PREFIX, openDecisions } from '../decisions.js';
import * as decisions from '../decisions.js';

// openDecisions and the prefixes live in the pure module
// src/events/decisions.ts and are re-exported, as the same bindings, from
// src/board/actions.ts and the library entry.

const c = (actor: string, text: string): { actor: string; text: string } => ({ actor, text });

describe('src/events/decisions.ts', () => {
  it('uses the DECISION: and RETRACTED: prefixes', () => {
    expect(DECISION_PREFIX).toBe('DECISION:');
    expect(RETRACTED_PREFIX).toBe('RETRACTED:');
  });

  it('returns DECISION: comments in comment order', () => {
    const d1 = c('a', 'DECISION: use RFC 6979 for P-256');
    const d2 = c('b', 'DECISION: keep the old name');
    expect(openDecisions([d1, c('a', 'chatter'), d2])).toEqual([d1, d2]);
  });

  it('returns an empty list for no comments', () => {
    expect(openDecisions([])).toEqual([]);
  });

  it('only counts the prefix at the very start, case-sensitively', () => {
    expect(
      openDecisions([
        c('a', ' DECISION: x'),
        c('a', 'decision: x'),
        c('a', 'we made a DECISION: x'),
      ]),
    ).toEqual([]);
    expect(openDecisions([c('a', 'DECISION:x')])).toEqual([c('a', 'DECISION:x')]);
  });

  it('a later RETRACTED: by the same actor retracts every earlier decision of that actor', () => {
    const other = c('b', 'DECISION: theirs');
    expect(
      openDecisions([
        c('a', 'DECISION: one'),
        c('a', 'DECISION: two'),
        other,
        c('a', 'RETRACTED: both'),
      ]),
    ).toEqual([other]);
  });

  it('a RETRACTED: by another actor or before the decision retracts nothing', () => {
    const late = c('a', 'DECISION: after');
    const d = c('a', 'DECISION: x');
    expect(openDecisions([c('a', 'RETRACTED: early'), late])).toEqual([late]);
    expect(openDecisions([d, c('b', 'RETRACTED: not yours')])).toEqual([d]);
  });

  it('a decision after a retraction stays open while an earlier one is retracted', () => {
    const again = c('a', 'DECISION: again');
    expect(openDecisions([c('a', 'DECISION: first'), c('a', 'RETRACTED: first'), again])).toEqual([
      again,
    ]);
  });

  it('returns new objects with only actor and text, and does not modify its input', () => {
    const comments = [
      { actor: 'a', text: 'DECISION: x', hash: 'h1', ts: { wall: 1, counter: 0, actor: 'a' } },
    ];
    const before = structuredClone(comments);
    const result = openDecisions(comments);
    expect(result).toEqual([{ actor: 'a', text: 'DECISION: x' }]);
    expect(Object.keys(result[0] ?? {}).sort()).toEqual(['actor', 'text']);
    expect(result[0]).not.toBe(comments[0]);
    expect(comments).toEqual(before);
  });
});

describe('re-exports', () => {
  it('src/board/actions.ts re-exports the same bindings', () => {
    expect(actions.openDecisions).toBe(decisions.openDecisions);
    expect(actions.DECISION_PREFIX).toBe(decisions.DECISION_PREFIX);
    expect(actions.RETRACTED_PREFIX).toBe(decisions.RETRACTED_PREFIX);
  });

  it('the library entry exports the same bindings', () => {
    expect(library.openDecisions).toBe(decisions.openDecisions);
    expect(library.DECISION_PREFIX).toBe(decisions.DECISION_PREFIX);
    expect(library.RETRACTED_PREFIX).toBe(decisions.RETRACTED_PREFIX);
  });
});
