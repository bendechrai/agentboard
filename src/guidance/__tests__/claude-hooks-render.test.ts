/**
 * The text of the `claude-hooks` target (board-harness-hooks "Hooks
 * installed in Claude settings"; design.md decisions 4 and 7, "Rulings
 * from task group 3 (test author)"): the marker, the executable text a
 * `--command` value becomes in a shell command, the three commands and
 * their matcher groups, and taking a command apart again
 * (`hookMarkerVersion`, `parseHookCommand`) for ownership and `check`.
 *
 * The expected strings are written out here by hand rather than built
 * with the functions under test.
 */

import { describe, expect, it } from 'vitest';

import {
  CLAUDE_HOOK_EVENTS,
  CLAUDE_SETTINGS_PATH,
  GUIDANCE_VERSION,
  HOOKS_MARKER_TEXT,
  HOOK_DEFAULT_EXECUTABLE,
  HOOK_TIMEOUT_SECONDS,
  PRE_TOOL_USE_MATCHER,
  hookCommand,
  hookExecutable,
  hookGroup,
  hooksMarker,
  type ClaudeHookEvent,
} from '../installed-text.js';
import { hookMarkerVersion, parseHookCommand } from '../markers.js';

const NPX = 'npx -y @bendechrai/agentboard';
const EVENTS: readonly ClaudeHookEvent[] = ['session-start', 'stop', 'pre-tool-use'];

describe('constants', () => {
  it('fixes the path, marker text, default executable, timeout and matcher', () => {
    expect(CLAUDE_SETTINGS_PATH).toBe('.claude/settings.json');
    expect(HOOKS_MARKER_TEXT).toBe('# agentboard-hooks:');
    expect(HOOK_DEFAULT_EXECUTABLE).toBe(NPX);
    expect(HOOK_TIMEOUT_SECONDS).toBe(5);
    expect(PRE_TOOL_USE_MATCHER).toBe('Edit|Write|MultiEdit|NotebookEdit');
    expect(CLAUDE_HOOK_EVENTS).toEqual([
      { key: 'SessionStart', event: 'session-start' },
      { key: 'Stop', event: 'stop' },
      { key: 'PreToolUse', event: 'pre-tool-use' },
    ]);
  });

  it('installs new targets at the current guidance version, 3', () => {
    expect(GUIDANCE_VERSION).toBe(3);
  });
});

describe('hooksMarker', () => {
  it('is the shell comment # agentboard-hooks: v<N>', () => {
    expect(hooksMarker(3)).toBe('# agentboard-hooks: v3');
    expect(hooksMarker(12)).toBe('# agentboard-hooks: v12');
  });
});

describe('hookExecutable', () => {
  it('is the npx command line without --command', () => {
    expect(hookExecutable()).toBe(NPX);
    expect(hookExecutable(undefined)).toBe(NPX);
  });

  it.each([
    ['a name', 'agentboard'],
    ['an absolute path', '/usr/local/bin/agentboard'],
    ['a relative path', './node_modules/.bin/agentboard'],
    ['every safe character', 'Az09_./@%+=:,-'],
  ])('writes %s as given', (_label, command) => {
    expect(hookExecutable(command)).toBe(command);
  });

  it.each([
    ['a space', '/opt/My Tools/agentboard', "'/opt/My Tools/agentboard'"],
    ['a dollar sign, not expanded', '$HOME/bin/agentboard', "'$HOME/bin/agentboard'"],
    ['a tilde, not expanded', '~/bin/agentboard', "'~/bin/agentboard'"],
    ['a hash', '/opt/a#b/agentboard', "'/opt/a#b/agentboard'"],
    ['a single quote', "/opt/it's/agentboard", "'/opt/it'\\''s/agentboard'"],
    ['a double quote', '/opt/"x"/agentboard', '\'/opt/"x"/agentboard\''],
    ['a backslash', 'C:\\Tools\\agentboard.cmd', "'C:\\Tools\\agentboard.cmd'"],
    ['a semicolon', 'agentboard;rm', "'agentboard;rm'"],
    ['a backtick', 'a`b`', "'a`b`'"],
    ['a carriage return', 'agentboard\r', "'agentboard\r'"],
    ['surrounding spaces', ' agentboard ', "' agentboard '"],
    ['a command line', NPX, `'${NPX}'`],
  ])('quotes a value with %s as one shell word', (_label, command, expected) => {
    expect(hookExecutable(command)).toBe(expected);
  });
});

describe('hookCommand', () => {
  it.each(EVENTS)('renders the warn-mode %s command with the default executable', (event) => {
    expect(hookCommand(event)).toBe(`${NPX} hook ${event} # agentboard-hooks: v3`);
    expect(hookCommand(event, {})).toBe(`${NPX} hook ${event} # agentboard-hooks: v3`);
  });

  it.each(EVENTS)('adds --strict before the marker for %s', (event) => {
    expect(hookCommand(event, { strict: true })).toBe(
      `${NPX} hook ${event} --strict # agentboard-hooks: v3`,
    );
    expect(hookCommand(event, { strict: false })).toBe(
      `${NPX} hook ${event} # agentboard-hooks: v3`,
    );
  });

  it('records the version given', () => {
    expect(hookCommand('stop', { version: 2 })).toBe(`${NPX} hook stop # agentboard-hooks: v2`);
  });

  it('starts with the --command executable, quoted when it needs to be', () => {
    expect(hookCommand('pre-tool-use', { command: 'agentboard', strict: true })).toBe(
      'agentboard hook pre-tool-use --strict # agentboard-hooks: v3',
    );
    expect(hookCommand('session-start', { command: '/opt/My Tools/agentboard' })).toBe(
      "'/opt/My Tools/agentboard' hook session-start # agentboard-hooks: v3",
    );
  });

  it('never passes an actor', () => {
    for (const event of EVENTS) {
      expect(hookCommand(event, { strict: true, command: 'agentboard' })).not.toContain('--as');
    }
  });
});

describe('hookGroup', () => {
  it('renders SessionStart and Stop without a matcher', () => {
    expect(hookGroup('SessionStart')).toEqual({
      hooks: [
        {
          type: 'command',
          command: `${NPX} hook session-start # agentboard-hooks: v3`,
          timeout: 5,
        },
      ],
    });
    expect(hookGroup('Stop', { strict: true, command: 'agentboard' })).toEqual({
      hooks: [
        {
          type: 'command',
          command: 'agentboard hook stop --strict # agentboard-hooks: v3',
          timeout: 5,
        },
      ],
    });
    expect(Object.hasOwn(hookGroup('Stop'), 'matcher')).toBe(false);
  });

  it('renders PreToolUse with the file-writing tools matcher', () => {
    expect(hookGroup('PreToolUse', { version: 2 })).toEqual({
      matcher: 'Edit|Write|MultiEdit|NotebookEdit',
      hooks: [
        {
          type: 'command',
          command: `${NPX} hook pre-tool-use # agentboard-hooks: v2`,
          timeout: 5,
        },
      ],
    });
  });

  it('writes the keys in a fixed order and nothing else', () => {
    const pre = hookGroup('PreToolUse');
    expect(Object.keys(pre)).toEqual(['matcher', 'hooks']);
    expect(Object.keys(hookGroup('Stop'))).toEqual(['hooks']);
    const [handler] = pre.hooks;
    expect(handler === undefined ? [] : Object.keys(handler)).toEqual([
      'type',
      'command',
      'timeout',
    ]);
    expect(JSON.stringify(hookGroup('Stop'))).toBe(
      `{"hooks":[{"type":"command","command":"${NPX} hook stop # agentboard-hooks: v3","timeout":5}]}`,
    );
  });

  it('returns a new object on every call', () => {
    const a = hookGroup('PreToolUse');
    const b = hookGroup('PreToolUse');
    expect(a).not.toBe(b);
    expect(a.hooks).not.toBe(b.hooks);
    expect(a.hooks[0]).not.toBe(b.hooks[0]);
  });
});

describe('hookMarkerVersion', () => {
  it('reads the version of a command ending with the marker', () => {
    expect(hookMarkerVersion(`${NPX} hook stop # agentboard-hooks: v3`)).toBe(3);
    expect(hookMarkerVersion('anything at all # agentboard-hooks: v0')).toBe(0);
    expect(hookMarkerVersion('# agentboard-hooks: v41')).toBe(41);
    expect(hookMarkerVersion("echo '# agentboard-hooks: v1' # agentboard-hooks: v2")).toBe(2);
  });

  it.each([
    ['no marker', `${NPX} hook stop`],
    ['no space after the hash', `${NPX} hook stop #agentboard-hooks: v3`],
    ['no space after the colon', `${NPX} hook stop # agentboard-hooks:v3`],
    ['a leading zero', `${NPX} hook stop # agentboard-hooks: v03`],
    ['a trailing space', `${NPX} hook stop # agentboard-hooks: v3 `],
    ['a trailing line feed', `${NPX} hook stop # agentboard-hooks: v3\n`],
    ['a trailing carriage return', `${NPX} hook stop # agentboard-hooks: v3\r`],
    ['text after the marker', `${NPX} hook stop # agentboard-hooks: v3 && rm -rf x`],
    ['no digits', `${NPX} hook stop # agentboard-hooks: v`],
    ['a word for a version', `${NPX} hook stop # agentboard-hooks: vX`],
    ['another case', `${NPX} hook stop # Agentboard-Hooks: v3`],
    ['a version beyond a safe integer', `x # agentboard-hooks: v${'9'.repeat(20)}`],
  ])('is null for %s', (_label, command) => {
    expect(hookMarkerVersion(command)).toBeNull();
  });

  it.each([
    ['a number', 3],
    ['null', null],
    ['undefined', undefined],
    ['an object', { command: '# agentboard-hooks: v3' }],
    ['an array', ['# agentboard-hooks: v3']],
  ])('is null for %s', (_label, value) => {
    expect(hookMarkerVersion(value)).toBeNull();
  });
});

describe('parseHookCommand', () => {
  const commands: readonly (string | undefined)[] = [
    undefined,
    'agentboard',
    '/opt/My Tools/agentboard',
    "/opt/it's/agentboard",
    '$HOME/bin/agentboard',
    NPX,
  ];

  it('takes apart every command hookCommand renders', () => {
    for (const event of EVENTS) {
      for (const strict of [false, true]) {
        for (const command of commands) {
          for (const version of [1, 3, 10]) {
            const text = hookCommand(event, {
              strict,
              version,
              ...(command === undefined ? {} : { command }),
            });
            expect(parseHookCommand(text), text).toEqual({
              executable: command ?? null,
              event,
              strict,
              version,
            });
          }
        }
      }
    }
  });

  it('parses hand-written commands of both modes', () => {
    expect(parseHookCommand(`${NPX} hook pre-tool-use --strict # agentboard-hooks: v3`)).toEqual({
      executable: null,
      event: 'pre-tool-use',
      strict: true,
      version: 3,
    });
    expect(parseHookCommand("'/opt/My Tools/agentboard' hook stop # agentboard-hooks: v2")).toEqual(
      { executable: '/opt/My Tools/agentboard', event: 'stop', strict: false, version: 2 },
    );
  });

  it.each([
    ['an extra flag', `${NPX} hook stop --as impl # agentboard-hooks: v3`],
    ['two spaces', `${NPX} hook  stop # agentboard-hooks: v3`],
    ['an unknown event', `${NPX} hook post-tool-use # agentboard-hooks: v3`],
    ['--strict before the event', `${NPX} hook --strict stop # agentboard-hooks: v3`],
    ['--strict twice', `${NPX} hook stop --strict --strict # agentboard-hooks: v3`],
    ['no marker', `${NPX} hook stop`],
    ['a marker with a trailing space', `${NPX} hook stop # agentboard-hooks: v3 `],
    [
      'an unquoted space in the executable',
      '/opt/My Tools/agentboard hook stop # agentboard-hooks: v3',
    ],
    ['another command line', 'bunx agentboard hook stop # agentboard-hooks: v3'],
    ['an unterminated quote', "'/opt/x hook stop # agentboard-hooks: v3"],
    ['needless quotes', "'agentboard' hook stop # agentboard-hooks: v3"],
    ['double quotes', '"/opt/My Tools/agentboard" hook stop # agentboard-hooks: v3'],
    ['no executable', 'hook stop # agentboard-hooks: v3'],
    ['a leading space', ` ${NPX} hook stop # agentboard-hooks: v3`],
    ['a chained command', `${NPX} hook stop; true # agentboard-hooks: v3`],
  ])('is null for a command with %s', (_label, command) => {
    expect(parseHookCommand(command)).toBeNull();
  });
});
