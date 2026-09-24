/**
 * Mounting the app into the page (add-board-web task 4.2).
 */

import type { ClientDeps } from './api.js';

/** The id of the element of `index.html` the app renders into. */
export const ROOT_ID = 'app';

/**
 * Renders `<App deps={deps} />` into `root` with Preact's `render`,
 * replacing its content. With `root` null (no `#app` element) it does
 * nothing.
 */
export function mount(root: Element | null, deps?: Partial<ClientDeps>): void {
  void root;
  void deps;
  throw new Error('not implemented');
}
