/**
 * The actor check itself (actor-secret-check task 1.1; board-cli "Actor
 * names are checked"; design.md "The actor check" and "Messages"): the
 * three actor tables of `src/__tests__/harness/secret-fixtures.ts`, the
 * patterns tested before the form, the form tested on ASCII only, the two
 * exact messages for every source, and no part of the name in any
 * message.
 */

import { describe, expect, it } from 'vitest';

import {
  ACTORS_ACCEPTED,
  ACTORS_REFUSED,
  ACTORS_REFUSED_BY_FORM,
  ACTORS_REFUSED_BY_PATTERN,
  AWS_KEY_ID,
  BOARD_ACTORS,
  FULLWIDTH,
  GITHUB_TOKEN,
  KELVIN,
  LONG_S,
  NON_ASCII,
  actorFormMessage,
  actorMessage,
  actorPatternMessage,
  expectNoLeak,
} from '../../__tests__/harness/secret-fixtures.js';
import { secretPatternsIn } from '../../board/secrets.js';
import { BoardError } from '../../store/errors.js';
import { checkActorName, type ActorSource } from '../parse.js';

/** Every source a refusal may name (design.md "Messages"). */
const SOURCES: readonly ActorSource[] = [
  '--as',
  'AGENTBOARD_ACTOR',
  '--to',
  'the argument as',
  'the argument to',
];

/** The error `checkActorName(name, source)` throws (fails the test when it returns). */
function refusal(name: string, source: ActorSource): BoardError {
  try {
    checkActorName(name, source);
  } catch (error) {
    expect(error).toBeInstanceOf(BoardError);
    return error as BoardError;
  }
  throw new Error(`checkActorName accepted a name it must refuse (${String(name.length)} chars)`);
}

/** The form, recomputed here without the code under test (design.md). */
const FORM = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,31}$/;

describe('the actor tables (sanity, recomputed without the code under test)', () => {
  it('every pattern-refused name matches exactly its listed patterns', () => {
    for (const f of ACTORS_REFUSED_BY_PATTERN) {
      expect(secretPatternsIn(f.value).join(', '), f.name).toBe(f.patterns);
    }
  });

  it('every form-refused name matches no pattern and is outside the form', () => {
    for (const f of ACTORS_REFUSED_BY_FORM) {
      expect(secretPatternsIn(f.value), f.name).toEqual([]);
      expect(FORM.test(f.value), f.name).toBe(false);
    }
  });

  it('every accepted name matches no pattern and has the form', () => {
    for (const name of ACTORS_ACCEPTED) {
      expect(secretPatternsIn(name), name).toEqual([]);
      expect(FORM.test(name), name).toBe(true);
    }
  });

  it('the AWS-style key id has the form (so only the patterns refuse it)', () => {
    expect(FORM.test(AWS_KEY_ID)).toBe(true);
  });

  it('the board actors are all of [a-z0-9-], the longest 15 characters', () => {
    expect(BOARD_ACTORS.length).toBeGreaterThanOrEqual(77);
    expect(BOARD_ACTORS.every((a) => /^[a-z0-9-]+$/.test(a))).toBe(true);
    expect(Math.max(...BOARD_ACTORS.map((a) => a.length))).toBe(15);
  });
});

describe('checkActorName: accepted names', () => {
  it.each(ACTORS_ACCEPTED.map((name) => [name]))('accepts %j from every source', (name) => {
    for (const source of SOURCES) {
      expect(() => {
        checkActorName(name, source);
      }).not.toThrow();
    }
  });

  it('accepts the reserved actor agentboard (its own rule refuses it, with reason usage)', () => {
    expect(() => {
      checkActorName('agentboard', '--as');
    }).not.toThrow();
  });

  it('accepts a name of exactly 32 characters and refuses 33', () => {
    expect(() => {
      checkActorName(`a${'1'.repeat(31)}`, '--as');
    }).not.toThrow();
    expect(refusal(`a${'1'.repeat(32)}`, '--as').reason).toBe('invalid-actor');
  });

  it('accepts upper and lower case letters alike (actors stay case-sensitive, nothing is folded)', () => {
    for (const name of ['BEN', 'ben', 'Ben', 'IMPL-1']) {
      expect(() => {
        checkActorName(name, '--as');
      }).not.toThrow();
    }
  });
});

describe('checkActorName: refused names', () => {
  it.each(ACTORS_REFUSED.map((f) => [f.name, f] as const))(
    '%s: exit 1, invalid-actor, the exact message for every source, no part of the name',
    (_name, f) => {
      for (const source of SOURCES) {
        const error = refusal(f.value, source);
        expect(error.exitCode).toBe(1);
        expect(error.reason).toBe('invalid-actor');
        expect(error.message).toBe(actorMessage(source, f));
        expectNoLeak(`${f.name} from ${source}`, [error.message], [f]);
      }
    },
  );

  it('refuses the empty name for the form', () => {
    const error = refusal('', '--as');
    expect(error.reason).toBe('invalid-actor');
    expect(error.message).toBe(actorFormMessage('--as'));
  });

  it('tests the patterns first: an AWS-style key id (of the form) gets the pattern message', () => {
    expect(refusal(AWS_KEY_ID, '--as').message).toBe(
      actorPatternMessage('--as', 'aws-access-key-id'),
    );
  });

  it('tests the patterns first: a 40-character GitHub token (outside the form) gets the pattern message', () => {
    expect(GITHUB_TOKEN.length).toBe(40);
    const message = refusal(GITHUB_TOKEN, '--as').message;
    expect(message).toBe(actorPatternMessage('--as', 'github-token'));
    expect(message).not.toContain('actor form');
  });

  it('names every matching pattern in SECRET_PATTERN_NAMES order', () => {
    expect(refusal(`${GITHUB_TOKEN}.${AWS_KEY_ID}`, 'AGENTBOARD_ACTOR').message).toBe(
      actorPatternMessage('AGENTBOARD_ACTOR', 'aws-access-key-id, github-token'),
    );
  });

  it('tests the form on ASCII only: no Unicode case folding or normalisation', () => {
    // A long s (folds to s), a Kelvin sign (folds to k), a fullwidth i
    // (NFKC i), an e with an acute accent, a Greek omicron that looks like o.
    for (const name of [
      LONG_S,
      KELVIN,
      FULLWIDTH,
      NON_ASCII,
      `impl-${String.fromCharCode(0x3bf)}`,
    ]) {
      const error = refusal(name, '--as');
      expect(error.reason, JSON.stringify(name)).toBe('invalid-actor');
      expect(error.message).toBe(actorFormMessage('--as'));
    }
  });

  it('refuses a name whose only fault is a trailing newline or a trailing space', () => {
    for (const name of ['impl-1\n', 'impl-1 ', 'impl-1\r', '\nimpl-1']) {
      expect(refusal(name, '--as').reason, JSON.stringify(name)).toBe('invalid-actor');
    }
  });
});
