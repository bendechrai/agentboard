import { describe, expect, it } from 'vitest';

import {
  AFTER_ESCAPE,
  ASSIGNED_STRIPE_KEY,
  DOUBLE_BACKSLASH_N,
  SLUG_ACTORS,
  SLUG_FALSE_POSITIVES,
  hex,
  jwt,
  sendgrid,
  GLPAT_20,
  NEAR_MISSES,
  NEW_PATTERN_KEYS,
  ONE_SHORT,
  PREFIX_INSIDE_A_WORD,
  PROVIDER_KEYS,
  RK_LIVE_16,
  RK_LIVE_24,
  SCENARIO_BARE_KEYS,
  SK_TEST_24,
  alnum,
  providerKey,
  urlsafe,
} from '../../__tests__/harness/provider-key-fixtures.js';
import {
  ACTOR_FORM,
  SECRET_PATTERN_NAMES,
  isActorName,
  refuseSecretLike,
  secretPatternsIn,
} from '../secrets.js';
import { B64, SAMPLES, expectBoardError } from './helpers.js';

describe('SECRET_PATTERN_NAMES', () => {
  it('names the nineteen patterns in check order: the original providers, the new ones alphabetically, the catch-all last', () => {
    expect(SECRET_PATTERN_NAMES).toEqual([
      'pem-private-key',
      'aws-access-key-id',
      'github-token',
      'anthropic-api-key',
      'digitalocean-token',
      'docker-token',
      'gitlab-token',
      'google-api-key',
      'huggingface-token',
      'jwt',
      'npm-token',
      'openai-api-key',
      'pypi-token',
      'sendgrid-api-key',
      'shopify-token',
      'slack-token',
      'stripe-secret-key',
      'stripe-webhook-secret',
      'generic-secret-assignment',
    ]);
  });

  it('has one representative fixture per new pattern, in the same order', () => {
    expect(NEW_PATTERN_KEYS.map((k) => k.pattern)).toEqual(SECRET_PATTERN_NAMES.slice(3, -1));
  });
});

describe('secretPatternsIn', () => {
  it.each(SECRET_PATTERN_NAMES)('detects %s inside surrounding text', (name) => {
    expect(secretPatternsIn(`see this: ${SAMPLES[name]} thanks`)).toEqual([name]);
  });

  it('returns nothing for ordinary text', () => {
    expect(secretPatternsIn('green, 96% coverage; the key point is the token bucket')).toEqual([]);
    expect(secretPatternsIn('')).toEqual([]);
  });

  it('detects other PEM private key headers', () => {
    for (const kind of ['RSA', 'EC', 'OPENSSH', 'ENCRYPTED']) {
      const header = ['-----BEGIN', kind, 'PRIVATE KEY-----'].join(' ');
      expect(secretPatternsIn(header)).toEqual(['pem-private-key']);
    }
  });

  it('does not treat a public key or certificate header as a private key', () => {
    expect(secretPatternsIn(['-----BEGIN', 'PUBLIC KEY-----'].join(' '))).toEqual([]);
    expect(secretPatternsIn(['-----BEGIN', 'CERTIFICATE-----'].join(' '))).toEqual([]);
  });

  it('detects ASIA access key ids and requires exactly 16 trailing characters', () => {
    expect(secretPatternsIn(['ASIA', 'Z7EXAMPLEFAKE234'].join(''))).toEqual(['aws-access-key-id']);
    expect(secretPatternsIn(['AKIA', 'Z7EXAMPLEFAKE23'].join(''))).toEqual([]);
    expect(secretPatternsIn(['AKIA', 'Z7EXAMPLEFAKE2345'].join(''))).toEqual([]);
  });

  it('detects fine-grained GitHub tokens and the other classic prefixes', () => {
    expect(
      secretPatternsIn(['github', '_pat_', '11ABCDEFG0123456789_abcdefghij'].join('')),
    ).toEqual(['github-token']);
    for (const prefix of ['gho', 'ghu', 'ghs', 'ghr']) {
      const token = [prefix, '_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'].join('');
      expect(secretPatternsIn(token)).toEqual(['github-token']);
    }
    expect(secretPatternsIn(['ghp', '_', 'short'].join(''))).toEqual([]);
  });

  it('detects each keyword with : or = and optional spaces and quotes, in any case', () => {
    for (const text of [
      `token: ${B64}`,
      `SECRET=${B64}`,
      `api_key = "${B64}"`,
      `GITHUB_TOKEN='${B64}'`,
      `Password : ${B64}==`,
    ]) {
      expect(secretPatternsIn(text), text).toEqual(['generic-secret-assignment']);
    }
  });

  it('needs at least 32 base64 characters after the separator', () => {
    expect(secretPatternsIn(`token=${B64.slice(0, 31)}`)).toEqual([]);
    expect(secretPatternsIn(`token=${B64.slice(0, 32)}`)).toEqual(['generic-secret-assignment']);
  });

  it('needs a separator after the keyword', () => {
    expect(secretPatternsIn(`token ${B64}`)).toEqual([]);
  });

  it('reports every matching pattern once, in check order', () => {
    const text = `${SAMPLES['generic-secret-assignment']} ${SAMPLES['pem-private-key']} ${SAMPLES['pem-private-key']}`;
    expect(secretPatternsIn(text)).toEqual(['pem-private-key', 'generic-secret-assignment']);
  });
});

describe('refuseSecretLike', () => {
  it('returns for clean text', () => {
    expect(() => {
      refuseSecretLike(['fine', 'also fine'], false);
    }).not.toThrow();
  });

  it.each(SECRET_PATTERN_NAMES)(
    'refuses %s with exit 1, naming the pattern and never the text',
    (name) => {
      const err = expectBoardError(
        () => {
          refuseSecretLike(['clean', `x ${SAMPLES[name]} y`], false);
        },
        1,
        'secret-like',
      );
      expect(err.message).toContain(name);
      expect(err.message).toContain('--allow-secret-like');
      expect(err.message).not.toContain(SAMPLES[name]);
      expect(err.message).not.toContain(SAMPLES[name].slice(-12));
      expect(err.message).not.toContain('clean');
    },
  );

  it('names every matching pattern', () => {
    const err = expectBoardError(
      () => {
        refuseSecretLike([SAMPLES['aws-access-key-id'], SAMPLES['github-token']], false);
      },
      1,
      'secret-like',
    );
    expect(err.message).toContain('aws-access-key-id');
    expect(err.message).toContain('github-token');
  });

  it('gives the exact message with the bypass hint by default', () => {
    const err = expectBoardError(
      () => {
        refuseSecretLike([SAMPLES['github-token'], SAMPLES['aws-access-key-id']], false);
      },
      1,
      'secret-like',
    );
    expect(err.message).toBe(
      'refused: the text matches the secret pattern(s) aws-access-key-id, github-token; ' +
        'the board is not a secret store (pass --allow-secret-like if this is not a secret)',
    );
  });

  it('omits the bypass hint when the command has no bypass flag', () => {
    const err = expectBoardError(
      () => {
        refuseSecretLike(['clean', `x ${SAMPLES['github-token']} y`], false, false);
      },
      1,
      'secret-like',
    );
    expect(err.message).toBe(
      'refused: the text matches the secret pattern(s) github-token; ' +
        'the board is not a secret store',
    );
  });

  it('still returns for clean text and honours allowSecretLike without a bypass flag', () => {
    expect(() => {
      refuseSecretLike(['fine'], false, false);
    }).not.toThrow();
    expect(() => {
      refuseSecretLike([SAMPLES['github-token']], true, false);
    }).not.toThrow();
  });

  it('is bypassed by allowSecretLike', () => {
    expect(() => {
      refuseSecretLike([SAMPLES['pem-private-key']], true);
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// secret-prefix-patterns task 1.1 (design.md "The patterns", "Minimum
// lengths" and "Testing approach"; board-cli "No secrets on the board").
// The fixtures are in src/__tests__/harness/provider-key-fixtures.ts.

/** Every audit row as a `[label, row]` pair for `it.each`. */
const ROWS = PROVIDER_KEYS.map((k) => [k.label, k] as const);

/**
 * `[pattern]`, then `generic-secret-assignment` when the value's first 32
 * characters are all of the base64 class of that pattern, recomputed
 * here: after `TOKEN=` such a value is also a secret assignment
 * (test-author ruling, design.md "Testing approach").
 */
function withAssignment(pattern: string, value: string): string[] {
  return /^[A-Za-z0-9+/_-]{32}/.test(value) ? [pattern, 'generic-secret-assignment'] : [pattern];
}

describe('secret-prefix-patterns: every audit row is named by its pattern', () => {
  it.each(ROWS)('%s, bare', (_label, k) => {
    expect(secretPatternsIn(k.value)).toEqual([k.pattern]);
  });

  it.each(ROWS)('%s, inside surrounding text', (_label, k) => {
    expect(secretPatternsIn(`see the log: ${k.value} and retry`)).toEqual([k.pattern]);
    expect(secretPatternsIn(`first line\n${k.value}\nlast line`)).toEqual([k.pattern]);
  });

  it.each(ROWS)('%s, after a quote and between quotes', (_label, k) => {
    expect(secretPatternsIn(`"${k.value}"`)).toEqual([k.pattern]);
    expect(secretPatternsIn(`'${k.value}'`)).toEqual([k.pattern]);
    expect(secretPatternsIn(`(${k.value})`)).toEqual([k.pattern]);
  });

  it.each(ROWS)('%s, after a colon and after = with no keyword', (_label, k) => {
    expect(secretPatternsIn(`see:${k.value}`)).toEqual([k.pattern]);
    expect(secretPatternsIn(`id=${k.value}`)).toEqual([k.pattern]);
  });

  it.each(ROWS.filter(([, k]) => !k.pattern.startsWith('pem')))(
    '%s, after TOKEN= (also a secret assignment when the key is long enough)',
    (_label, k) => {
      expect(secretPatternsIn(`TOKEN=${k.value}`)).toEqual(withAssignment(k.pattern, k.value));
    },
  );
});

describe('scenario: Bare provider key refused (the patterns)', () => {
  it('lists the seventeen scenario values in its order', () => {
    expect(SCENARIO_BARE_KEYS.map((k) => k.pattern)).toEqual([
      'anthropic-api-key',
      'digitalocean-token',
      'docker-token',
      'gitlab-token',
      'google-api-key',
      'huggingface-token',
      'jwt',
      'npm-token',
      'openai-api-key',
      'openai-api-key',
      'pypi-token',
      'sendgrid-api-key',
      'shopify-token',
      'slack-token',
      'stripe-secret-key',
      'stripe-secret-key',
      'stripe-webhook-secret',
    ]);
  });

  it.each(SCENARIO_BARE_KEYS.map((k) => [k.label, k] as const))(
    '%s: bare and between spaces, naming only its pattern',
    (_label, k) => {
      expect(secretPatternsIn(k.value)).toEqual([k.pattern]);
      expect(secretPatternsIn(`a ${k.value} b`)).toEqual([k.pattern]);
    },
  );
});

describe('scenario: Prefixed key after a separator or quote', () => {
  it.each(NEW_PATTERN_KEYS.map((k) => [k.pattern, k] as const))(
    '%s after TOKEN=, ", : and a space',
    (_name, k) => {
      expect(secretPatternsIn(`TOKEN=${k.value}`)[0]).toBe(k.pattern);
      expect(secretPatternsIn(`"${k.value}`)).toEqual([k.pattern]);
      expect(secretPatternsIn(`:${k.value}`)).toEqual([k.pattern]);
      expect(secretPatternsIn(` ${k.value}`)).toEqual([k.pattern]);
    },
  );

  it('the rotating Slack token after xoxe.', () => {
    expect(secretPatternsIn(providerKey('slack rotating xoxe.xoxp-1- + 140').value)).toEqual([
      'slack-token',
    ]);
  });

  it('a GitLab token after a double quote', () => {
    expect(secretPatternsIn(`"${GLPAT_20}`)).toEqual(['gitlab-token']);
  });

  it('keys after _, - and . (not letters or digits) still match, except a JWT after _ or -', () => {
    for (const k of NEW_PATTERN_KEYS) {
      const allowed =
        k.pattern === 'jwt'
          ? ['.', '=', '/', '[', '<', '\t', ' ', '"', ':']
          : ['_', '-', '.', '=', '/', '[', '<', '\t'];
      for (const before of allowed) {
        expect(secretPatternsIn(`${before}${k.value}`), `${before} ${k.label}`).toContain(
          k.pattern,
        );
      }
    }
  });

  it('scenario: JWT inside a base64url run: not jwt after _ or - (orchestrator ruling)', () => {
    for (const label of ['jwt 20 . 24 . 43', 'jwt 36 . 43 . 36']) {
      const value = providerKey(label).value;
      for (const before of ['_', '-', 'token_', 'id-', 'x_', '9-']) {
        expect(secretPatternsIn(`${before}${value}`), `${before} ${label}`).toEqual([]);
        expect(secretPatternsIn(`see ${before}${value} here`), `${before} ${label}`).toEqual([]);
      }
      expect(secretPatternsIn(`Bearer ${value}`)).toEqual(['jwt']);
      expect(secretPatternsIn(`auth=${value}`)).toEqual(['jwt']);
    }
  });
});

describe('scenario: Short key that fits the actor form', () => {
  it('rk_live_ and 16 letters and digits alone is stripe-secret-key', () => {
    expect(RK_LIVE_16).toHaveLength(24);
    expect(secretPatternsIn(RK_LIVE_16)).toEqual(['stripe-secret-key']);
  });

  it('the short Stripe and GitLab keys have the actor form, so only a pattern makes them fail the actor check', () => {
    for (const [value, pattern] of [
      [RK_LIVE_16, 'stripe-secret-key'],
      [RK_LIVE_24, 'stripe-secret-key'],
      [SK_TEST_24, 'stripe-secret-key'],
      [GLPAT_20, 'gitlab-token'],
    ] as const) {
      expect(ACTOR_FORM.test(value), pattern).toBe(true);
      expect(secretPatternsIn(value)).toEqual([pattern]);
      expect(isActorName(value), pattern).toBe(false);
    }
  });
});

describe('scenario: Assigned key names both patterns', () => {
  it('STRIPE_KEY=sk_live_ and 24: stripe-secret-key, generic-secret-assignment, in that order', () => {
    expect(secretPatternsIn(ASSIGNED_STRIPE_KEY)).toEqual([
      'stripe-secret-key',
      'generic-secret-assignment',
    ]);
    const err = expectBoardError(
      () => {
        refuseSecretLike([ASSIGNED_STRIPE_KEY], false);
      },
      1,
      'secret-like',
    );
    expect(err.message).toBe(
      'refused: the text matches the secret pattern(s) stripe-secret-key, generic-secret-assignment; ' +
        'the board is not a secret store (pass --allow-secret-like if this is not a secret)',
    );
  });
});

describe('scenario: Near-misses stay accepted', () => {
  it.each(NEAR_MISSES.map((k) => [k.label, k] as const))('%s matches no pattern', (_label, k) => {
    expect(secretPatternsIn(k.value)).toEqual([]);
    expect(secretPatternsIn(`see ${k.value} here`)).toEqual([]);
  });
});

describe('one character short of each minimum', () => {
  it.each(ONE_SHORT.map((k) => [k.label, k] as const))('%s matches no pattern', (_label, k) => {
    expect(secretPatternsIn(k.value)).toEqual([]);
    expect(secretPatternsIn(`"${k.value}" `)).toEqual([]);
  });
});

describe('each "at least" is a minimum with no maximum', () => {
  it.each(NEW_PATTERN_KEYS.map((k) => [k.pattern, k] as const))(
    '%s: a longer run, and a run followed by other text, still match',
    (_name, k) => {
      expect(secretPatternsIn(`${k.value}${alnum(64)}`)).toEqual([k.pattern]);
      expect(secretPatternsIn(`${k.value}; then more text`)).toEqual([k.pattern]);
      expect(secretPatternsIn(`${k.value}%20`)).toEqual([k.pattern]);
    },
  );

  it('exactly the minimum matches (16 after the long prefixes, 32 after the short ones)', () => {
    for (const [value, pattern] of [
      [['sk-', 'ant-', urlsafe(16)].join(''), 'anthropic-api-key'],
      [['glp', 'at-', urlsafe(16)].join(''), 'gitlab-token'],
      [['dckr', '_oat_', urlsafe(16)].join(''), 'docker-token'],
      [['sk', '_test_', alnum(16)].join(''), 'stripe-secret-key'],
      [['wh', 'sec_', alnum(16)].join(''), 'stripe-webhook-secret'],
      [['sk-', 'admin-', urlsafe(16)].join(''), 'openai-api-key'],
      [['AI', 'za', urlsafe(32)].join(''), 'google-api-key'],
      [['hf', '_', alnum(32)].join(''), 'huggingface-token'],
      [['npm', '_', alnum(32)].join(''), 'npm-token'],
      [['sk', '-', alnum(32)].join(''), 'openai-api-key'],
    ] as const) {
      expect(secretPatternsIn(value), pattern).toEqual([pattern]);
    }
  });
});

describe('scenario: Prefix inside a word', () => {
  it.each(PREFIX_INSIDE_A_WORD.map((k) => [k.label, k] as const))(
    '%s: no pattern matches',
    (_label, k) => {
      expect(secretPatternsIn(k.value)).toEqual([]);
      expect(secretPatternsIn(`see ${k.value} here`)).toEqual([]);
    },
  );

  it('the same keys after a space are refused (the anchor is what accepts them)', () => {
    for (const k of NEW_PATTERN_KEYS) {
      expect(secretPatternsIn(`x ${k.value}`), k.label).toEqual([k.pattern]);
    }
  });
});

describe('scenario: Anthropic key is not an OpenAI key', () => {
  it('every Anthropic shape names anthropic-api-key and not openai-api-key', () => {
    for (const label of [
      'anthropic sk-ant-api03- + 95',
      'anthropic sk-ant-admin01- + 95',
      'anthropic sk-ant-oat01- + 95',
    ]) {
      const names = secretPatternsIn(providerKey(label).value);
      expect(names, label).toEqual(['anthropic-api-key']);
      expect(names, label).not.toContain('openai-api-key');
    }
  });
});

describe('scenario: PGP private key block refused; Public key header accepted', () => {
  it('the PGP private key block header is pem-private-key', () => {
    expect(secretPatternsIn(['-----BEGIN', 'PGP PRIVATE KEY BLOCK-----'].join(' '))).toEqual([
      'pem-private-key',
    ]);
    expect(
      secretPatternsIn(`armoured:\n${['-----BEGIN', 'PGP PRIVATE KEY BLOCK-----'].join(' ')}\n`),
    ).toEqual(['pem-private-key']);
  });

  it('public key, PGP public key block and certificate headers match no pattern', () => {
    for (const header of [
      ['-----BEGIN', 'PUBLIC KEY-----'],
      ['-----BEGIN', 'PGP PUBLIC KEY BLOCK-----'],
      ['-----BEGIN', 'RSA PUBLIC KEY-----'],
      ['-----BEGIN', 'CERTIFICATE-----'],
    ]) {
      expect(secretPatternsIn(header.join(' '))).toEqual([]);
    }
  });
});

describe('a refusal names every matching pattern once, in SECRET_PATTERN_NAMES order', () => {
  it('several keys given in reverse order are reported in check order', () => {
    const text = [
      SAMPLES['generic-secret-assignment'],
      SAMPLES['stripe-webhook-secret'],
      SAMPLES.jwt,
      SAMPLES['stripe-webhook-secret'],
      SAMPLES['anthropic-api-key'],
      SAMPLES['pem-private-key'],
    ].join(' ');
    expect(secretPatternsIn(text)).toEqual([
      'pem-private-key',
      'anthropic-api-key',
      'jwt',
      'stripe-webhook-secret',
      'generic-secret-assignment',
    ]);
  });

  it('every new pattern at once, shuffled, is reported once each in order', () => {
    const shuffled = [...NEW_PATTERN_KEYS].reverse().map((k) => k.value);
    expect(secretPatternsIn([...shuffled, ...shuffled].join('\n'))).toEqual(
      SECRET_PATTERN_NAMES.slice(3, -1),
    );
  });

  it('refuseSecretLike names them in order across texts, and echoes none of them', () => {
    const err = expectBoardError(
      () => {
        refuseSecretLike(
          [SAMPLES['slack-token'], 'clean', SAMPLES['docker-token'], SAMPLES['aws-access-key-id']],
          false,
        );
      },
      1,
      'secret-like',
    );
    expect(err.message).toBe(
      'refused: the text matches the secret pattern(s) aws-access-key-id, docker-token, slack-token; ' +
        'the board is not a secret store (pass --allow-secret-like if this is not a secret)',
    );
  });
});

// ---------------------------------------------------------------------------
// Time guard (orchestrator ruling during group 1; board-cli scenario
// "Adversarial input is checked in linear time"; design.md "Anchoring"):
// every pattern runs over 64 KB near-miss inputs, the shapes of the
// implementer's timing script, and each check must finish within 1 s. A
// quadratic pattern takes seconds at this size (the general-anchor jwt
// took 5.7 s on `eyJ_` repeated); a linear one takes milliseconds.

/** 64 KB. */
const SIZE = 64 * 1024;

/** `unit` repeated to exactly `SIZE` characters. */
function rep(unit: string): string {
  return unit.repeat(Math.ceil(SIZE / unit.length)).slice(0, SIZE);
}

/** `prefix` then `SIZE` characters of `fill`, with no terminator. */
function run(prefix: string, fill: string): string {
  return prefix + fill.repeat(SIZE);
}

/** `n` copies of `a`. */
const as = (n: number): string => 'a'.repeat(n);

/** The PyPI prefix, split so no source line holds a token prefix whole. */
const PYPI_PREFIX = ['pypi-AgEI', 'cHlwaS5vcmc'].join('');

/** Adversarial inputs per pattern: `[pattern, label, input]`. Labels name shapes, never values. */
const ADVERSARIAL: readonly (readonly [string, string, string])[] = [
  ['pem-private-key', 'BEGIN and a long run', run('-----BEGIN ', 'A ')],
  ['pem-private-key', 'near-miss headers repeated', rep('-----BEGIN PRIVATE KEX-----')],
  ['aws-access-key-id', 'prefix repeated', rep('AKIA-')],
  ['aws-access-key-id', 'prefix and a long run', run('AKIA', 'A')],
  ['github-token', 'prefix repeated', rep('ghp_-')],
  ['github-token', 'fine-grained one short repeated', rep(`github_pat_${as(21)}-`)],
  ['anthropic-api-key', 'prefix repeated', rep('sk-ant-')],
  ['anthropic-api-key', 'one short repeated', rep(`sk-ant-${as(15)} `)],
  ['digitalocean-token', 'prefix repeated', rep('dop_v1_')],
  ['digitalocean-token', 'prefix and a non-hex run', run('dop_v1_', 'g')],
  ['docker-token', 'prefix repeated', rep('dckr_pat_')],
  ['docker-token', 'one short repeated', rep(`dckr_pat_${as(15)} `)],
  ['gitlab-token', 'prefix repeated', rep('glpat-')],
  ['gitlab-token', 'one short repeated', rep(`glpat-${as(15)} `)],
  ['google-api-key', 'prefix repeated', rep('AIza.')],
  ['google-api-key', 'one short repeated', rep(`AIza${as(31)} `)],
  ['huggingface-token', 'prefix repeated', rep('hf_-')],
  ['huggingface-token', 'one short repeated', rep(`hf_${as(31)} `)],
  ['jwt', 'eyJ_ repeated', rep('eyJ_')],
  ['jwt', 'eyJ- repeated', rep('eyJ-')],
  ['jwt', 'prefix and a long run with no dot', run('eyJ', 'a')],
  ['jwt', 'first segments repeated', rep(`eyJ${as(8)}.`)],
  ['jwt', 'one segment then eyJ_ repeated', `eyJ${as(8)}.${rep('eyJ_')}`],
  ['jwt', 'two segments then eyJ_ repeated', `eyJ${as(8)}.eyJ${as(8)}.${rep('_-')}x`],
  ['jwt', 'eyJ_eyJ. repeated', rep('eyJ_eyJ.')],
  ['npm-token', 'prefix repeated', rep('npm_-')],
  ['npm-token', 'one short repeated', rep(`npm_${as(31)} `)],
  ['openai-api-key', 'prefix repeated', rep('sk-')],
  ['openai-api-key', 'prefix and a hyphen run', run('sk-', '-')],
  ['openai-api-key', 'project one short repeated', rep(`sk-proj-${as(15)} `)],
  ['openai-api-key', 'bare one short repeated', rep(`sk-${as(31)} `)],
  ['pypi-token', 'prefix repeated', rep(`${PYPI_PREFIX}.`)],
  ['pypi-token', 'one short repeated', rep(`${PYPI_PREFIX}${as(15)} `)],
  ['sendgrid-api-key', 'prefix repeated', rep('SG.')],
  ['sendgrid-api-key', 'prefix and a long run with no dot', run('SG.', 'a')],
  ['sendgrid-api-key', 'first segments repeated', rep(`SG.${as(16)}.`)],
  ['sendgrid-api-key', 'prefix and hyphen repeated', rep('SG.-')],
  ['sendgrid-api-key', 'prefix then a-SG. repeated', `SG.${rep('a-SG.')}`],
  ['shopify-token', 'prefix repeated', rep('shpat_')],
  ['shopify-token', 'prefix and a non-hex run', run('shpat_', 'g')],
  ['slack-token', 'prefix repeated', rep('xoxb-')],
  ['slack-token', 'prefix and a digit run', run('xoxb-', '1')],
  ['slack-token', 'one short repeated', rep(`xoxb-1-${as(15)} `)],
  ['slack-token', 'prefix, digit, hyphen repeated', rep('xoxb-1-')],
  ['stripe-secret-key', 'prefix repeated', rep('sk_live_')],
  ['stripe-secret-key', 'one short repeated', rep(`sk_live_${as(15)} `)],
  ['stripe-webhook-secret', 'prefix repeated', rep('whsec_')],
  ['stripe-webhook-secret', 'one short repeated', rep(`whsec_${as(15)} `)],
  ['generic-secret-assignment', 'keyword repeated', rep('key=')],
  ['generic-secret-assignment', 'keyword and a non-base64 run', run('key=', '.')],
  ['generic-secret-assignment', 'one short repeated', rep(`key=${as(31)} `)],
  [
    'every pattern',
    'letters and digits',
    rep('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'),
  ],
];

describe('time guard: every pattern is checked in linear time', () => {
  it('covers every pattern name', () => {
    const covered = new Set(ADVERSARIAL.map(([name]) => name));
    for (const name of SECRET_PATTERN_NAMES) {
      expect(covered.has(name), name).toBe(true);
    }
  });

  it.each(ADVERSARIAL.map(([name, label, input]) => [`${name}: ${label}`, input] as const))(
    '%s (64 KB) is checked within 1 s',
    (_label, input) => {
      expect(input.length).toBeGreaterThanOrEqual(SIZE);
      const start = performance.now();
      secretPatternsIn(input);
      expect(performance.now() - start).toBeLessThan(1000);
    },
  );
});

// ---------------------------------------------------------------------------
// Review round 1 (orchestrator rulings R1 to R5; design.md "Rulings from
// review round 1").

describe('R1: no pattern throws on very long input (board-cli "Very long input is checked without error")', () => {
  /** About 6 MiB: past the 5.3 MiB at which an open-ended counted repeat overflows V8's backtrack stack. */
  const MIB6 = 6 * 1024 * 1024;

  /** `[label, build, expected]`: the input is built inside the test so only one is in memory at a time. */
  const LONG: readonly (readonly [string, () => string, readonly string[]])[] = [
    ['eyJ then 6 MiB of A', () => `eyJ${'A'.repeat(MIB6)}`, []],
    ['eyJ then 6 MiB of the base64url alphabet', () => `eyJ${urlsafe(MIB6)}`, []],
    [
      'one JWT segment, then eyJ and 6 MiB of A',
      () => `eyJ${'a'.repeat(8)}.eyJ${'A'.repeat(MIB6)}`,
      [],
    ],
    [
      'a JWT whose first segment is 6 MiB',
      () => `eyJ${'A'.repeat(MIB6)}.eyJ${'a'.repeat(8)}.${'a'.repeat(16)}`,
      ['jwt'],
    ],
    [
      'a JWT whose second segment is 6 MiB',
      () => `eyJ${'a'.repeat(8)}.eyJ${'A'.repeat(MIB6)}.${'a'.repeat(16)}`,
      ['jwt'],
    ],
    ['SG. then 6 MiB of A', () => `SG.${'A'.repeat(MIB6)}`, []],
    ['SG. then 6 MiB of the base64url alphabet', () => `SG.${urlsafe(MIB6)}`, []],
    [
      'a SendGrid key whose first segment is 6 MiB',
      () => `SG.${'A'.repeat(MIB6)}.${'a'.repeat(16)}`,
      ['sendgrid-api-key'],
    ],
    // Every pattern: 6 MiB of its alphabet straight after its prefix.
    ['pem: BEGIN then 6 MiB of A and spaces', () => `-----BEGIN ${'A '.repeat(MIB6 / 2)}`, []],
    ['aws: AKIA then 6 MiB of A', () => `AKIA${'A'.repeat(MIB6)}`, []],
    ['github: ghp_ then 6 MiB', () => ['gh', 'p_', alnum(MIB6)].join(''), ['github-token']],
    [
      'anthropic: sk-ant- then 6 MiB',
      () => ['sk-', 'ant-', urlsafe(MIB6)].join(''),
      ['anthropic-api-key'],
    ],
    [
      'digitalocean: dop_v1_ then 6 MiB',
      () => ['dop', '_v1_', hex(MIB6)].join(''),
      ['digitalocean-token'],
    ],
    [
      'docker: dckr_pat_ then 6 MiB',
      () => ['dckr', '_pat_', urlsafe(MIB6)].join(''),
      ['docker-token'],
    ],
    ['gitlab: glpat- then 6 MiB', () => ['glp', 'at-', urlsafe(MIB6)].join(''), ['gitlab-token']],
    ['google: AIza then 6 MiB', () => ['AI', 'za', urlsafe(MIB6)].join(''), ['google-api-key']],
    ['huggingface: hf_ then 6 MiB', () => ['hf', '_', alnum(MIB6)].join(''), ['huggingface-token']],
    ['npm: npm_ then 6 MiB', () => ['npm', '_', alnum(MIB6)].join(''), ['npm-token']],
    [
      'openai: sk-proj- then 6 MiB',
      () => ['sk-', 'proj-', urlsafe(MIB6)].join(''),
      ['openai-api-key'],
    ],
    ['openai: sk- then 6 MiB', () => ['sk', '-', alnum(MIB6)].join(''), ['openai-api-key']],
    [
      'pypi: prefix then 6 MiB',
      () => ['pypi-AgEI', 'cHlwaS5vcmc', urlsafe(MIB6)].join(''),
      ['pypi-token'],
    ],
    ['shopify: shpat_ then 6 MiB', () => ['shp', 'at_', hex(MIB6)].join(''), ['shopify-token']],
    ['slack: xoxb-1- then 6 MiB', () => ['xox', 'b-1-', alnum(MIB6)].join(''), ['slack-token']],
    ['slack: xoxb- then 6 MiB of digits', () => ['xox', 'b-', '1'.repeat(MIB6)].join(''), []],
    [
      'stripe: sk_live_ then 6 MiB',
      () => ['sk', '_live_', alnum(MIB6)].join(''),
      ['stripe-secret-key'],
    ],
    [
      'whsec: whsec_ then 6 MiB',
      () => ['wh', 'sec_', alnum(MIB6)].join(''),
      ['stripe-webhook-secret'],
    ],
    ['generic: key= then 6 MiB', () => `key=${urlsafe(MIB6)}`, ['generic-secret-assignment']],
  ];

  it.each(LONG.map(([label, build, expected]) => [label, build, expected] as const))(
    '%s: returns its names without throwing, within 10 s',
    (_label, build, expected) => {
      const input = build();
      expect(input.length).toBeGreaterThanOrEqual(MIB6);
      const start = performance.now();
      let names: string[] = [];
      expect(() => {
        names = secretPatternsIn(input);
      }).not.toThrow();
      expect(performance.now() - start).toBeLessThan(10_000);
      expect(names).toEqual(expected);
    },
  );

  it('refuseSecretLike and isActorName also return normally on 6 MiB after eyJ and SG.', () => {
    for (const input of [`eyJ${'A'.repeat(MIB6)}`, `SG.${'A'.repeat(MIB6)}`]) {
      expect(() => {
        refuseSecretLike([input], false);
      }).not.toThrow();
      expect(isActorName(input)).toBe(false);
    }
  });
});

describe('R2: a key right after a backslash escape or a percent-encoding is matched', () => {
  it.each(AFTER_ESCAPE.map(([label, text, pattern]) => [label, text, pattern] as const))(
    '%s',
    (_label, text, pattern) => {
      expect(secretPatternsIn(text)).toEqual([pattern]);
      expect(secretPatternsIn(`{"msg":"${text}"}`)).toEqual([pattern]);
    },
  );

  it('an escaped backslash then n before a key is judged on the two characters \\n: matched (test-author ruling)', () => {
    expect(secretPatternsIn(DOUBLE_BACKSLASH_N)).toEqual(['stripe-secret-key']);
  });

  it('desk_live_ stays unmatched, and an incomplete escape or percent-encoding still blocks a prefix', () => {
    expect(secretPatternsIn(['de', 'sk', '_live_', alnum(24)].join(''))).toEqual([]);
    expect(secretPatternsIn(['\\nde', 'sk', '_live_', alnum(24)].join(''))).toEqual([]);
    expect(secretPatternsIn(['%3Dde', 'sk', '_live_', alnum(24)].join(''))).toEqual([]);
  });

  it('a JWT after an escape or a percent-encoding is matched, after _ or - still not', () => {
    const value = jwt(20, 24, 43);
    for (const before of ['\\n', '\\t', '%22', '%3D', '%20']) {
      expect(secretPatternsIn(`${before}${value}`), before).toEqual(['jwt']);
    }
    for (const before of ['\\n_', '%20-', '_', '-']) {
      expect(secretPatternsIn(`${before}${value}`), before).toEqual([]);
    }
  });

  it('the AWS key id keeps its own two-sided anchor (test-author ruling): not matched after \\n', () => {
    const id = ['AK', 'IA', 'Q4X7FAKEEXAMPLE2'].join('');
    expect(secretPatternsIn(` ${id}`)).toEqual(['aws-access-key-id']);
    expect(secretPatternsIn(`\\n${id}`)).toEqual([]);
  });
});

describe('R3: slugs after hyphenated prefixes are refused (accepted residual risk)', () => {
  it.each(SLUG_FALSE_POSITIVES.map((k) => [k.label, k] as const))(
    '%s names its pattern',
    (_label, k) => {
      expect(secretPatternsIn(k.value)).toEqual([k.pattern]);
    },
  );

  it.each(SLUG_ACTORS.map((k) => [k.label, k] as const))(
    '%s, of the actor form, fails the actor check by its pattern',
    (_label, k) => {
      expect(ACTOR_FORM.test(k.value)).toBe(true);
      expect(secretPatternsIn(k.value)).toEqual([k.pattern]);
      expect(isActorName(k.value)).toBe(false);
    },
  );
});

describe('R4: OpenAI user keys sk-None- are openai-api-key', () => {
  it('sk-None- with 48 letters and digits, and with exactly 16 of the base64url alphabet, match; 15 do not', () => {
    expect(secretPatternsIn(providerKey('openai user sk-None- + 48').value)).toEqual([
      'openai-api-key',
    ]);
    expect(secretPatternsIn(['sk-', 'None-', urlsafe(16)].join(''))).toEqual(['openai-api-key']);
    expect(secretPatternsIn(['sk-', 'None-', urlsafe(15)].join(''))).toEqual([]);
    expect(secretPatternsIn(['sk-', 'none-', urlsafe(48)].join(''))).toEqual([]);
  });
});

describe('R5: exact boundaries of the second segments, and the other surviving mutants', () => {
  it('a JWT whose segments are exactly eyJ + 8, eyJ + 8 and 16 matches', () => {
    expect(jwt(11, 11, 16)).toHaveLength(11 + 1 + 11 + 1 + 16);
    expect(secretPatternsIn(jwt(11, 11, 16))).toEqual(['jwt']);
    expect(secretPatternsIn(jwt(11, 10, 16))).toEqual([]);
    expect(secretPatternsIn(jwt(10, 11, 16))).toEqual([]);
    expect(secretPatternsIn(jwt(11, 11, 15))).toEqual([]);
  });

  it('a SendGrid key whose segments are exactly 16 and 16 matches', () => {
    expect(secretPatternsIn(sendgrid(16, 16))).toEqual(['sendgrid-api-key']);
    expect(secretPatternsIn(sendgrid(16, 15))).toEqual([]);
    expect(secretPatternsIn(sendgrid(15, 16))).toEqual([]);
  });

  it('the near-misses with _ at or past the minimum, SG without its dot, xoxb-- and another PyPI tail all match nothing', () => {
    const labels = [
      'hf_ snake_case, 39 after the prefix',
      'hf_ + 31 then _ then 31',
      'npm_ snake_case, 45 after the prefix',
      'npm_ + 31 then _ then 31',
      'sk_test_ snake_case, 32 after the prefix',
      'rk_live_ + 15 then _ then 15',
      'sk_live_ + 15 then _ then 15',
      'whsec_ snake_case, 30 after the prefix',
      'whsec_ + 15 then _ then 15',
      'SGx 22 . 43',
      'SG_ 22 . 43',
      'xoxb-- + 24',
      'xapp-- + 24',
      'pypi-AgEIcHlw with another tail + 150',
      'pypi-AgEI + 150',
    ];
    for (const label of labels) {
      const k = NEAR_MISSES.find((n) => n.label === label);
      expect(k, label).toBeDefined();
      expect(secretPatternsIn(k?.value ?? ''), label).toEqual([]);
    }
  });
});
