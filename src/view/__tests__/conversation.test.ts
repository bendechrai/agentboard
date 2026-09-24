import { describe, expect, it } from 'vitest';

import { conversation, type ConversationMessage } from '../conversation.js';
import { describeEvent } from '../describe.js';
import { E, T1, T2, TASK, model } from './helpers.js';

const flags = (
  m: ConversationMessage | undefined,
): { decision: boolean; retracted: boolean; retraction: boolean } | null =>
  m === undefined || m.type === 'system'
    ? null
    : { decision: m.decision, retracted: m.retracted, retraction: m.retraction };

const NONE = { decision: false, retracted: false, retraction: false };

describe('conversation (board-view-model: "Conversation view")', () => {
  it('scenario Hand-off in the conversation', () => {
    const create = E.create(T1, { title: 'Build it', task: TASK }, { actor: 'orch' });
    const claim = E.claim(T1, { actor: 'test-1' });
    const handoff = E.handoff(T1, 'impl-1', 'tests', 'tests are red', { actor: 'test-1' });
    const messages = conversation(model([create, claim, handoff]), T1);
    expect(messages).toEqual([
      {
        type: 'system',
        hash: create.hash,
        actor: 'orch',
        ts: create.event.ts,
        kind: 'ticket.create',
        text: 'created Build it',
      },
      {
        type: 'system',
        hash: claim.hash,
        actor: 'test-1',
        ts: claim.event.ts,
        kind: 'ticket.claim',
        text: 'claimed',
      },
      {
        type: 'handoff',
        hash: handoff.hash,
        actor: 'test-1',
        ts: handoff.event.ts,
        text: 'tests are red',
        to: 'impl-1',
        status: 'tests',
        ...NONE,
      },
    ]);
  });

  it('turns a comment into a chat message by its actor with the text', () => {
    const create = E.create(T1, { title: 'x', task: TASK });
    const comment = E.comment(T1, 'hello there', { actor: 'impl' });
    const messages = conversation(model([create, comment]), T1);
    expect(messages[1]).toEqual({
      type: 'comment',
      hash: comment.hash,
      actor: 'impl',
      ts: comment.event.ts,
      text: 'hello there',
      ...NONE,
    });
  });

  it('turns every other kind into a system line with the describeEvent summary', () => {
    const inputs = [
      E.create(T1, { title: 'x', task: TASK, checklist: ['a'] }),
      E.claim(T1, { actor: 'impl' }),
      E.move(T1, 'tests', { actor: 'impl' }),
      E.assign(T1, 'rev'),
      E.release(T1, { actor: 'rev' }),
      E.link(T1, { pr: 12 }),
      E.check(T1, 0, true),
      E.addLines(T1, [{ text: 'b', done: false }]),
      E.move(T1, 'blocked'),
      E.close(T1, { decision: 'docs/adr/0001.md' }),
    ];
    const messages = conversation(model(inputs), T1);
    expect(messages).toHaveLength(inputs.length);
    messages.forEach((message, i) => {
      const input = inputs[i];
      expect(message.type).toBe('system');
      expect(message.hash).toBe(input?.hash);
      if (message.type === 'system' && input !== undefined) {
        expect(message.kind).toBe(input.event.kind);
        expect(message.text).toBe(describeEvent(input.event));
        expect(message.actor).toBe(input.event.actor);
      }
    });
  });

  it('keeps fold order, only this ticket, and only applied events', () => {
    const create1 = E.create(T1, { title: 'one', task: TASK });
    const create2 = E.create(T2, { title: 'two', task: TASK });
    const claim = E.claim(T1, { actor: 'a' });
    const rejected = E.claim(T1, { actor: 'b' });
    const other = E.comment(T2, 'elsewhere');
    const unknown = E.unknown(T1);
    const late = E.comment(T1, 'written late, sorts early', {
      actor: 'c',
      wall: create1.event.ts.wall + 1,
    });
    const meta = E.meta('k', 1);
    const m = model([create1, create2, claim, rejected, other, unknown, late, meta]);
    expect(conversation(m, T1).map((x) => x.hash)).toEqual([create1.hash, late.hash, claim.hash]);
    expect(conversation(m, T2).map((x) => x.hash)).toEqual([create2.hash, other.hash]);
  });

  it('is empty for a ticket that is not in the model', () => {
    const m = model([E.create(T1, { title: 'x', task: TASK })]);
    expect(conversation(m, T2)).toEqual([]);
    expect(conversation({ events: [] }, T1)).toEqual([]);
  });

  it('scenario Decision and retraction', () => {
    const m = model([
      E.create(T1, { title: 'x', task: TASK }),
      E.comment(T1, 'DECISION: use sessions', { actor: 'impl' }),
      E.comment(T1, 'RETRACTED: see ADR', { actor: 'impl' }),
    ]);
    const [, decision, retraction] = conversation(m, T1);
    expect(flags(decision)).toEqual({ decision: true, retracted: true, retraction: false });
    expect(flags(retraction)).toEqual({ decision: false, retracted: false, retraction: true });
  });

  it('an unretracted decision is flagged decision only', () => {
    const m = model([
      E.create(T1, { title: 'x', task: TASK }),
      E.comment(T1, 'DECISION: use sessions', { actor: 'impl' }),
    ]);
    expect(flags(conversation(m, T1)[1])).toEqual({
      decision: true,
      retracted: false,
      retraction: false,
    });
  });

  it('a retraction by another actor, or before the decision, retracts nothing', () => {
    const m = model([
      E.create(T1, { title: 'x', task: TASK }),
      E.comment(T1, 'RETRACTED: early', { actor: 'impl' }),
      E.comment(T1, 'DECISION: after', { actor: 'impl' }),
      E.comment(T1, 'DECISION: theirs', { actor: 'rev' }),
      E.comment(T1, 'RETRACTED: not yours', { actor: 'orch' }),
    ]);
    expect(conversation(m, T1).slice(1).map(flags)).toEqual([
      { decision: false, retracted: false, retraction: true },
      { decision: true, retracted: false, retraction: false },
      { decision: true, retracted: false, retraction: false },
      { decision: false, retracted: false, retraction: true },
    ]);
  });

  it('one retraction retracts every earlier decision of its actor', () => {
    const m = model([
      E.create(T1, { title: 'x', task: TASK }),
      E.comment(T1, 'DECISION: one', { actor: 'impl' }),
      E.comment(T1, 'DECISION: two', { actor: 'impl' }),
      E.comment(T1, 'DECISION: kept', { actor: 'rev' }),
      E.comment(T1, 'RETRACTED: both', { actor: 'impl' }),
      E.comment(T1, 'DECISION: three', { actor: 'impl' }),
    ]);
    expect(conversation(m, T1).slice(1).map(flags)).toEqual([
      { decision: true, retracted: true, retraction: false },
      { decision: true, retracted: true, retraction: false },
      { decision: true, retracted: false, retraction: false },
      { decision: false, retracted: false, retraction: true },
      { decision: true, retracted: false, retraction: false },
    ]);
  });

  it('flags hand-off notes like comments, in both directions', () => {
    const m = model([
      E.create(T1, { title: 'x', task: TASK }),
      E.handoff(T1, 'rev', 'tests', 'DECISION: in a note', { actor: 'impl' }),
      E.handoff(T1, 'impl', 'tests', 'DECISION: kept', { actor: 'rev' }),
      E.handoff(T1, 'rev', 'tests', 'RETRACTED: the note', { actor: 'impl' }),
    ]);
    const messages = conversation(m, T1).slice(1);
    expect(messages.map((x) => x.type)).toEqual(['handoff', 'handoff', 'handoff']);
    expect(messages.map(flags)).toEqual([
      { decision: true, retracted: true, retraction: false },
      { decision: true, retracted: false, retraction: false },
      { decision: false, retracted: false, retraction: true },
    ]);
  });

  it('a comment retraction retracts a hand-off decision of the same actor', () => {
    const m = model([
      E.create(T1, { title: 'x', task: TASK }),
      E.handoff(T1, 'rev', 'tests', 'DECISION: in a note', { actor: 'impl' }),
      E.comment(T1, 'RETRACTED: that', { actor: 'impl' }),
    ]);
    expect(flags(conversation(m, T1)[1])).toEqual({
      decision: true,
      retracted: true,
      retraction: false,
    });
  });

  it('matches the prefixes only at the very start, case-sensitively', () => {
    const m = model([
      E.create(T1, { title: 'x', task: TASK }),
      E.comment(T1, ' DECISION: leading space', { actor: 'a' }),
      E.comment(T1, 'decision: lower case', { actor: 'a' }),
      E.comment(T1, 'we made a DECISION: here', { actor: 'a' }),
      E.comment(T1, 'retracted: lower case', { actor: 'a' }),
      E.comment(T1, 'DECISION:no space', { actor: 'a' }),
    ]);
    expect(conversation(m, T1).slice(1).map(flags)).toEqual([
      NONE,
      NONE,
      NONE,
      NONE,
      { decision: true, retracted: false, retraction: false },
    ]);
  });

  it('a system line has no decision flags even when its summary contains the prefix', () => {
    const m = model([E.create(T1, { title: 'DECISION: in a title', task: TASK })]);
    const [message] = conversation(m, T1);
    expect(message?.type).toBe('system');
    expect(message).not.toHaveProperty('decision');
  });
});
