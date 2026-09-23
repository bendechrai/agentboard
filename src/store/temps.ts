/**
 * Finding stale temporary files, shared by `reapStaleTemps` (which removes
 * them under the write lock) and catch-up's lock-free pre-check (which only
 * needs to know whether there are any). Internal: not re-exported from
 * `src/index.ts`.
 */

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Absolute paths, sorted, of the regular files in `eventsDir` whose name
 * starts with `prefix` and whose mtime is strictly older than `cutoff` (ms
 * since the epoch). A file that vanishes between the listing and its stat
 * (its writer renamed it, or another command reaped it) is skipped.
 */
export function staleTemps(eventsDir: string, prefix: string, cutoff: number): string[] {
  const stale: string[] = [];
  for (const entry of readdirSync(eventsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.startsWith(prefix)) {
      continue;
    }
    const path = join(eventsDir, entry.name);
    const stats = statSync(path, { throwIfNoEntry: false });
    if (stats !== undefined && stats.mtimeMs < cutoff) {
      stale.push(path);
    }
  }
  return stale.sort();
}
