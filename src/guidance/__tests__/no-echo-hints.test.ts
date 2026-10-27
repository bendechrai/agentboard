/**
 * Hints write a given ticket id only when it is id-shaped (no-echo-refusals
 * task 1.5; design.md "Audit" row 36; board-cli "Ticket ids in refusals",
 * scenario "Hint for an id that is not an id"). In process for the
 * template contract on both surfaces; the CLI path is run through `runCli`
 * and the built CLI (the MCP path is in src/mcp/__tests__/no-echo-mcp.test.ts
 * and the web path in src/web/__tests__/no-echo-web.test.ts).
 */

import { describe, expect, it, vi } from 'vitest';

import { TOKEN_FIXTURES, expectNoLeak } from '../../__tests__/harness/secret-fixtures.js';
import { tempDir } from '../../board/__tests__/helpers.js';
import { cliEnv, project, run, written } from '../../cli/__tests__/cli-helpers.js';
import { expectCliRefusal } from '../../cli/__tests__/no-echo-helpers.js';
import { COMMANDS } from '../../cli/registry.js';
import { HINT_REASONS, renderHint, type HintContext, type HintSurface } from '../hints.js';

// Machines under load: the refusal loops spawn and parse many times.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const SURFACES: readonly HintSurface[] = ['cli', 'mcp'];

/** Every command that takes a ticket id, and the unknown command. */
const ID_COMMANDS: readonly (string | null)[] = [
  ...COMMANDS.filter((c) => c.positionals.some((p) => p.name === 'id')).map((c) => c.name),
  null,
];

/** The contexts a hint is rendered in, without an id. */
function contexts(): HintContext[] {
  const out: HintContext[] = [];
  for (const surface of SURFACES) {
    for (const command of ID_COMMANDS) {
      out.push({ surface, command, actor: 'orch' });
      out.push({ surface, command });
    }
  }
  return out;
}

describe('renderHint with an id that is not id-shaped', () => {
  it('is exactly the hint with no id known (the placeholder <id>), for every reason', () => {
    expect(ID_COMMANDS.length).toBeGreaterThan(10);
    for (const reason of HINT_REASONS) {
      for (const context of contexts()) {
        const placeholder = renderHint(reason, context);
        for (const f of TOKEN_FIXTURES) {
          const hint = renderHint(reason, { ...context, id: f.value });
          expect(hint, `${reason} ${context.surface} ${String(context.command)}`).toBe(placeholder);
          expectNoLeak(reason, [hint], [f]);
        }
        for (const text of ['01NOPE0000', 'Z'.repeat(27), '01J9K3I', 'ab_cd']) {
          expect(renderHint(reason, { ...context, id: text })).toBe(placeholder);
        }
      }
    }
  });

  it('still writes an id-shaped id, in any case, exactly as given, wherever <id> would be', () => {
    for (const reason of HINT_REASONS) {
      for (const context of contexts()) {
        const placeholder = renderHint(reason, context);
        for (const id of ['01j9k3', '01J9K3AB', 'Z'.repeat(26)]) {
          expect(renderHint(reason, { ...context, id }), `${reason} ${id}`).toBe(
            placeholder === null ? null : placeholder.replaceAll('<id>', id),
          );
        }
      }
    }
    expect(
      renderHint('no-disposition', {
        surface: 'mcp',
        command: 'close',
        id: '01J9K3AB',
        actor: 'orch',
      }),
    ).toContain('board_close {"id":"01J9K3AB","decision-recorded-in":"<path>","as":"orch"}');
  });
});

describe('Hint for an id that is not an id (CLI)', () => {
  it('close <token> with no disposition: the close step writes <id>', () => {
    const cwd = tempDir();
    for (const f of TOKEN_FIXTURES) {
      for (const runner of ['in-process', 'child'] as const) {
        expectCliRefusal(
          ['close', f.value, '--as', 'orch'],
          cwd,
          {
            exitCode: 1,
            reason: 'no-disposition',
            message:
              'close needs exactly one of --decision-recorded-in <path> or --no-decision: a decision made in a ticket must be recorded in a spec delta or ADR (name it with --decision-recorded-in), or declared absent with --no-decision',
            hint: "close needs a disposition: 'agentboard close <id> --decision-recorded-in <path> --as orch' naming the spec delta or ADR, or 'agentboard close <id> --no-decision --as orch' when nothing was decided",
          },
          [f],
          { runner },
        );
      }
    }
  });

  it('close <token> with a missing decision record: the hint writes <id>', () => {
    const { root } = project();
    for (const f of TOKEN_FIXTURES) {
      expectCliRefusal(
        ['close', f.value, '--decision-recorded-in', 'docs/adr/0099.md', '--as', 'orch'],
        root,
        {
          exitCode: 1,
          reason: 'decision-path-missing',
          message: 'the decision record given with --decision-recorded-in does not exist',
          hint: "write and commit the spec delta or ADR first, then run 'agentboard close <id> --decision-recorded-in <path> --as orch'",
        },
        [f],
      );
    }
  });

  it('an id-shaped id given to close is still in the hint exactly as given', () => {
    const { root } = project();
    const out = run(
      ['new', 'x', '--task', 'openspec:no-echo#1', '--as', 'orch', '--json'],
      root,
      cliEnv(),
    );
    const { id } = written(out);
    const prefix = id.slice(0, 8).toLowerCase();
    expectCliRefusal(
      ['close', prefix, '--decision-recorded-in', 'docs/adr/0099.md', '--as', 'orch'],
      root,
      {
        exitCode: 1,
        reason: 'decision-path-missing',
        message: 'the decision record given with --decision-recorded-in does not exist',
        hint: `write and commit the spec delta or ADR first, then run 'agentboard close ${prefix} --decision-recorded-in <path> --as orch'`,
      },
      [],
    );
  });
});
