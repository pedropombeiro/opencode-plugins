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

interface RawPostClient {
  _client?: {
    post?: (options: { url: string; path?: Record<string, unknown>; body?: unknown }) => unknown;
  };
}

const DEFAULT_PERMISSION_TIMEOUT = 120;
const DEFAULT_RESPONSE_ENTITY = 'input_text.opencode_permission_response';
const POLL_INTERVAL_MS = 2000;
const QUESTION_ID_GRACE_MS = 1000;
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
): Promise<HaEntityState | undefined> {
  try {
    const resp = await fetch(`${apiUrl}/states/${entityId}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return undefined;
    return (await resp.json()) as HaEntityState;
  } catch {
    return undefined;
  }
}

async function setHaEntity(
  apiUrl: string,
  token: string,
  entityId: string,
  state: string,
): Promise<void> {
  try {
    await fetch(`${apiUrl}/states/${entityId}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ state }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    /* best effort */
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
  const pendingQuestionIds = new Map<string, (requestID: string) => void>();

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

  async function pollForResponse(requestId: string): Promise<PollResult | undefined> {
    const ha = resolveHaConfig();
    if (!ha) return undefined;

    const timeoutMs = (config.permissionTimeout ?? DEFAULT_PERMISSION_TIMEOUT) * 1000;
    const deadline = Date.now() + timeoutMs;
    activePermissionPolls.add(requestId);

    try {
      while (Date.now() < deadline) {
        if (repliedPermissions.delete(requestId)) return undefined;

        const entity = await fetchHaEntity(ha.apiUrl, ha.token, ha.entity);
        if (entity && entity.state) {
          const result = parseResponse(entity.state, requestId);
          if (result) {
            await setHaEntity(ha.apiUrl, ha.token, ha.entity, '');
            return result;
          }
        }
        await sleep(POLL_INTERVAL_MS);
      }
    } finally {
      activePermissionPolls.delete(requestId);
    }

    return undefined;
  }

  async function answerQuestion(requestID: string, waiting: WaitingDetail): Promise<void> {
    if (activePermissionPolls.has(requestID)) return;

    const result = await pollForResponse(requestID);
    if (result?.kind !== 'question') return;

    const label = waiting.questions?.[0]?.options?.[result.optionIndex]?.label;
    if (label === undefined) return;

    const post = (client as unknown as RawPostClient)._client?.post;
    if (!post) return;

    await Promise.resolve(
      post({
        url: '/question/{requestID}/reply',
        path: { requestID },
        body: { answers: [[label]] },
      }),
    ).catch(() => {});
  }

  function awaitResolvedQuestionId(sessionID: string): Promise<string | undefined> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingQuestionIds.delete(sessionID);
        resolve(undefined);
      }, QUESTION_ID_GRACE_MS);
      timer.unref?.();
      pendingQuestionIds.set(sessionID, (requestID) => {
        clearTimeout(timer);
        pendingQuestionIds.delete(sessionID);
        resolve(requestID);
      });
    });
  }

  const tracker = createAgentStateTracker({
    emitRepeatedBusy: true,
    onWaiting: async (sessionID, waiting) => {
      if (!sessionStartTimes.has(sessionID)) return;

      if (waiting.reason === 'question' && !waiting.id) {
        const requestID = await awaitResolvedQuestionId(sessionID);
        const detail = requestID ? { ...waiting, id: requestID } : waiting;
        await send('waiting', sessionID, {
          durationMs: elapsedSince(sessionID),
          waiting: detail,
        });
        if (requestID) await answerQuestion(requestID, detail);
        return;
      }

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
      if (result?.kind !== 'permission') return;
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
      const notify = pendingQuestionIds.get(sessionID);
      if (notify) {
        notify(requestID);
        return;
      }
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
