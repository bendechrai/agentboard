/**
 * Provider key fixtures for secret-prefix-patterns (design.md "Audit" and
 * "Testing approach"; board-cli "No secrets on the board"): one synthetic
 * value per audit row, the values the board-cli scenarios name, one
 * character short of each minimum, a letter or digit before each prefix,
 * the near-misses of design.md "False positives", and the keys that have
 * the actor form.
 *
 * Every value is built at run time from a prefix split in two and a
 * visibly fake body (`fake`: a repeated unit of `FAKE`, `EXAMPLE`, `NOT`,
 * `real` and digits, or `deadbeef` hex), so that no complete key-shaped
 * string is in the source, where a secret scanner or a host's push
 * protection would flag it (as `src/board/__tests__/helpers.ts` and
 * `secret-fixtures.ts` do with `join`). None of them is a real credential.
 *
 * The module has no imports, so a reviewer's throwaway program can load it
 * with `node` and recompute every expectation without the code under test
 * (tasks.md 1.3).
 */

/** Letters and digits: `[A-Za-z0-9]`. */
const ALNUM = 'FAKE0EXAMPLE1abc2NOT3real4xyz5';
/** The base64url alphabet `[A-Za-z0-9_-]`, using both `-` and `_`. */
const URLSAFE = 'FAKE-EXAMPLE_0abc-NOT_real1xyz2';
/** Letters only: `[A-Za-z]`. */
const LETTERS = 'FAKEEXAMPLEabcNOTrealxyz';
/** Lower-case hex: `[a-f0-9]`. */
const HEX = 'deadbeef0123456789abcdef';

/** `length` characters of `unit`, repeated and cut. Pure. */
export function fake(unit: string, length: number): string {
  return unit.repeat(Math.ceil(length / unit.length) + 1).slice(0, length);
}

/** `length` characters of `[A-Za-z0-9]`. */
export const alnum = (length: number): string => fake(ALNUM, length);
/** `length` characters of `[A-Za-z0-9_-]`. */
export const urlsafe = (length: number): string => fake(URLSAFE, length);
/** `length` letters. */
export const letters = (length: number): string => fake(LETTERS, length);
/** `length` lower-case hex digits. */
export const hex = (length: number): string => fake(HEX, length);

/** `prefix` (given in two parts so no source line holds it whole) followed by `body`. */
function key(head: string, tail: string, body: string): string {
  return [head, tail, body].join('');
}

/** A JWT of three segments of `a`, `b` and `c` characters (`a` and `b` include `eyJ`). */
export function jwt(a: number, b: number, c: number): string {
  return [key('ey', 'J', alnum(a - 3)), key('ey', 'J', alnum(b - 3)), urlsafe(c)].join('.');
}

/** A SendGrid key: `SG.`, `a` characters, `.`, `b` characters. */
export function sendgrid(a: number, b: number): string {
  return [key('S', 'G', ''), urlsafe(a), urlsafe(b)].join('.');
}

/** A Slack bot-style token: `<prefix>`, two digit groups, then `n` letters and digits. */
export function slack(prefix: string, n: number): string {
  return key(prefix.slice(0, 3), prefix.slice(3), `2048163390-5182934756103-${alnum(n)}`);
}

/** The PyPI token prefix (an encoded macaroon header), in two parts. */
const PYPI = ['pypi-AgEI', 'cHlwaS5vcmc'].join('');

/** One synthetic value and the pattern names `secretPatternsIn` must report for it. */
export interface ProviderKey {
  /** A short label naming the shape (never the value). */
  readonly label: string;
  /** The value. */
  readonly value: string;
  /** The single pattern name the bare value matches. */
  readonly pattern: string;
}

/** One audit row (design.md "Audit"), the bare value matching exactly `pattern`. */
function row(label: string, value: string, pattern: string): ProviderKey {
  return { label, value, pattern };
}

/**
 * Every refused shape of design.md "Audit", bare. Each matches exactly
 * one pattern, its `pattern`. The four excluded public identifiers
 * (Stripe `pk_live_` and `pk_test_`, Twilio `SK` and `AC`) are in
 * `NEAR_MISSES` instead.
 */
export const PROVIDER_KEYS: readonly ProviderKey[] = [
  row('pem private key', ['-----BEGIN', 'PRIVATE KEY-----'].join(' '), 'pem-private-key'),
  row('pem rsa', ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' '), 'pem-private-key'),
  row('pem openssh', ['-----BEGIN', 'OPENSSH PRIVATE KEY-----'].join(' '), 'pem-private-key'),
  row('pem encrypted', ['-----BEGIN', 'ENCRYPTED PRIVATE KEY-----'].join(' '), 'pem-private-key'),
  row(
    'pgp private key block',
    ['-----BEGIN', 'PGP PRIVATE KEY BLOCK-----'].join(' '),
    'pem-private-key',
  ),
  row('aws AKIA + 16', key('AK', 'IA', 'Q4X7FAKEEXAMPLE2'), 'aws-access-key-id'),
  row('aws ASIA + 16', key('AS', 'IA', 'Q4X7FAKEEXAMPLE2'), 'aws-access-key-id'),
  row('github ghp_ + 36', key('gh', 'p_', alnum(36)), 'github-token'),
  row('github gho_ + 36', key('gh', 'o_', alnum(36)), 'github-token'),
  row('github ghu_ + 36', key('gh', 'u_', alnum(36)), 'github-token'),
  row('github ghs_ + 36', key('gh', 's_', alnum(36)), 'github-token'),
  row('github ghr_ + 36', key('gh', 'r_', alnum(36)), 'github-token'),
  row('github_pat_ + 22 _ 59', key('github', '_pat_', `${alnum(22)}_${alnum(59)}`), 'github-token'),
  row('anthropic sk-ant-api03- + 95', key('sk-', 'ant-api03-', urlsafe(95)), 'anthropic-api-key'),
  row(
    'anthropic sk-ant-admin01- + 95',
    key('sk-', 'ant-admin01-', urlsafe(95)),
    'anthropic-api-key',
  ),
  row('anthropic sk-ant-oat01- + 95', key('sk-', 'ant-oat01-', urlsafe(95)), 'anthropic-api-key'),
  row('digitalocean dop_v1_ + 64', key('dop', '_v1_', hex(64)), 'digitalocean-token'),
  row('digitalocean doo_v1_ + 64', key('doo', '_v1_', hex(64)), 'digitalocean-token'),
  row('digitalocean dor_v1_ + 64', key('dor', '_v1_', hex(64)), 'digitalocean-token'),
  row('docker dckr_pat_ + 27', key('dckr', '_pat_', urlsafe(27)), 'docker-token'),
  row('docker dckr_oat_ + 27', key('dckr', '_oat_', urlsafe(27)), 'docker-token'),
  row('gitlab glpat- + 20', key('glp', 'at-', urlsafe(20)), 'gitlab-token'),
  row('google AIza + 35', key('AI', 'za', urlsafe(35)), 'google-api-key'),
  row('huggingface hf_ + 34 letters', key('hf', '_', letters(34)), 'huggingface-token'),
  row('jwt 20 . 24 . 43', jwt(20, 24, 43), 'jwt'),
  row('jwt 36 . 43 . 36', jwt(36, 43, 36), 'jwt'),
  row('npm npm_ + 36', key('npm', '_', alnum(36)), 'npm-token'),
  row('openai sk- + 48', key('sk', '-', alnum(48)), 'openai-api-key'),
  row('openai sk-proj- + 156', key('sk-', 'proj-', urlsafe(156)), 'openai-api-key'),
  row('openai sk-svcacct- + 156', key('sk-', 'svcacct-', urlsafe(156)), 'openai-api-key'),
  row('openai sk-admin- + 156', key('sk-', 'admin-', urlsafe(156)), 'openai-api-key'),
  row('pypi + 150', [PYPI, urlsafe(150)].join(''), 'pypi-token'),
  row('sendgrid SG. 22 . 43', sendgrid(22, 43), 'sendgrid-api-key'),
  row('shopify shpat_ + 32', key('shp', 'at_', hex(32)), 'shopify-token'),
  row('shopify shpca_ + 32', key('shp', 'ca_', hex(32)), 'shopify-token'),
  row('shopify shppa_ + 32', key('shp', 'pa_', hex(32)), 'shopify-token'),
  row(
    'shopify shpss_ + 32 upper-case hex',
    key('shp', 'ss_', hex(32).toUpperCase()),
    'shopify-token',
  ),
  row('slack xoxa-', slack('xoxa-', 24), 'slack-token'),
  row('slack xoxb-', slack('xoxb-', 24), 'slack-token'),
  row('slack xoxe-', slack('xoxe-', 24), 'slack-token'),
  row('slack xoxp-', slack('xoxp-', 24), 'slack-token'),
  row('slack xoxr-', slack('xoxr-', 24), 'slack-token'),
  row('slack xoxs-', slack('xoxs-', 24), 'slack-token'),
  row('slack rotating xoxe.xoxp-1- + 140', key('xoxe.', 'xoxp-1-', alnum(140)), 'slack-token'),
  row('slack app-level xapp-1- + 90', key('xa', 'pp-1-', `A0FAKE-${alnum(83)}`), 'slack-token'),
  row('stripe sk_live_ + 24', key('sk', '_live_', alnum(24)), 'stripe-secret-key'),
  row('stripe sk_test_ + 24', key('sk', '_test_', alnum(24)), 'stripe-secret-key'),
  row('stripe sk_live_ + 99', key('sk', '_live_', alnum(99)), 'stripe-secret-key'),
  row('stripe rk_live_ + 24', key('rk', '_live_', alnum(24)), 'stripe-secret-key'),
  row('stripe rk_live_ + 99', key('rk', '_live_', alnum(99)), 'stripe-secret-key'),
  row('stripe rk_test_ + 16', key('rk', '_test_', alnum(16)), 'stripe-secret-key'),
  row('stripe rk_test_ + 99', key('rk', '_test_', alnum(99)), 'stripe-secret-key'),
  row('stripe whsec_ + 32', key('wh', 'sec_', alnum(32)), 'stripe-webhook-secret'),
];

/** The audit row labelled `label`. */
export function providerKey(label: string): ProviderKey {
  const found = PROVIDER_KEYS.find((k) => k.label === label);
  if (found === undefined) {
    throw new Error(`no provider key labelled ${label}`);
  }
  return found;
}

/**
 * The values of board-cli scenario "Bare provider key refused", in its
 * order, each with the one pattern it names.
 */
export const SCENARIO_BARE_KEYS: readonly ProviderKey[] = [
  'anthropic sk-ant-api03- + 95',
  'digitalocean dop_v1_ + 64',
  'docker dckr_pat_ + 27',
  'gitlab glpat- + 20',
  'google AIza + 35',
  'huggingface hf_ + 34 letters',
  'jwt 20 . 24 . 43',
  'npm npm_ + 36',
  'openai sk-proj- + 156',
  'openai sk- + 48',
  'pypi + 150',
  'sendgrid SG. 22 . 43',
  'shopify shpat_ + 32',
  'slack xoxb-',
  'stripe sk_live_ + 24',
  'stripe rk_test_ + 99',
  'stripe whsec_ + 32',
].map(providerKey);

/**
 * The fifteen new pattern names, in `SECRET_PATTERN_NAMES` order (design.md
 * "The patterns"), each with one representative value from the audit.
 */
export const NEW_PATTERN_KEYS: readonly ProviderKey[] = [
  'anthropic sk-ant-api03- + 95',
  'digitalocean dop_v1_ + 64',
  'docker dckr_pat_ + 27',
  'gitlab glpat- + 20',
  'google AIza + 35',
  'huggingface hf_ + 34 letters',
  'jwt 20 . 24 . 43',
  'npm npm_ + 36',
  'openai sk-proj- + 156',
  'pypi + 150',
  'sendgrid SG. 22 . 43',
  'shopify shpat_ + 32',
  'slack xoxb-',
  'stripe sk_live_ + 24',
  'stripe whsec_ + 32',
].map(providerKey);

/** A value that matches no pattern, with the reason it is listed. */
export interface Accepted {
  readonly label: string;
  readonly value: string;
}

/**
 * One character short of each minimum of a new pattern (design.md
 * "Minimum lengths"): every one matches no pattern. Each stands alone
 * (end of string), so nothing after it extends the run.
 */
export const ONE_SHORT: readonly Accepted[] = [
  { label: 'sk-ant- + 15', value: key('sk-', 'ant-', urlsafe(15)) },
  { label: 'dop_v1_ + 15', value: key('dop', '_v1_', hex(15)) },
  { label: 'doo_v1_ + 15', value: key('doo', '_v1_', hex(15)) },
  { label: 'dor_v1_ + 15', value: key('dor', '_v1_', hex(15)) },
  { label: 'dckr_pat_ + 15', value: key('dckr', '_pat_', urlsafe(15)) },
  { label: 'dckr_oat_ + 15', value: key('dckr', '_oat_', urlsafe(15)) },
  { label: 'glpat- + 15', value: key('glp', 'at-', urlsafe(15)) },
  { label: 'AIza + 31', value: key('AI', 'za', urlsafe(31)) },
  { label: 'hf_ + 31', value: key('hf', '_', alnum(31)) },
  { label: 'jwt first segment eyJ + 7', value: jwt(10, 11, 16) },
  { label: 'jwt second segment eyJ + 7', value: jwt(11, 10, 16) },
  { label: 'jwt signature 15', value: jwt(11, 11, 15) },
  { label: 'npm_ + 31', value: key('npm', '_', alnum(31)) },
  { label: 'sk-proj- + 15', value: key('sk-', 'proj-', urlsafe(15)) },
  { label: 'sk-svcacct- + 15', value: key('sk-', 'svcacct-', urlsafe(15)) },
  { label: 'sk-admin- + 15', value: key('sk-', 'admin-', urlsafe(15)) },
  { label: 'sk- + 31', value: key('sk', '-', alnum(31)) },
  { label: 'pypi + 15', value: [PYPI, urlsafe(15)].join('') },
  { label: 'SG. 15 . 16', value: sendgrid(15, 16) },
  { label: 'SG. 16 . 15', value: sendgrid(16, 15) },
  { label: 'shpat_ + 15', value: key('shp', 'at_', hex(15)) },
  { label: 'shpss_ + 15', value: key('shp', 'ss_', hex(15)) },
  // One digit group, so the 15 characters after its hyphen are the whole run.
  { label: 'xoxb- digits - 15', value: key('xox', 'b-', `2048163390-${alnum(15)}`) },
  { label: 'xapp- digits - 15', value: key('xa', 'pp-', `1-${alnum(15)}`) },
  { label: 'sk_live_ + 15', value: key('sk', '_live_', alnum(15)) },
  { label: 'sk_test_ + 15', value: key('sk', '_test_', alnum(15)) },
  { label: 'rk_live_ + 15', value: key('rk', '_live_', alnum(15)) },
  { label: 'rk_test_ + 15', value: key('rk', '_test_', alnum(15)) },
  { label: 'whsec_ + 15', value: key('wh', 'sec_', alnum(15)) },
];

/**
 * The near-misses of design.md "False positives" and board-cli scenario
 * "Near-misses stay accepted", and the public key headers of scenario
 * "Public key header accepted": every one matches no pattern.
 */
export const NEAR_MISSES: readonly Accepted[] = [
  { label: 'pk_live_ + 24', value: key('pk', '_live_', alnum(24)) },
  { label: 'pk_test_ + 24', value: key('pk', '_test_', alnum(24)) },
  { label: 'pk_live_ + 99', value: key('pk', '_live_', alnum(99)) },
  { label: 'sk_live_ + 15', value: key('sk', '_live_', alnum(15)) },
  { label: 'sk_test_...', value: 'sk_test_...' },
  { label: 'glpat- + 15', value: key('glp', 'at-', urlsafe(15)) },
  { label: 'whsec_short', value: 'whsec_short' },
  { label: 'npm_config_cache_directory_setting', value: 'npm_config_cache_directory_setting' },
  { label: 'npm_package_version', value: 'npm_package_version' },
  { label: 'hf_hub_download_cache_dir', value: 'hf_hub_download_cache_dir' },
  { label: 'pypi-publish-workflow-step-two', value: 'pypi-publish-workflow-step-two' },
  { label: 'xoxo-hugs-and-kisses-everyone', value: 'xoxo-hugs-and-kisses-everyone' },
  { label: 'sk-learn-and-pandas-in-the-notebook', value: 'sk-learn-and-pandas-in-the-notebook' },
  {
    label: 'task-runner-for-the-ci-pipeline-and-more',
    value: 'task-runner-for-the-ci-pipeline-and-more',
  },
  { label: 'SG.example.com', value: 'SG.example.com' },
  { label: 'eyJ is how base64 JSON starts', value: 'eyJ is how base64 JSON starts' },
  { label: 'twilio SK + 32 hex', value: key('S', 'K', hex(32)) },
  { label: 'twilio AC + 32 hex', value: key('A', 'C', hex(32)) },
  { label: 'AIza + 31', value: key('AI', 'za', urlsafe(31)) },
  { label: 'public key header', value: ['-----BEGIN', 'PUBLIC KEY-----'].join(' ') },
  { label: 'pgp public key block', value: ['-----BEGIN', 'PGP PUBLIC KEY BLOCK-----'].join(' ') },
  { label: 'certificate header', value: ['-----BEGIN', 'CERTIFICATE-----'].join(' ') },
  { label: 'pgp signature header', value: ['-----BEGIN', 'PGP SIGNATURE-----'].join(' ') },
  // ` BLOCK` is optional once: a second one leaves no `-----` after it.
  {
    label: 'private key header with BLOCK twice',
    value: ['-----BEGIN', 'PGP PRIVATE KEY BLOCK BLOCK-----'].join(' '),
  },
  // Every prefix is case-sensitive.
  { label: 'SK_LIVE_ + 24', value: key('SK', '_LIVE_', alnum(24)) },
  { label: 'Sk_live_ + 24', value: key('Sk', '_live_', alnum(24)) },
  { label: 'GLPAT- + 20', value: key('GLP', 'AT-', urlsafe(20)) },
  { label: 'NPM_ + 36', value: key('NPM', '_', alnum(36)) },
  { label: 'HF_ + 34', value: key('HF', '_', letters(34)) },
  { label: 'aiza + 35', value: key('ai', 'za', urlsafe(35)) },
  { label: 'SK-ANT- + 95', value: key('SK-', 'ANT-api03-', urlsafe(95)) },
  { label: 'SK- + 48', value: key('SK', '-', alnum(48)) },
  { label: 'sg. 22 . 43', value: sendgrid(22, 43).replace(/^SG/, 'sg') },
  { label: 'EYJ jwt', value: jwt(20, 24, 43).replace(/eyJ/g, 'EYJ') },
  { label: 'XOXB-', value: slack('XOXB-', 24) },
  { label: 'WHSEC_ + 32', value: key('WH', 'SEC_', alnum(32)) },
  { label: 'DCKR_PAT_ + 27', value: key('DCKR', '_PAT_', urlsafe(27)) },
  { label: 'DOP_V1_ + 64', value: key('DOP', '_V1_', hex(64)) },
  { label: 'SHPAT_ + 32', value: key('SHP', 'AT_', hex(32)) },
  { label: 'PYPI- upper-case + 150', value: [PYPI.toUpperCase(), urlsafe(150)].join('') },
  // The DigitalOcean alphabet is lower-case hex only.
  { label: 'dop_v1_ + 64 upper-case hex', value: key('dop', '_v1_', hex(64).toUpperCase()) },
];

/**
 * A letter or digit immediately before a new pattern's prefix (board-cli
 * scenario "Prefix inside a word"): that pattern does not match, and no
 * other does either.
 */
export const PREFIX_INSIDE_A_WORD: readonly Accepted[] = NEW_PATTERN_KEYS.flatMap((k) => [
  { label: `x then ${k.label}`, value: `x${k.value}` },
  { label: `2 then ${k.label}`, value: `2${k.value}` },
]).concat([
  { label: 'de then sk_live_ + 24', value: `de${providerKey('stripe sk_live_ + 24').value}` },
  { label: 'a then rk_test_ + 99', value: `a${providerKey('stripe rk_test_ + 99').value}` },
  { label: '7 then sk- + 48', value: `7${providerKey('openai sk- + 48').value}` },
  { label: 'Q then AIza + 35', value: `Q${providerKey('google AIza + 35').value}` },
  {
    label: 'b then shpss_ + 32',
    value: `b${providerKey('shopify shpss_ + 32 upper-case hex').value}`,
  },
  { label: 'x then dckr_oat_ + 27', value: `x${providerKey('docker dckr_oat_ + 27').value}` },
  { label: '0 then xapp-1-', value: `0${providerKey('slack app-level xapp-1- + 90').value}` },
]);

/**
 * The keys of board-cli scenarios "Short key that fits the actor form" and
 * "Short prefixed key as the actor": each has the actor form
 * (`^[A-Za-z0-9][A-Za-z0-9._@-]{0,31}$`) and is refused by its pattern.
 */
export const RK_LIVE_16 = key('rk', '_live_', alnum(16));
/** `rk_live_` and 24 letters and digits (32 characters). */
export const RK_LIVE_24 = providerKey('stripe rk_live_ + 24').value;
/** `sk_test_` and 24 letters and digits (32 characters). */
export const SK_TEST_24 = providerKey('stripe sk_test_ + 24').value;
/** `glpat-` and 20 characters of `[A-Za-z0-9_-]` (26 characters). */
export const GLPAT_20 = providerKey('gitlab glpat- + 20').value;

/** `STRIPE_KEY=` and `sk_live_` with 24 letters and digits (scenario "Assigned key names both patterns"). */
export const ASSIGNED_STRIPE_KEY = [
  'STRIPE',
  '_KEY=',
  providerKey('stripe sk_live_ + 24').value,
].join('');
