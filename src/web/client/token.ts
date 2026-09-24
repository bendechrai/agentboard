/**
 * The access token in the browser (board-web: "Access token"; add-board-web
 * task 4.2). `agentboard serve` prints `http://127.0.0.1:<port>/#token=<token>`:
 * the token travels in the URL fragment, which the browser never sends to
 * the server. On load the client takes it from the fragment, keeps it in
 * `sessionStorage` (so a reload of the tab keeps working, and closing the
 * tab forgets it), removes it from the address bar, and sends it as
 * `Authorization: Bearer <token>` on every API request. No cookie is used.
 *
 * Decisions recorded here (test author, add-board-web group 4):
 * - The token fragment is exactly `#token=<value>` (the whole fragment);
 *   any other fragment (a view route such as `#/feed`, or none) leaves the
 *   address bar alone and the stored token is used.
 * - A token is valid when it is 43 base64url characters (`TOKEN_PATTERN`,
 *   32 random bytes as the server draws them). A fragment token that is not
 *   valid is removed from the address bar and not used, and the result is
 *   null (the app then shows how to open the board).
 * - board-web "Access token": a page with no token, or whose token is
 *   refused with 401, discards any stored token. So whenever `takeToken`
 *   returns null it has removed `TOKEN_KEY`, and the app calls
 *   `discardToken` on a 401 from the API or the stream.
 * - `sessionStorage` may be unavailable (its accessor or methods throw);
 *   that is treated as empty storage that keeps nothing.
 */

/** The `sessionStorage` key holding the token. */
export const TOKEN_KEY = 'agentboard-token';

/** A valid token: 43 base64url characters. */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** What `takeToken` reads and writes: the parts of `window` it needs. */
export interface TokenEnv {
  readonly location: { readonly hash: string; readonly pathname: string; readonly search: string };
  /** Returns the storage, or throws when it is unavailable. */
  readonly storage: () => Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  readonly history: Pick<History, 'replaceState'>;
}

/** `window.location`, `window.sessionStorage` and `window.history`, read when called. */
export function browserTokenEnv(): TokenEnv {
  return {
    location: window.location,
    storage: () => window.sessionStorage,
    history: window.history,
  };
}

/** Runs `action` on the storage, ignoring a storage failure; null on failure. */
function withStorage<T>(
  env: TokenEnv,
  action: (storage: ReturnType<TokenEnv['storage']>) => T,
): T | null {
  try {
    return action(env.storage());
  } catch {
    return null;
  }
}

/** The prefix of a token fragment. */
const FRAGMENT_PREFIX = '#token=';

/**
 * The token to use, or null when there is none:
 * - when the fragment is `#token=<value>`: first
 *   `history.replaceState(null, '', pathname + search)`, removing the
 *   fragment from the address bar; then, when `<value>` matches
 *   `TOKEN_PATTERN`, stores it under `TOKEN_KEY` and returns it, else
 *   removes `TOKEN_KEY` and returns null;
 * - otherwise the stored value under `TOKEN_KEY` when it matches
 *   `TOKEN_PATTERN`; else removes `TOKEN_KEY` and returns null.
 * Storage failures are ignored.
 */
export function takeToken(env: TokenEnv): string | null {
  const { hash, pathname, search } = env.location;
  if (hash.startsWith(FRAGMENT_PREFIX)) {
    env.history.replaceState(null, '', pathname + search);
    const value = hash.slice(FRAGMENT_PREFIX.length);
    if (TOKEN_PATTERN.test(value)) {
      withStorage(env, (storage) => {
        storage.setItem(TOKEN_KEY, value);
      });
      return value;
    }
    discardToken(env);
    return null;
  }
  const stored = withStorage(env, (storage) => storage.getItem(TOKEN_KEY));
  if (stored !== null && TOKEN_PATTERN.test(stored)) {
    return stored;
  }
  discardToken(env);
  return null;
}

/** Removes `TOKEN_KEY` from the storage, ignoring a storage failure. */
export function discardToken(env: TokenEnv): void {
  withStorage(env, (storage) => {
    storage.removeItem(TOKEN_KEY);
  });
}
