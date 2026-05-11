import { existsSync, readFileSync } from 'fs';
import { basename } from 'path';
import { homedir, hostname } from 'os';
import { join } from 'path';
import type { Plugin } from '@opencode-ai/plugin';

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

interface WaitingDetail {
  reason: 'permission' | 'question';
  id?: string;
  type?: string;
  title?: string;
  pattern?: string | string[];
  questions?: QuestionDetail[];
}

interface QuestionOption {
  label: string;
  description?: string;
}

interface QuestionDetail {
  header: string;
  question: string;
  options: QuestionOption[];
  multiple?: boolean;
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
      .finally(() => inflightWebhooks.delete(key));
    inflightWebhooks.set(key, promise);
    return promise;
  }

  function sweepStaleSessions(now: number): void {
    for (const [sessionId, start] of sessionStartTimes.entries()) {
      if (now - start >= STALE_SESSION_TIMEOUT_MS) {
        const durationMs = now - start;
        sessionStartTimes.delete(sessionId);
        inflightWebhooks.delete(sessionId);
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

    return undefined;
  }

  return {
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
          send('busy', sessionID);
        } else if (status.type === 'idle') {
          const durationMs = elapsedSince(sessionID);
          sessionStartTimes.delete(sessionID);
          send('idle', sessionID, { durationMs });
        }
      } else if (event.type === 'session.error') {
        const sessionID = event.properties.sessionID;
        const durationMs = elapsedSince(sessionID);
        if (sessionID) sessionStartTimes.delete(sessionID);
        send('error', sessionID, { durationMs });
      } else if ((event.type as string) === 'permission.asked') {
        const props = (event as unknown as { properties: Record<string, unknown> }).properties as {
          id: string;
          sessionID: string;
          permission: string;
          patterns?: string[];
          metadata?: Record<string, unknown>;
        };
        const title = props.patterns?.[0]
          ? `${props.permission}: ${props.patterns[0]}`
          : props.permission;
        await send('waiting', props.sessionID, {
          durationMs: elapsedSince(props.sessionID),
          waiting: {
            reason: 'permission',
            id: props.id,
            type: props.permission,
            title,
            pattern: props.patterns,
          },
        });

        const response = await pollForPermissionResponse(props.id);
        if (response) {
          const apiResponse = response === 'allow' ? 'once' : 'reject';
          await client
            .postSessionIdPermissionsPermissionId({
              path: { id: props.sessionID, permissionID: props.id },
              body: { response: apiResponse },
            })
            .catch(() => {});
        }
      } else if (event.type === 'permission.replied') {
        const props = event.properties;
        repliedPermissions.add(props.permissionID);
        await send('busy', props.sessionID, {
          durationMs: elapsedSince(props.sessionID),
        });
      }
    },
    'tool.execute.before': async (input, output) => {
      if (input.tool === 'question') {
        let args = output.args;
        if (typeof args === 'string') {
          try {
            args = JSON.parse(args);
          } catch {
            args = undefined;
          }
        }
        const questions = Array.isArray(args?.questions) ? args.questions : undefined;
        const title = questions?.[0]?.header;
        const questionDetails = questions
          ?.filter((question: QuestionDetail) => Boolean(question?.header || question?.question))
          .map((question: QuestionDetail) => ({
            header: question.header ?? '',
            question: question.question ?? '',
            options: Array.isArray(question.options)
              ? question.options.map((option: QuestionOption) => ({
                  label: option.label,
                  description: option.description,
                }))
              : [],
            multiple: question.multiple,
          }));
        send('waiting', input.sessionID, {
          durationMs: elapsedSince(input.sessionID),
          waiting: { reason: 'question', title, questions: questionDetails },
        });
      }
    },
  };
};
