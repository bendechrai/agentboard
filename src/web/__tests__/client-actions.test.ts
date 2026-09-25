/**
 * Drift guard between the action names of the server
 * (`src/web/actions.ts`) and of the web client
 * (`src/web/client/actions.ts`, which cannot import the server module):
 * the page posts exactly the actions the server answers
 * (add-board-web-actions task 2.1).
 */

import { describe, expect, it } from 'vitest';

import { ACTION_NAMES } from '../actions.js';
import { ACTION_NAMES as CLIENT_ACTION_NAMES } from '../client/actions.js';

describe('client action names', () => {
  it('are the server action names, in the same order', () => {
    expect([...CLIENT_ACTION_NAMES]).toEqual([...ACTION_NAMES]);
  });
});
