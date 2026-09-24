import { describe, expect, it } from 'vitest';

import { SECRET_PATTERN_NAMES, refuseSecretLike, secretPatternsIn } from '../secrets.js';
import { B64, SAMPLES, expectBoardError } from './helpers.js';

describe('SECRET_PATTERN_NAMES', () => {
  it('names the four patterns in check order', () => {
    expect(SECRET_PATTERN_NAMES).toEqual([
      'pem-private-key',
      'aws-access-key-id',
      'github-token',
      'generic-secret-assignment',
    ]);
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
