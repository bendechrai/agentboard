import { describe, expect, it } from 'vitest';

import {
  ASSIGNED_STRIPE_KEY,
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

  it('keys after _, - and . (not letters or digits) still match', () => {
    for (const k of NEW_PATTERN_KEYS) {
      for (const before of ['_', '-', '.', '=', '/', '[', '<', '\t']) {
        expect(secretPatternsIn(`${before}${k.value}`), `${before} ${k.label}`).toContain(
          k.pattern,
        );
      }
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
