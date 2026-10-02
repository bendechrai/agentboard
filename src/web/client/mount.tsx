/**
 * Mounting the app into the page.
 */

import { render } from 'preact';

import type { ClientDeps } from './api.js';
import { App } from './App.js';
import { browserTokenEnv, discardToken, takeToken, type TokenEnv } from './token.js';

/** The id of the element of `index.html` the app renders into. */
export const ROOT_ID = 'app';

/**
 * Takes the token (`takeToken(tokenEnv)`, which also removes a `#token=`
 * fragment from the address bar, and discards a stored token when there is
 * no usable one) and renders `<App token={token} deps={deps}
 * onUnauthorized={() => discardToken(tokenEnv)} />` into `root` with
 * Preact's `render`, replacing its
 * content. With `root` null (no `#app` element) it does nothing, not even
 * take the token. `tokenEnv` defaults to `browserTokenEnv()`.
 */
export function mount(root: Element | null, deps?: Partial<ClientDeps>, tokenEnv?: TokenEnv): void {
  if (root === null) {
    return;
  }
  const env = tokenEnv ?? browserTokenEnv();
  const token = takeToken(env);
  const onUnauthorized = (): void => {
    discardToken(env);
  };
  render(
    deps === undefined ? (
      <App token={token} onUnauthorized={onUnauthorized} />
    ) : (
      <App token={token} onUnauthorized={onUnauthorized} deps={deps} />
    ),
    root,
  );
}
