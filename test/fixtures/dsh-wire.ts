import type { WebSocket } from 'ws';
import type { ServerResponse } from 'node:http';

/** Serialize wire envelopes only; each fixture keeps its own results and assertions. */
export function writeDshRpcSuccess(response: ServerResponse, rpcId: unknown, value: unknown): void {
  response.end(JSON.stringify({ type: 'server-response', rpcId, result: { ok: true, value } }));
}

export function writeDshStreamItem(socket: WebSocket, streamId: unknown, value: unknown): void {
  socket.send(JSON.stringify({ type: 'item', streamId, value }));
}

/** Handle the control stream independently of session-follow fixture behavior. */
export function handleDshControlFrame(socket: WebSocket, frame: unknown): boolean {
  if (frame === null || typeof frame !== 'object') return false;
  if ('type' in frame && frame.type === 'cancel') return true;
  if (!('endpoint' in frame) || frame.endpoint !== '$events') return false;
  if (!('type' in frame) || frame.type !== 'open' || !('streamId' in frame) || typeof frame.streamId !== 'string') {
    throw new Error('Fixture received an invalid DSH interaction stream open');
  }
  writeDshStreamItem(socket, frame.streamId, { type: 'ready', clientId: 'fixture-interaction-client' });
  return true;
}
