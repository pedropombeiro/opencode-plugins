import type { EventSessionStatus } from '@opencode-ai/sdk';
import {
  type PermissionAskedEvent,
  type PermissionRepliedEvent,
  type QuestionAskedEvent,
  type QuestionRepliedEvent,
  type WaitingDetail,
  questionDetail,
  readRequestId,
} from './events.ts';

export type AgentState = 'busy' | 'idle' | 'waiting' | 'error';

interface ToolInput {
  tool: string;
  sessionID: string;
  callID: string;
}

interface ToolBeforeOutput {
  args: unknown;
}

interface EventInput {
  event: { type?: string; properties?: Record<string, unknown> };
}

interface AgentStateOptions {
  onWaiting?: (sessionID: string, detail: WaitingDetail) => Promise<void> | void;
  onWaitingIdResolved?: (
    sessionID: string,
    requestID: string,
    detail: WaitingDetail,
  ) => Promise<void> | void;
  onBusy?: (sessionID: string) => Promise<void> | void;
  onIdle?: (sessionID: string) => Promise<void> | void;
  onError?: (sessionID: string) => Promise<void> | void;
  onPermissionReplied?: (sessionID: string, requestID: string) => Promise<void> | void;
  onQuestionResolved?: (sessionID: string, requestID: string) => Promise<void> | void;
  emitRepeatedBusy?: boolean;
  handleToolQuestions?: boolean;
}

export function createAgentStateTracker(options: AgentStateOptions) {
  const states = new Map<string, AgentState>();
  const waits = new Map<string, string>();

  async function setState(sessionID: string, state: AgentState): Promise<void> {
    if (state === 'busy' && hasWait(sessionID)) return;
    if (states.get(sessionID) === state) {
      if (state === 'busy' && options.emitRepeatedBusy) await options.onBusy?.(sessionID);
      return;
    }
    states.set(sessionID, state);
    if (state === 'waiting') return;
    if (state === 'busy') await options.onBusy?.(sessionID);
    if (state === 'idle') await options.onIdle?.(sessionID);
    if (state === 'error') await options.onError?.(sessionID);
  }

  function isActive(sessionID: string): boolean {
    return states.has(sessionID);
  }

  function hasWait(sessionID: string): boolean {
    return [...waits.values()].some((waitingSessionID) => waitingSessionID === sessionID);
  }

  async function wait(sessionID: string, id: string, detail: WaitingDetail): Promise<void> {
    if (waits.has(id)) return;
    waits.set(id, sessionID);
    states.set(sessionID, 'waiting');
    await options.onWaiting?.(sessionID, detail);
  }

  async function resume(sessionID: string, id: string): Promise<void> {
    if (waits.get(id) !== sessionID) return;
    waits.delete(id);
    if (!hasWait(sessionID) && isActive(sessionID)) await setState(sessionID, 'busy');
  }

  function replaceWait(sessionID: string, oldId: string, newId: string): boolean {
    if (waits.get(oldId) !== sessionID || waits.has(newId)) return false;
    waits.delete(oldId);
    waits.set(newId, sessionID);
    return true;
  }

  async function event(input: EventInput): Promise<void> {
    const { event } = input;
    if (event.type === 'session.status') {
      const { sessionID, status } = (event as EventSessionStatus).properties;
      if (status.type === 'busy') await setState(sessionID, 'busy');
      if (status.type === 'idle') {
        waits.forEach((waitingSessionID, id) => {
          if (waitingSessionID === sessionID) waits.delete(id);
        });
        if (isActive(sessionID)) await setState(sessionID, 'idle');
        states.delete(sessionID);
      }
      return;
    }

    if (event.type === 'session.idle' || event.type === 'session.error') {
      const sessionID = event.properties?.['sessionID'];
      if (typeof sessionID !== 'string' || !isActive(sessionID)) return;
      waits.forEach((waitingSessionID, id) => {
        if (waitingSessionID === sessionID) waits.delete(id);
      });
      await setState(sessionID, event.type === 'session.idle' ? 'idle' : 'error');
      states.delete(sessionID);
      return;
    }

    if (event.type === 'permission.asked') {
      const props = (event as PermissionAskedEvent).properties;
      await wait(props.sessionID, props.id, {
        reason: 'permission',
        id: props.id,
        type: props.permission,
        title: props.patterns?.[0] ? `${props.permission}: ${props.patterns[0]}` : props.permission,
        pattern: props.patterns,
      });
      return;
    }

    if (event.type === 'question.asked') {
      const props = (event as QuestionAskedEvent).properties;
      const detail: WaitingDetail = {
        reason: 'question',
        id: props.id,
        title: props.questions?.[0]?.header,
        questions: props.questions,
      };
      if (props.tool && replaceWait(props.sessionID, `tool:${props.tool.callID}`, props.id)) {
        await options.onWaitingIdResolved?.(props.sessionID, props.id, detail);
        return;
      }
      await wait(props.sessionID, props.id, detail);
      return;
    }

    if (event.type === 'permission.replied') {
      const props = (event as PermissionRepliedEvent).properties;
      const id = readRequestId(props as Record<string, unknown>);
      if (id && waits.get(id) === props.sessionID) {
        await options.onPermissionReplied?.(props.sessionID, id);
        await resume(props.sessionID, id);
      }
      return;
    }

    if (event.type === 'question.replied' || event.type === 'question.rejected') {
      const props = (event as QuestionRepliedEvent).properties;
      if (waits.get(props.requestID) === props.sessionID) {
        await options.onQuestionResolved?.(props.sessionID, props.requestID);
      }
      await resume(props.sessionID, props.requestID);
    }
  }

  async function toolExecuteBefore(input: ToolInput, output: ToolBeforeOutput): Promise<void> {
    if (options.handleToolQuestions !== false && input.tool === 'question') {
      await wait(input.sessionID, `tool:${input.callID}`, questionDetail(output.args));
    }
  }

  async function toolExecuteAfter(input: ToolInput): Promise<void> {
    if (options.handleToolQuestions !== false && input.tool === 'question') {
      await resume(input.sessionID, `tool:${input.callID}`);
    }
  }

  return { event, toolExecuteBefore, toolExecuteAfter };
}
