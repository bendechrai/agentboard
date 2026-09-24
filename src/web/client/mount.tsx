/**
 * Mounting the app into the page (add-board-web task 4.2).
 */

import type { ClientDeps } from './api.js';
import type { TokenEnv } from './token.js';

/** The id of the element of `index.html` the app renders into. */
export const ROOT_ID = 'app';

/**
 * Takes the token (`takeToken(tokenEnv)`, which also removes a `#token=`
 * fragment from the address bar) and renders `<App token={token}
 * deps={deps} />` into `root` with Preact's `render`, replacing its
 * content. With `root` null (no `#app` element) it does nothing, not even
 * take the token. `tokenEnv` defaults to `browserTokenEnv()`.
 */
export function mount(root: Element | null, deps?: Partial<ClientDeps>, tokenEnv?: TokenEnv): void {
  void root;
  void deps;
  void tokenEnv;
  throw new Error('not implemented');
}
