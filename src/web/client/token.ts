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
 *   valid is removed from the address bar but neither stored nor used, and
 *   the result is null (the app then shows how to open the board). A
 *   stored value that is not valid is ignored.
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
  readonly storage: () => Pick<Storage, 'getItem' | 'setItem'>;
  readonly history: Pick<History, 'replaceState'>;
}

/** `window.location`, `window.sessionStorage` and `window.history`, read when called. */
export function browserTokenEnv(): TokenEnv {
  throw new Error('not implemented');
}

/**
 * The token to use, or null when there is none:
 * - when the fragment is `#token=<value>`: first
 *   `history.replaceState(null, '', pathname + search)`, removing the
 *   fragment from the address bar; then, when `<value>` matches
 *   `TOKEN_PATTERN`, stores it under `TOKEN_KEY` (ignoring a storage
 *   failure) and returns it, else returns null;
 * - otherwise the stored value under `TOKEN_KEY` when it matches
 *   `TOKEN_PATTERN`, else null.
 */
export function takeToken(env: TokenEnv): string | null {
  void env;
  throw new Error('not implemented');
}
