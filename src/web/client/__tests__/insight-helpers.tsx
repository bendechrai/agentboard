/**
 * Test doubles for the insight views: a fake clock whose timers fire by
 * advancing time (the views' play and animation timers go through `ClientDeps`,
 * so these are the fake timers of the component tests), client dependencies
 * wired to it and to a `FakeApi` (with an optional hook for single requests),
 * health bodies for `/api/health` and `/api/health/check`, and small DOM
 * helpers.
 */

import { act, render, type RenderResult } from '@testing-library/preact';

import type { HealthCheck, LateArrival } from '../../../view/health.js';
import type { ClientDeps } from '../api.js';
import { App } from '../App.js';
import { TOKEN, type FakeApi } from './client-helpers.js';

interface Timer {
  id: number;
  callback: () => void;
  due: number;
  /** The period of an interval, or null for a timeout. */
  every: number | null;
}

/**
 * A manual clock: `now` moves only through `advance`, which fires every
 * timeout and interval falling due, in time order (ties in the order
 * scheduled), with `now` set to each one's due time as it fires.
 */
export class TimedClock {
  now: number;
  #next = 0;
  readonly #timers = new Map<number, Timer>();
  /** Every delay or period ever scheduled, in order (for assertions). */
  readonly scheduled: { kind: 'timeout' | 'interval'; ms: number }[] = [];

  constructor(now: number) {
    this.now = now;
  }

  /** Timers neither cleared nor (for timeouts) fired. */
  pending(): number {
    return this.#timers.size;
  }

  /** Moves time forward by `ms`, firing what falls due. */
  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      let first: Timer | null = null;
      for (const timer of this.#timers.values()) {
        if (timer.due <= end && (first === null || timer.due < first.due)) {
          first = timer;
        }
      }
      if (first === null) {
        break;
      }
      this.now = first.due;
      if (first.every === null) {
        this.#timers.delete(first.id);
      } else {
        first.due += first.every;
      }
      first.callback();
    }
    this.now = end;
  }

  #add(callback: () => void, ms: number, every: number | null): number {
    this.#next += 1;
    const id = this.#next;
    this.#timers.set(id, {
      id,
      callback,
      due: this.now + Math.max(ms, every === null ? 0 : 1),
      every,
    });
    this.scheduled.push({ kind: every === null ? 'timeout' : 'interval', ms });
    return id;
  }

  /** Client dependencies on this clock and `api` (whose `fetch` may be wrapped by `fetch`). */
  deps(api: FakeApi, fetch?: ClientDeps['fetch']): ClientDeps {
    return {
      fetch: fetch ?? api.fetch,
      now: () => this.now,
      setInterval: (callback, ms) => this.#add(callback, ms, Math.max(ms, 1)),
      clearInterval: (handle) => {
        this.#timers.delete(handle as number);
      },
      setTimeout: (callback, ms) => this.#add(callback, ms, null),
      clearTimeout: (handle) => {
        this.#timers.delete(handle as number);
      },
    };
  }
}

/** Advances `clock` by `ms` inside `act`, so the views re-render. */
export async function advance(clock: TimedClock, ms: number): Promise<void> {
  await act(() => {
    clock.advance(ms);
  });
}

/** Renders the app with `TOKEN` on `clock` and `api`. */
export function renderTimed(
  api: FakeApi,
  clock: TimedClock,
  fetch?: ClientDeps['fetch'],
): RenderResult {
  return render(<App token={TOKEN} deps={clock.deps(api, fetch)} />);
}

/** Makes `api` answer `/api/health` with `late` and `check`. */
export function serveHealth(
  api: FakeApi,
  late: LateArrival[] = [],
  check: HealthCheck | null = null,
): void {
  api.failures.set('/api/health', { status: 200, body: { late, check } });
}

/** Makes `api` answer `/api/health/check` with `check`. */
export function serveCheck(api: FakeApi, check: HealthCheck): void {
  api.failures.set('/api/health/check', { status: 200, body: check });
}

/** The element matching `selector` under `root`; fails the test when missing. */
export function one(root: ParentNode, selector: string): Element {
  const el = root.querySelector(selector);
  if (el === null) {
    throw new Error(`no element matches ${selector}`);
  }
  return el;
}

/** The `input` or `select` with id `id`. */
export function field(id: string): HTMLInputElement {
  return one(document, `#${id}`) as HTMLInputElement;
}

/** The button whose trimmed text is exactly `text`; fails the test when missing. */
export function button(text: string, root: ParentNode = document): HTMLButtonElement {
  const found = [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  if (found === undefined) {
    throw new Error(`no button ${text}`);
  }
  return found;
}

/** Every element under `root` carrying a `style` attribute. */
export function styled(root: ParentNode): Element[] {
  return [...root.querySelectorAll('[style]')];
}
