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

const DEFAULT_PERMISSION_TIMEOUT = 120;
const DEFAULT_RESPONSE_ENTITY = 'input_text.opencode_permission_response';
const POLL_INTERVAL_MS = 2000;
const STALE_SESSION_TIMEOUT_MS = 10 * 60 * 1000;
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

  async function pollForPermissionResponse(
    permissionId: string,
  ): Promise<'allow' | 'deny' | undefined> {
    const ha = resolveHaConfig();
    if (!ha) return undefined;

    const timeoutMs = (config.permissionTimeout ?? DEFAULT_PERMISSION_TIMEOUT) * 1000;
    const deadline = Date.now() + timeoutMs;
    activePermissionPolls.add(permissionId);

    try {
      while (Date.now() < deadline) {
        if (repliedPermissions.delete(permissionId)) return undefined;

        const entity = await fetchHaEntity(ha.apiUrl, ha.token, ha.entity);
        if (entity && entity.state) {
          const colonIdx = entity.state.indexOf(':');
          if (colonIdx > 0) {
            const respPermId = entity.state.substring(0, colonIdx);
            const response = entity.state.substring(colonIdx + 1);
            if (respPermId === permissionId) {
              await setHaEntity(ha.apiUrl, ha.token, ha.entity, '');
              if (response === 'allow' || response === 'always') return 'allow';
              if (response === 'deny') return 'deny';
            }
          }
        }
        await sleep(POLL_INTERVAL_MS);
      }
    } finally {
      activePermissionPolls.delete(permissionId);
    }

    return undefined;
  }

  const tracker = createAgentStateTracker({
    emitRepeatedBusy: true,
    onWaiting: async (sessionID, waiting) => {
      if (!sessionStartTimes.has(sessionID)) return;
      await send('waiting', sessionID, {
        durationMs: elapsedSince(sessionID),
        waiting,
      });

      if (waiting.reason !== 'permission' || !waiting.id) return;
      const response = await pollForPermissionResponse(waiting.id);
      if (!response) return;
      const apiResponse = response === 'allow' ? 'once' : 'reject';
      await client
        .postSessionIdPermissionsPermissionId({
          path: { id: sessionID, permissionID: waiting.id },
          body: { response: apiResponse },
        })
        .catch(() => {});
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
  });

  return {
    dispose: async () => {
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
          sweepStaleSessions(now);
          if (!sessionStartTimes.has(sessionID)) sessionStartTimes.set(sessionID, now);
        }
      }
      await tracker.event({ event });
    },
    'tool.execute.before': tracker.toolExecuteBefore,
    'tool.execute.after': tracker.toolExecuteAfter,
  };
};
