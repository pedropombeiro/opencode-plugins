import type { OpenCodeEvent } from './opencode.ts';
import { formDetail, permissionDetail, type WaitingDetail } from './waiting.ts';

export type AgentState = 'busy' | 'idle' | 'waiting' | 'error';

type Callback<Args extends unknown[]> = (...args: Args) => Promise<void> | void;

export interface AgentStateOptions {
  onWaiting?: Callback<[sessionID: string, detail: WaitingDetail]>;
  onResolved?: Callback<[sessionID: string, requestID: string]>;
  onBusy?: Callback<[sessionID: string]>;
  onIdle?: Callback<[sessionID: string]>;
  onError?: Callback<[sessionID: string]>;
  emitRepeatedBusy?: boolean;
}

export function createAgentStateTracker(options: AgentStateOptions) {
  const states = new Map<string, AgentState>();
  const waits = new Map<string, string>();

  function isActive(sessionID: string): boolean {
    return states.has(sessionID);
  }

  function hasWait(sessionID: string): boolean {
    return [...waits.values()].some((waitingSessionID) => waitingSessionID === sessionID);
  }

  function clearWaits(sessionID: string): void {
    waits.forEach((waitingSessionID, id) => {
      if (waitingSessionID === sessionID) waits.delete(id);
    });
  }

  async function setState(sessionID: string, state: AgentState): Promise<void> {
    if (state === 'busy' && hasWait(sessionID)) return;
    if (states.get(sessionID) === state) {
      if (state === 'busy' && options.emitRepeatedBusy) await options.onBusy?.(sessionID);
      return;
    }
    states.set(sessionID, state);
    if (state === 'busy') await options.onBusy?.(sessionID);
    if (state === 'idle') await options.onIdle?.(sessionID);
    if (state === 'error') await options.onError?.(sessionID);
  }

  async function finish(sessionID: string, state: 'idle' | 'error'): Promise<void> {
    clearWaits(sessionID);
    if (isActive(sessionID)) await setState(sessionID, state);
    states.delete(sessionID);
  }

  async function wait(sessionID: string, id: string, detail: WaitingDetail): Promise<void> {
    if (waits.has(id)) return;
    waits.set(id, sessionID);
    states.set(sessionID, 'waiting');
    await options.onWaiting?.(sessionID, detail);
  }

  async function resolve(sessionID: string, id: string): Promise<void> {
    if (waits.get(id) !== sessionID) return;
    await options.onResolved?.(sessionID, id);
    waits.delete(id);
    if (!hasWait(sessionID) && isActive(sessionID)) await setState(sessionID, 'busy');
  }

  async function handle(event: OpenCodeEvent): Promise<void> {
    switch (event.type) {
      case 'session.status': {
        const { sessionID, status } = event.data;
        if (status.type === 'busy') await setState(sessionID, 'busy');
        if (status.type === 'idle') await finish(sessionID, 'idle');
        return;
      }
      case 'session.execution.started':
        await setState(event.data.sessionID, 'busy');
        return;
      case 'session.step.started':
        if (options.emitRepeatedBusy && states.get(event.data.sessionID) === 'busy') {
          await options.onBusy?.(event.data.sessionID);
        }
        return;
      case 'session.idle':
      case 'session.execution.succeeded':
      case 'session.execution.interrupted':
        if (isActive(event.data.sessionID)) await finish(event.data.sessionID, 'idle');
        return;
      case 'session.execution.failed':
        if (isActive(event.data.sessionID)) await finish(event.data.sessionID, 'error');
        return;
      case 'permission.asked':
        await wait(event.data.sessionID, event.data.id, permissionDetail(event.data));
        return;
      case 'form.created':
        await wait(event.data.form.sessionID, event.data.form.id, formDetail(event.data.form));
        return;
      case 'permission.replied':
        await resolve(event.data.sessionID, event.data.requestID);
        return;
      case 'form.replied':
      case 'form.cancelled':
        await resolve(event.data.sessionID, event.data.id);
        return;
    }
  }

  function tracks(sessionID: string): boolean {
    return isActive(sessionID) || hasWait(sessionID);
  }

  return { handle, hasWait, tracks };
}
