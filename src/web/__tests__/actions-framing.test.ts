/**
 * The body framing of the write actions on raw sockets (board-web-actions:
 * "Cross-site request forgery protection", the 64 KiB limit and "A refused
 * request SHALL write nothing").
 *
 * - The streamed 64 KiB counter at its exact boundary, with a chunked body
 *   and no Content-Length (the declared-length precheck cannot mask it).
 * - The declared-length precheck answers 413 at once, before any body.
 * - The 1 MiB discard cap: a client that keeps sending a refused body is
 *   disconnected, after it could read the refusal.
 * - A write whose response cannot be delivered (malformed bytes pipelined
 *   behind it) is not executed.
 *
 * The bodies that are valid JSON but not one object are covered over HTTP
 * in actions-http.test.ts and through runAction in actions.test.ts.
 *
 * Every socket wait has an explicit timeout and waits for an event (a
 * complete response, a close), never for a fixed time.
 */

import { connect, type Socket } from 'node:net';

import { describe, expect, it } from 'vitest';

import { actionServer, eventFiles, newEvents, newTicket, post } from './action-helpers.js';
import { rawRequest, type RawResult } from './web-helpers.js';

/** The action body limit of the spec: 64 KiB. */
const LIMIT = 64 * 1024;

/** The discard cap of the server (`DISCARD_LIMIT` in src/web/server.ts): 1 MiB. */
const CAP = 1024 * 1024;

/** A JSON comment body for `id` of exactly `bytes` bytes. */
function sized(id: string, bytes: number): string {
  const empty = Buffer.byteLength(JSON.stringify({ id, text: '' }));
  const body = JSON.stringify({ id, text: 'z'.repeat(bytes - empty) });
  expect(Buffer.byteLength(body)).toBe(bytes);
  return body;
}

/** `data` in HTTP/1.1 chunked encoding, `piece` bytes per chunk, with the last chunk when `last`. */
function chunked(data: string | Buffer, piece: number, last = true): string {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  let out = '';
  for (let at = 0; at < bytes.length; at += piece) {
    const part = bytes.subarray(at, at + piece);
    out += `${part.length.toString(16)}\r\n${part.toString('latin1')}\r\n`;
  }
  return last ? `${out}0\r\n\r\n` : out;
}

/** The request head of an action the page would send, with `extra` header lines. */
function actionHead(port: number, token: string, extra: readonly string[]): string {
  return [
    'POST /api/actions/comment HTTP/1.1',
    `Host: 127.0.0.1:${String(port)}`,
    `Authorization: Bearer ${token}`,
    `Origin: http://127.0.0.1:${String(port)}`,
    ...extra,
    '',
    '',
  ].join('\r\n');
}

/** The reason of the `ErrorDocument` in a raw response body. */
function reasonOf(body: string): string {
  return (JSON.parse(body) as { error: { reason: string } }).error.reason;
}

/** A raw client socket that collects what the server sends. */
interface RawClient {
  readonly socket: Socket;
  /** Resolves with the first complete response (head and Content-Length body); rejects after `ms`. */
  response(ms: number): Promise<RawResult>;
  /** Resolves when the socket has closed (by either side, or a reset); rejects after `ms`. */
  closed(ms: number): Promise<void>;
}

/** Connects to 127.0.0.1:`port`. */
function rawClient(port: number): Promise<RawClient> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    let data = Buffer.alloc(0);
    let isClosed = false;
    const waiters = new Set<() => void>();
    const notify = (): void => {
      for (const waiter of [...waiters]) {
        waiter();
      }
    };
    socket.on('data', (chunk: Buffer) => {
      data = Buffer.concat([data, chunk]);
      notify();
    });
    // A reset or a broken pipe once the server disconnects is expected; 'close' follows.
    socket.on('error', () => undefined);
    socket.on('close', () => {
      isClosed = true;
      notify();
    });

    /** The first complete response in `data`, or null. */
    const parse = (): RawResult | null => {
      const end = data.indexOf('\r\n\r\n');
      if (end < 0) {
        return null;
      }
      const [statusLine = '', ...lines] = data.subarray(0, end).toString('latin1').split('\r\n');
      const headers: Record<string, string[]> = {};
      for (const line of lines) {
        const colon = line.indexOf(':');
        if (colon > 0) {
          const name = line.slice(0, colon).trim().toLowerCase();
          (headers[name] ??= []).push(line.slice(colon + 1).trim());
        }
      }
      const length = Number(headers['content-length']?.[0] ?? 0);
      if (data.length < end + 4 + length) {
        return null;
      }
      return {
        status: Number(statusLine.split(' ')[1] ?? 0),
        headers,
        body: data.subarray(end + 4, end + 4 + length).toString('utf8'),
      };
    };

    const wait = <T>(ms: number, what: string, ready: () => T | null): Promise<T> =>
      new Promise((resolveWait, rejectWait) => {
        const check = (): void => {
          const value = ready();
          if (value !== null) {
            cleanup();
            resolveWait(value);
          } else if (isClosed) {
            cleanup();
            rejectWait(new Error(`the socket closed before ${what}`));
          }
        };
        const timer = setTimeout(() => {
          cleanup();
          rejectWait(new Error(`timed out after ${String(ms)} ms waiting for ${what}`));
        }, ms);
        const cleanup = (): void => {
          clearTimeout(timer);
          waiters.delete(check);
        };
        waiters.add(check);
        check();
      });

    const client: RawClient = {
      socket,
      response: (ms) => wait(ms, 'a complete response', parse),
      closed: (ms) =>
        new Promise((resolveClosed, rejectClosed) => {
          if (isClosed) {
            resolveClosed();
            return;
          }
          const timer = setTimeout(() => {
            waiters.delete(check);
            rejectClosed(
              new Error(`timed out after ${String(ms)} ms waiting for the socket to close`),
            );
          }, ms);
          const check = (): void => {
            if (isClosed) {
              clearTimeout(timer);
              waiters.delete(check);
              resolveClosed();
            }
          };
          waiters.add(check);
        }),
    };
    socket.once('connect', () => {
      socket.off('error', reject);
      resolve(client);
    });
    socket.once('error', reject);
  });
}

/**
 * Writes `piece` repeatedly until `total` bytes are sent or the socket
 * closes, honouring backpressure; resolves with the bytes written. Never
 * ends or destroys the socket itself.
 */
function flood(socket: Socket, total: number, piece: Buffer | string): Promise<number> {
  const size = Buffer.byteLength(piece);
  return new Promise((resolve) => {
    let sent = 0;
    let done = false;
    const finish = (): void => {
      if (!done) {
        done = true;
        socket.off('drain', pump);
        socket.off('close', finish);
        resolve(sent);
      }
    };
    function pump(): void {
      while (sent < total && !socket.destroyed) {
        sent += size;
        if (!socket.write(piece)) {
          socket.once('drain', pump);
          return;
        }
      }
      finish();
    }
    socket.once('close', finish);
    pump();
  });
}

describe('the streamed 64 KiB counter (chunked, no Content-Length)', () => {
  it('accepts a chunked body of exactly 64 KiB and refuses 64 KiB + 1 with 413, writing nothing', async () => {
    const { server, root, eventsDir } = await actionServer({ actor: 'ben' });
    const id = newTicket(root);
    const send = (body: string): Promise<RawResult> =>
      rawRequest(
        server.port,
        actionHead(server.port, server.token, [
          'Content-Type: application/json',
          'Transfer-Encoding: chunked',
          'Connection: close',
        ]) + chunked(body, 16 * 1024),
        5000,
      );

    const before = eventFiles(eventsDir);
    const over = await send(sized(id, LIMIT + 1));
    expect(over.status, over.body.slice(0, 300)).toBe(413);
    expect(over.headers['content-length']).toBeDefined();
    expect(over.headers['transfer-encoding']).toBeUndefined();
    expect(reasonOf(over.body)).toBe('body-too-large');
    expect(eventFiles(eventsDir)).toEqual(before);

    const exact = await send(sized(id, LIMIT));
    expect(exact.status, exact.body.slice(0, 300)).toBe(200);
    const written = newEvents(eventsDir, before);
    expect(written).toHaveLength(1);
    expect(written[0]?.event.kind).toBe('ticket.comment');
    expect((written[0]?.event.body as { text: string }).text).toHaveLength(
      LIMIT - Buffer.byteLength(JSON.stringify({ id, text: '' })),
    );
  }, 15_000);

  it('refuses 64 KiB + 1 sent as a single chunk as well', async () => {
    const { server, root, eventsDir } = await actionServer({ actor: 'ben' });
    const id = newTicket(root);
    const before = eventFiles(eventsDir);
    const body = sized(id, LIMIT + 1);
    const result = await rawRequest(
      server.port,
      actionHead(server.port, server.token, [
        'Content-Type: application/json',
        'Transfer-Encoding: chunked',
        'Connection: close',
      ]) + chunked(body, LIMIT + 1),
      5000,
    );
    expect(result.status).toBe(413);
    expect(reasonOf(result.body)).toBe('body-too-large');
    expect(eventFiles(eventsDir)).toEqual(before);
  }, 15_000);
});

describe('the declared Content-Length precheck', () => {
  it('answers Content-Length: 70000 with 413 at once, before the client sends any body', async () => {
    const { server, root, eventsDir } = await actionServer({ actor: 'ben' });
    newTicket(root);
    const before = eventFiles(eventsDir);
    const client = await rawClient(server.port);
    try {
      client.socket.write(
        actionHead(server.port, server.token, [
          'Content-Type: application/json',
          'Content-Length: 70000',
        ]),
      );
      // No body is ever sent: only the precheck can answer.
      const result = await client.response(3000);
      expect(result.status).toBe(413);
      expect(reasonOf(result.body)).toBe('body-too-large');
      expect(eventFiles(eventsDir)).toEqual(before);
    } finally {
      client.socket.destroy();
    }
  }, 10_000);
});

describe('the 1 MiB discard cap of a refused body', () => {
  /** Keeps sending after the refusal was read, and expects the server to disconnect. */
  async function expectCut(
    client: RawClient,
    piece: Buffer | string,
    total: number,
  ): Promise<void> {
    await flood(client.socket, total, piece);
    // `total` is short of the declared body (or the chunked body never ends),
    // so only the cap can make the server hang up.
    await client.closed(5000);
  }

  it('disconnects a client that keeps sending past 1 MiB after a declared-length 413', async () => {
    const { server, root, eventsDir } = await actionServer({ actor: 'ben' });
    newTicket(root);
    const before = eventFiles(eventsDir);
    const client = await rawClient(server.port);
    try {
      client.socket.write(
        actionHead(server.port, server.token, [
          'Content-Type: application/json',
          `Content-Length: ${String(8 * CAP)}`,
        ]),
      );
      const result = await client.response(3000);
      expect(result.status).toBe(413);
      expect(reasonOf(result.body)).toBe('body-too-large');
      // 3 MiB of the declared 8 MiB: without the cap the server would wait for the rest.
      await expectCut(client, Buffer.alloc(64 * 1024, 'a'), 3 * CAP);
      expect(eventFiles(eventsDir)).toEqual(before);
    } finally {
      client.socket.destroy();
    }
  }, 20_000);

  it('disconnects a client that keeps sending chunks past 1 MiB after a streamed 413', async () => {
    const { server, root, eventsDir } = await actionServer({ actor: 'ben' });
    const id = newTicket(root);
    const before = eventFiles(eventsDir);
    const client = await rawClient(server.port);
    try {
      client.socket.write(
        actionHead(server.port, server.token, [
          'Content-Type: application/json',
          'Transfer-Encoding: chunked',
        ]) + chunked(sized(id, LIMIT + 1), 16 * 1024, false),
      );
      const result = await client.response(3000);
      expect(result.status).toBe(413);
      expect(reasonOf(result.body)).toBe('body-too-large');
      // The chunked body never ends: without the cap the server would read it forever.
      await expectCut(client, chunked(Buffer.alloc(64 * 1024, 'b'), 64 * 1024, false), 3 * CAP);
      expect(eventFiles(eventsDir)).toEqual(before);
    } finally {
      client.socket.destroy();
    }
  }, 20_000);

  it('disconnects a client that keeps sending past 1 MiB after a CSRF 403 with a large declared body', async () => {
    const { server, root, eventsDir } = await actionServer({ actor: 'ben' });
    newTicket(root);
    const before = eventFiles(eventsDir);
    const client = await rawClient(server.port);
    try {
      client.socket.write(
        actionHead(server.port, server.token, [
          'Content-Type: text/plain',
          `Content-Length: ${String(8 * CAP)}`,
        ]),
      );
      const result = await client.response(3000);
      expect(result.status).toBe(403);
      expect(reasonOf(result.body)).toBe('csrf-failed');
      await expectCut(client, Buffer.alloc(64 * 1024, 'c'), 3 * CAP);
      expect(eventFiles(eventsDir)).toEqual(before);
    } finally {
      client.socket.destroy();
    }
  }, 20_000);
});

describe('a write whose response cannot be delivered is not executed', () => {
  it('writes nothing for a valid comment followed in the same packet by malformed bytes', async () => {
    const { server, root, eventsDir } = await actionServer({ actor: 'ben' });
    const id = newTicket(root);
    const before = eventFiles(eventsDir);
    const body = JSON.stringify({ id, text: 'pipelined before garbage' });
    const raw = await rawRequest(
      server.port,
      actionHead(server.port, server.token, [
        'Content-Type: application/json',
        `Content-Length: ${String(Buffer.byteLength(body))}`,
      ]) +
        body +
        '\x00BAD\r\n\r\n',
      5000,
    );
    // The client learns only of the malformed request, so the comment must not be written.
    expect(raw.status).toBe(400);
    expect(raw.body).not.toContain('"hash"');

    // A later request completes a round trip through the server, so the
    // first request's body handler has had every chance to run.
    const after = await post(server, 'comment', { id, text: 'after the garbage' });
    expect(after.status, after.body).toBe(200);
    const written = newEvents(eventsDir, before);
    expect(written.map((e) => (e.event.body as { text: string }).text)).toEqual([
      'after the garbage',
    ]);
  }, 15_000);
});
