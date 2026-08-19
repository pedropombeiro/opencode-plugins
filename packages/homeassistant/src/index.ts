import { existsSync, readFileSync } from 'fs';
import { basename } from 'path';
import { homedir, hostname } from 'os';
import { join } from 'path';
import type { Plugin } from '@opencode-ai/plugin';
import { createAgentStateTracker, type WaitingDetail } from '../../_shared/src/index.ts';

type AgentState = 'busy' | 'idle' | 'waiting' | 'error';
type WebhookUrlEntry = string | string[];

interface Config {
  webhookUrl?: string;
  webhookUrls?: Partial<Record<AgentState | 'default', WebhookUrlEntry>>;
  haApiUrl?: string;
  haToken?: string;
  permissionResponseEntity?: string;
  permissionTimeout?: number;
}

interface WebhookPayload {
  state: string;
  hostname: string;
  project: string;
  sessionId?: string;
  durationMs?: number;
  waiting?: WaitingDetail;
}

interface HaEntityState {
  state: string;
  attributes: Record<string, unknown>;
}

type PollResult =
  | { kind: 'permission'; response: 'allow' | 'deny' }
  | { kind: 'question'; optionIndex: number }
  | { kind: 'invalid' };

type PollOutcome = PollResult | { kind: 'no-config' } | { kind: 'canceled' } | { kind: 'timeout' };

interface RawPostClient {
  _client?: {
    post?: (options: { url: string; path?: Record<string, unknown>; body?: unknown }) => unknown;
  };
}

const DEFAULT_PERMISSION_TIMEOUT = 120;
const DEFAULT_RESPONSE_ENTITY = 'input_text.opencode_permission_response';
const POLL_INTERVAL_MS = 2000;
const STALE_SESSION_TIMEOUT_MS = 10 * 60 * 1000;
const STALE_SESSION_SWEEP_INTERVAL_MS = 60 * 1000;
const WEBHOOK_DRAIN_TIMEOUT_MS = 3000;

function loadConfig(): Config {
  const configPath =
    process.env['OPENCODE_HA_CONFIG_PATH'] ??
    join(homedir(), '.config', 'opencode', 'opencode-homeassistant.json');

  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, 'utf-8');
      return JSON.parse(raw) as Config;
    } catch {
      return {};
    }
  }

  return {};
}

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)}/g, (_match, name: string) => process.env[name] ?? '');
}

function resolveWebhookUrls(config: Config, state: AgentState): string[] {
  const entry = config.webhookUrls?.[state] ?? config.webhookUrls?.default;
  if (entry) return (Array.isArray(entry) ? entry : [entry]).filter(Boolean);
  if (config.webhookUrl) return [config.webhookUrl];
  return [];
}

function sendWebhook(urls: string[], payload: WebhookPayload): Promise<void> {
  return Promise.all(
    urls.map((url) =>
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(2000),
      }).catch(() => {}),
    ),
  ).then(() => {});
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeForeignState(state: string): string {
  const segments = state.split(':');
  if (segments[0] === 'question') return `kind=question, requestID=${segments[1] ?? '(empty)'}`;
  return `kind=permission, id=${segments[0] ?? '(empty)'}`;
}

function parseResponse(state: string, requestId: string): PollResult | undefined {
  const segments = state.split(':');

  if (segments[0] === 'question') {
    if (segments.length !== 3 || segments[1] !== requestId) return undefined;
    const optionIndex = Number(segments[2]);
    if (!Number.isInteger(optionIndex) || optionIndex < 0) return { kind: 'invalid' };
    return { kind: 'question', optionIndex };
  }

  if (segments.length !== 2 || segments[0] !== requestId) return undefined;
  const response = segments[1];
  if (response === 'allow' || response === 'always')
    return { kind: 'permission', response: 'allow' };
  if (response === 'deny') return { kind: 'permission', response: 'deny' };
  return undefined;
}

async function fetchHaEntity(
  apiUrl: string,
  token: string,
  entityId: string,
): Promise<{ entity: HaEntityState } | { failure: string }> {
  try {
    const resp = await fetch(`${apiUrl}/states/${entityId}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return { failure: describeHaHttpFailure(resp.status, entityId) };
    return { entity: (await resp.json()) as HaEntityState };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { failure: `request to ${apiUrl} failed (${detail})` };
  }
}

function describeHaHttpFailure(status: number, entityId: string): string {
  if (status === 401 || status === 403) {
    return `HTTP ${status}, the long-lived token was rejected by Home Assistant`;
  }
  if (status === 404) {
    return `HTTP 404, entity ${entityId} does not exist (create the input_text helper in Home Assistant)`;
  }
  return `HTTP ${status}`;
}

async function setHaEntity(
  apiUrl: string,
  token: string,
  entityId: string,
  state: string,
): Promise<string | undefined> {
  try {
    const resp = await fetch(`${apiUrl}/states/${entityId}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ state }),
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return describeHaHttpFailure(resp.status, entityId);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export const HomeAssistantPlugin: Plugin = async ({ client, directory }) => {
  let config = loadConfig();
  const project = basename(directory);
  const host = hostname();
  const sessionStartTimes = new Map<string, number>();
  const repliedPermissions = new Set<string>();
  const activePermissionPolls = new Set<string>();
  const inflightWebhooks = new Map<string, Promise<void>>();

  function elapsedSince(sessionId?: string): number | undefined {
    if (!sessionId) return undefined;
    const start = sessionStartTimes.get(sessionId);
    return start !== undefined ? Date.now() - start : undefined;
  }

  function send(
    state: AgentState,
    sessionId?: string,
    extra?: { durationMs?: number; waiting?: WaitingDetail },
  ): Promise<void> {
    const urls = resolveWebhookUrls(config, state);
    if (urls.length === 0) return Promise.resolve();
    const payload: WebhookPayload = { state, hostname: host, project, sessionId };
    if (extra?.durationMs !== undefined) payload.durationMs = extra.durationMs;
    if (extra?.waiting) payload.waiting = extra.waiting;

    const key = sessionId ?? '';
    const previous = inflightWebhooks.get(key) ?? Promise.resolve();
    const promise = previous
      .then(() => sendWebhook(urls, payload))
      .finally(() => {
        if (inflightWebhooks.get(key) === promise) inflightWebhooks.delete(key);
      });
    inflightWebhooks.set(key, promise);
    return promise;
  }

  function sweepStaleSessions(now: number): void {
    for (const [sessionId, start] of sessionStartTimes.entries()) {
      if (now - start >= STALE_SESSION_TIMEOUT_MS) {
        const durationMs = now - start;
        sessionStartTimes.delete(sessionId);
        send('idle', sessionId, { durationMs });
      }
    }
  }

  const staleSessionSweep = setInterval(
    () => sweepStaleSessions(Date.now()),
    STALE_SESSION_SWEEP_INTERVAL_MS,
  );
  staleSessionSweep.unref();

  function unsetTokenVars(): string[] {
    if (!config.haToken) return [];
    return [...config.haToken.matchAll(/\$\{([^}]+)}/g)]
      .map((match) => match[1] as string)
      .filter((name) => !process.env[name]);
  }

  function describeUnsetTokenVars(names: string[]): string {
    return `haToken references ${names.join(', ')}, which ${
      names.length > 1 ? 'are' : 'is'
    } not set in the opencode process environment`;
  }

  function describeMissingHaConfig(): string | undefined {
    if (!config.haApiUrl) return 'haApiUrl is not set';
    if (!config.haToken) return 'haToken is not set';
    if (resolveEnvVars(config.haToken)) return undefined;

    const unset = unsetTokenVars();
    if (unset.length > 0) return describeUnsetTokenVars(unset);
    return 'haToken resolved to an empty value';
  }

  function resolveHaConfig(): { apiUrl: string; token: string; entity: string } | undefined {
    if (!config.haApiUrl || !config.haToken) return undefined;
    const token = resolveEnvVars(config.haToken);
    if (!token) return undefined;
    return {
      apiUrl: config.haApiUrl.replace(/\/+$/, ''),
      token,
      entity: config.permissionResponseEntity ?? DEFAULT_RESPONSE_ENTITY,
    };
  }

  async function clearEntity(
    ha: { apiUrl: string; token: string; entity: string },
    requestId: string,
  ): Promise<void> {
    const failure = await setHaEntity(ha.apiUrl, ha.token, ha.entity, '');
    if (failure) {
      await report(`${requestId}: could not clear entity ${ha.entity}: ${failure}`, undefined);
    }
  }

  async function pollForResponse(requestId: string): Promise<PollOutcome> {
    const ha = resolveHaConfig();
    if (!ha) {
      await report(
        `${requestId}: not polling because ${describeMissingHaConfig() ?? 'the Home Assistant config is unavailable'}`,
        undefined,
      );
      return { kind: 'no-config' };
    }

    const partiallyUnset = unsetTokenVars();
    if (partiallyUnset.length > 0) {
      await report(
        `${requestId}: ${describeUnsetTokenVars(partiallyUnset)}, so the token is incomplete`,
        undefined,
      );
    }

    const timeoutMs = (config.permissionTimeout ?? DEFAULT_PERMISSION_TIMEOUT) * 1000;
    const deadline = Date.now() + timeoutMs;
    activePermissionPolls.add(requestId);
    await trace(`${requestId}: poll started, entity=${ha.entity}, timeout=${timeoutMs}ms`);

    let polls = 0;
    let mismatches = 0;
    let fetchFailures = 0;

    try {
      while (Date.now() < deadline) {
        if (repliedPermissions.delete(requestId)) {
          await trace(`${requestId}: poll canceled after ${polls} polls (answered elsewhere)`);
          return { kind: 'canceled' };
        }

        polls += 1;
        const read = await fetchHaEntity(ha.apiUrl, ha.token, ha.entity);
        if ('failure' in read) {
          fetchFailures += 1;
          if (fetchFailures === 1) {
            await report(
              `${requestId}: cannot read entity ${ha.entity} from Home Assistant: ${read.failure}`,
              undefined,
            );
          }
        } else if (read.entity.state) {
          const entity = read.entity;
          const result = parseResponse(entity.state, requestId);
          if (result?.kind === 'invalid') {
            await report(
              `${requestId}: response present but option index is not a valid index`,
              undefined,
            );
            await clearEntity(ha, requestId);
            return result;
          }
          if (result) {
            await trace(`${requestId}: matched ${result.kind} response after ${polls} polls`);
            await clearEntity(ha, requestId);
            return result;
          }
          mismatches += 1;
          if (mismatches === 1) {
            await trace(
              `${requestId}: observed a response for a different request (${describeForeignState(entity.state)})`,
            );
          }
        }
        await sleep(POLL_INTERVAL_MS);
      }
    } finally {
      activePermissionPolls.delete(requestId);
    }

    await report(
      `${requestId}: timed out after ${timeoutMs}ms (${polls} polls, ${mismatches} responses for other requests, ${fetchFailures} failed reads)`,
      undefined,
    );
    return { kind: 'timeout' };
  }

  function describeError(error: unknown): string | undefined {
    if (error === undefined || error === null) return undefined;
    if (error instanceof Error) return error.message;
    if (typeof error === 'object') {
      try {
        return JSON.stringify(error);
      } catch {
        return '[unserializable error]';
      }
    }
    return String(error);
  }

  async function log(level: 'debug' | 'error', message: string): Promise<void> {
    await client.app
      .log({ body: { service: 'opencode-homeassistant', level, message } })
      .catch(() => {});
  }

  async function report(message: string, error: unknown): Promise<void> {
    const detail = describeError(error);
    await log('error', detail ? `${message}: ${detail}` : message);
  }

  async function trace(message: string): Promise<void> {
    await log('debug', message);
  }

  async function answerQuestion(requestID: string, waiting: WaitingDetail): Promise<void> {
    if (activePermissionPolls.has(requestID)) {
      await trace(`${requestID}: already polling, not starting a second poll`);
      return;
    }

    const optionCount = waiting.questions?.[0]?.options?.length ?? 0;
    await trace(`${requestID}: answerQuestion started, ${optionCount} options offered`);

    const result = await pollForResponse(requestID);
    if (result.kind !== 'question') {
      if (result.kind === 'permission') {
        await report(
          `${requestID}: expected a question response but got a permission one`,
          undefined,
        );
      }
      return;
    }

    const label = waiting.questions?.[0]?.options?.[result.optionIndex]?.label;
    if (label === undefined) {
      await report(
        `${requestID}: option index ${result.optionIndex} is out of range (${optionCount} options offered)`,
        undefined,
      );
      return;
    }
    await trace(`${requestID}: option index ${result.optionIndex} resolved to a label`);

    const rawClient = (client as unknown as RawPostClient)._client;
    if (!rawClient?.post) {
      await report(`${requestID}: SDK client exposes no raw post method`, undefined);
      return;
    }

    await trace(`${requestID}: sending reply`);
    try {
      const response = (await rawClient.post({
        url: '/question/{requestID}/reply',
        path: { requestID },
        body: { answers: [[label]] },
      })) as { error?: unknown; response?: { status?: number } } | undefined;

      if (response?.error !== undefined) {
        await report(`${requestID}: reply rejected`, response.error);
        return;
      }

      const status = response?.response?.status;
      if (typeof status === 'number' && (status < 200 || status >= 300)) {
        await report(`${requestID}: reply returned HTTP ${status}`, undefined);
        return;
      }

      await trace(`${requestID}: reply accepted (HTTP ${status ?? 'unknown'})`);
    } catch (error) {
      await report(`${requestID}: reply threw`, error);
    }
  }

  const tracker = createAgentStateTracker({
    emitRepeatedBusy: true,
    onWaiting: async (sessionID, waiting) => {
      if (!sessionStartTimes.has(sessionID)) return;

      if (waiting.reason === 'question' && !waiting.id) return;

      await send('waiting', sessionID, {
        durationMs: elapsedSince(sessionID),
        waiting,
      });

      if (!waiting.id) return;

      if (waiting.reason === 'question') {
        await answerQuestion(waiting.id, waiting);
        return;
      }

      const result = await pollForResponse(waiting.id);
      if (result.kind !== 'permission') return;
      const apiResponse = result.response === 'allow' ? 'once' : 'reject';
      await client
        .postSessionIdPermissionsPermissionId({
          path: { id: sessionID, permissionID: waiting.id },
          body: { response: apiResponse },
        })
        .catch(() => {});
    },
    onWaitingIdResolved: async (sessionID, requestID, waiting) => {
      if (!sessionStartTimes.has(sessionID)) return;
      await send('waiting', sessionID, {
        durationMs: elapsedSince(sessionID),
        waiting,
      });
      await answerQuestion(requestID, waiting);
    },
    onBusy: async (sessionID) => {
      if (!sessionStartTimes.has(sessionID)) return;
      await send('busy', sessionID, { durationMs: elapsedSince(sessionID) });
    },
    onIdle: async (sessionID) => {
      if (!sessionStartTimes.has(sessionID)) return;
      const durationMs = elapsedSince(sessionID);
      sessionStartTimes.delete(sessionID);
      await send('idle', sessionID, { durationMs });
    },
    onError: async (sessionID) => {
      if (!sessionStartTimes.has(sessionID)) return;
      const durationMs = elapsedSince(sessionID);
      sessionStartTimes.delete(sessionID);
      await send('error', sessionID, { durationMs });
    },
    onPermissionReplied: (_sessionID, permissionID) => {
      if (activePermissionPolls.has(permissionID)) repliedPermissions.add(permissionID);
    },
    onQuestionResolved: (_sessionID, requestID) => {
      if (activePermissionPolls.has(requestID)) repliedPermissions.add(requestID);
    },
  });

  return {
    dispose: async () => {
      clearInterval(staleSessionSweep);
      for (const [sessionId, start] of sessionStartTimes.entries()) {
        sessionStartTimes.delete(sessionId);
        send('idle', sessionId, { durationMs: Date.now() - start });
      }
      await Promise.race([
        Promise.all([...inflightWebhooks.values()]),
        sleep(WEBHOOK_DRAIN_TIMEOUT_MS),
      ]);
    },
    config: async () => {
      config = loadConfig();
    },
    event: async ({ event }) => {
      if (event.type === 'session.status') {
        const { sessionID, status } = event.properties;
        if (status.type === 'busy') {
          const now = Date.now();
          if (!sessionStartTimes.has(sessionID)) sessionStartTimes.set(sessionID, now);
        }
      }
      await tracker.event({ event });
    },
    'tool.execute.before': tracker.toolExecuteBefore,
    'tool.execute.after': tracker.toolExecuteAfter,
  };
};
