/**
 * The write actions of `agentboard serve --as <actor>` racing real CLI
 * processes (board-web-actions: "Action endpoints": "run by the command's
 * own operation in its single `BEGIN IMMEDIATE` transaction";
 * board-concurrency: "Claim race has exactly one winner";
 * add-board-web-actions task 1.2 Verify: "ten concurrent claims (five
 * through the server, five by CLI child processes) giving exactly one
 * winner"). Runs the built CLI through the multi-process harness; run
 * `npm run build` first when running vitest directly.
 *
 * The server is itself a child process (`serve --as ben`), so the server's
 * writes and the CLI's come from six processes on one board. The five CLI
 * claims wait at the harness start gate; the five posts to the server are
 * sent the moment the gate opens.
 *
 * All five server claims are by the same actor `ben`, so "exactly one
 * winner" means exactly one claim event on the board: when `ben` wins, one
 * server response carries the event hash and the four others are 200 with
 * `hash` null (a claim by the current holder writes nothing) while the
 * five CLI claims exit 4 `already-assigned` naming `ben`; when an agent
 * wins, its process exits 0 and the four other processes exit 4, and the
 * five server claims are 409 `already-assigned` naming that agent.
 *
 * Every server listens on 127.0.0.1 with port 0.
 */

import { describe, expect, it } from 'vitest';

import { eventNames, foldDir } from '../store/__tests__/helpers.js';
import { until, type HttpResult } from '../web/__tests__/web-helpers.js';
import { post } from '../web/__tests__/action-helpers.js';
import {
  boardProject,
  oneDocument,
  runCliAsync,
  startCli,
  startGated,
  type CliProcess,
  type ProcessResult,
} from './harness/processes.js';

const TASK = ['--task', 'openspec:add-board-web-actions#1'];

/** Creates a ticket through the CLI and returns its id. */
async function newTicket(root: string): Promise<string> {
  const out = await runCliAsync(['new', 'Contested', ...TASK, '--as', 'orch', '--json'], root);
  expect(out.code, out.stderr).toBe(0);
  return (oneDocument(out) as { ticket: { id: string } }).ticket.id;
}

/** The parsed `--json` start-up line of a `serve` child. */
interface Startup {
  url: string;
  port: number;
  token: string;
  writable: boolean;
  actor: string | null;
}

async function startup(proc: CliProcess): Promise<Startup> {
  await until(
    () => proc.stdout().includes('\n'),
    15_000,
    `the start-up line (stderr: ${proc.stderr()})`,
  );
  return JSON.parse(proc.stdout().split('\n')[0] ?? '') as Startup;
}

interface ClaimDoc {
  hash: string | null;
  ticket: { id: string; assignee: string | null };
}

interface ErrorDoc {
  error: { exitCode: number; reason: string; message: string };
}

describe('scenario: ten concurrent claims, five through the server and five by CLI processes', () => {
  it('gives exactly one winner and one claim event', { timeout: 90_000 }, async () => {
    const { root, eventsDir } = boardProject();
    const id = await newTicket(root);
    const server = startCli({ argv: ['serve', '--port', '0', '--json', '--as', 'ben'] }, root);
    const line = await startup(server);
    expect(line).toMatchObject({ writable: true, actor: 'ben' });

    const agents = Array.from({ length: 5 }, (_, n) => `agent-${String(n)}`);
    const gated = await startGated(
      agents.map((actor) => ({ argv: ['claim', id, '--as', actor, '--json'] })),
      root,
    );
    expect(gated.readyAtGate).toBe(5);
    gated.open();
    const posts: Promise<HttpResult>[] = agents.map(() => post(line, 'claim', { id }));
    const [served, processes] = await Promise.all([
      Promise.all(posts),
      Promise.all(gated.procs.map((p) => p.exited)),
    ]);

    // Exactly one claim event: the create and one claim.
    expect(eventNames(eventsDir)).toHaveLength(2);
    const independent = foldDir(eventsDir);
    expect(independent.rejected).toEqual([]);
    const winner = independent.state.tickets[id]?.assignee ?? null;
    expect(winner === 'ben' || agents.includes(winner ?? '')).toBe(true);

    expect(processes.map((r: ProcessResult) => r.signal)).toEqual(agents.map(() => null));
    for (const result of served) {
      expect([200, 409], result.body).toContain(result.status);
    }
    if (winner === 'ben') {
      expect(served.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
      const docs = served.map((r) => JSON.parse(r.body) as ClaimDoc);
      expect(docs.filter((d) => d.hash !== null)).toHaveLength(1);
      for (const doc of docs) {
        expect(doc.ticket).toMatchObject({ id, assignee: 'ben' });
      }
      expect(processes.map((r) => r.code)).toEqual([4, 4, 4, 4, 4]);
    } else {
      expect(processes.filter((r) => r.code === 0)).toHaveLength(1);
      expect(processes.filter((r) => r.code === 4)).toHaveLength(4);
      const won = processes[agents.indexOf(winner ?? '')];
      expect(won?.code).toBe(0);
      expect(oneDocument(won as ProcessResult)).toMatchObject({
        ticket: { id, assignee: winner },
      });
      for (const result of served) {
        expect(result.status, result.body).toBe(409);
        const { error } = JSON.parse(result.body) as ErrorDoc;
        expect(error).toMatchObject({ exitCode: 4, reason: 'already-assigned' });
        expect(error.message).toContain(winner);
      }
    }
    for (const result of processes.filter((r) => r.code !== 0)) {
      const { error } = oneDocument(result) as ErrorDoc;
      expect(error).toMatchObject({ exitCode: 4, reason: 'already-assigned' });
      expect(error.message).toContain(winner);
    }

    // The board agrees with itself afterwards.
    const shown = await runCliAsync(['show', id, '--json'], root);
    expect((oneDocument(shown) as ClaimDoc).ticket.assignee).toBe(winner);
    const check = await runCliAsync(['rebuild', '--check', '--json'], root);
    expect(check.code, check.stderr).toBe(0);
    expect(oneDocument(check)).toMatchObject({ ok: true, differences: [] });

    process.kill(server.pid, 'SIGINT');
    const stopped = await server.exited;
    expect(stopped).toMatchObject({ code: 0, signal: null, stderr: '' });
  });
});
