import { existsSync, readFileSync } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { Plugin } from '@opencode/plugin';
import {
  createAgentStateTracker,
  type FormInfo,
  type OpenCodeEvent,
  type WaitingDetail,
} from '../../_shared/src/v2.ts';
import pkg from '../package.json' with { type: 'json' };
import { HomeAssistantRpc } from './rpc.ts';

type AgentState = 'busy' | 'idle' | 'waiting' | 'error';
type WebhookUrlEntry = string | string[];
type LogLevel = 'debug' | 'info' | 'error';
type FormAnswer = Record<string, string | string[]>;

export interface Config {
  webhookUrl?: string;
  webhookUrls?: Partial<Record<AgentState | 'default', WebhookUrlEntry>>;
  haApiUrl?: string;
  haToken?: string;
  permissionResponseEntity?: string;
  permissionTimeout?: number;
  debug?: boolean;
  debugLogPath?: string;
}

export interface HomeAssistantDeps {
  directory: string;
  config: Config;
  log: (level: LogLevel, message: string) => Promise<void> | void;
  replyPermission: (
    sessionID: string,
    requestID: string,
    decision: 'once' | 'reject',
  ) => Promise<void>;
  replyForm: (sessionID: string, formID: string, answer: FormAnswer) => Promise<void>;
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

interface WebhookFailure {
  url: string;
  reason: string;
}

interface SessionTimes {
  start: number;
  lastActivity: number;
}

type PollResult =
  | { kind: 'permission'; response: 'allow' | 'deny' }
  | { kind: 'question'; optionIndex: number }
  | { kind: 'invalid' };

type PollOutcome = PollResult | { kind: 'no-config' } | { kind: 'canceled' } | { kind: 'timeout' };

const DEFAULT_PERMISSION_TIMEOUT = 120;
const DEFAULT_RESPONSE_ENTITY = 'input_text.opencode_permission_response';
const DEFAULT_DEBUG_LOG_PATH = join(homedir(), '.local', 'state', 'opencode', 'homeassistant.log');
const POLL_INTERVAL_MS = 2000;
const STALE_SESSION_TIMEOUT_MS = 10 * 60 * 1000;
const STALE_SESSION_SWEEP_INTERVAL_MS = 60 * 1000;
const WEBHOOK_TIMEOUT_MS = 5000;
const WEBHOOK_DRAIN_TIMEOUT_MS = 6000;

export function loadConfig(): Config {
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

function sendWebhook(urls: string[], payload: WebhookPayload): Promise<WebhookFailure[]> {
  return Promise.all(
    urls.map(async (url): Promise<WebhookFailure | undefined> => {
      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
        });
        if (!resp.ok) return { url, reason: `HTTP ${resp.status}` };
        return undefined;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const timedOut = error instanceof Error && error.name === 'TimeoutError';
        return {
          url,
          reason: timedOut ? `timed out after ${WEBHOOK_TIMEOUT_MS}ms` : detail,
        };
      }
    }),
  ).then((results) => results.filter((r): r is WebhookFailure => r !== undefined));
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

export function createHomeAssistant(deps: HomeAssistantDeps) {
  const { config } = deps;
  const project = basename(deps.directory);
  const host = hostname();
  const sessions = new Map<string, SessionTimes>();
  const repliedPermissions = new Set<string>();
  const activePermissionPolls = new Set<string>();
  const inflightWebhooks = new Map<string, Promise<void>>();
  const forms = new Map<string, FormInfo>();

  function elapsedSince(sessionId?: string): number | undefined {
    if (!sessionId) return undefined;
    const session = sessions.get(sessionId);
    return session ? Date.now() - session.start : undefined;
  }

  function recordActivity(sessionId: string, now = Date.now()): boolean {
    const session = sessions.get(sessionId);
    if (session) {
      session.lastActivity = now;
      return false;
    }
    sessions.set(sessionId, { start: now, lastActivity: now });
    return true;
  }

  function send(
    state: AgentState,
    sessionId?: string,
    extra?: { durationMs?: number; waiting?: WaitingDetail },
  ): Promise<void> {
    const urls = resolveWebhookUrls(config, state);
    if (urls.length === 0) {
      if (state === 'waiting') {
        return report(
          'no webhook URL configured for the waiting state, so no notification was sent',
          undefined,
        );
      }
      return Promise.resolve();
    }
    const payload: WebhookPayload = { state, hostname: host, project, sessionId };
    if (extra?.durationMs !== undefined) payload.durationMs = extra.durationMs;
    if (extra?.waiting) payload.waiting = extra.waiting;

    const key = sessionId ?? '';
    const previous = inflightWebhooks.get(key) ?? Promise.resolve();
    const promise = previous
      .then(() => sendWebhook(urls, payload))
      .then(async (failures) => {
        for (const failure of failures) {
          await report(
            `${state} webhook to ${failure.url} failed: ${failure.reason}${
              state === 'waiting' ? ' (no notification was delivered)' : ''
            }`,
            undefined,
          );
        }
      })
      .finally(() => {
        if (inflightWebhooks.get(key) === promise) inflightWebhooks.delete(key);
      });
    inflightWebhooks.set(key, promise);
    return promise;
  }

  function sweepStaleSessions(now: number): void {
    for (const [sessionId, session] of sessions.entries()) {
      if (tracker.hasWait(sessionId)) continue;
      if (now - session.lastActivity >= STALE_SESSION_TIMEOUT_MS) {
        const durationMs = now - session.start;
        sessions.delete(sessionId);
        send('idle', sessionId, { durationMs });
      }
    }
  }

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

  async function log(level: LogLevel, message: string): Promise<void> {
    try {
      await deps.log(level, message);
    } catch {
      return;
    }
  }

  async function report(message: string, error: unknown): Promise<void> {
    const detail = describeError(error);
    await log('error', detail ? `${message}: ${detail}` : message);
  }

  async function trace(message: string): Promise<void> {
    await log('debug', message);
  }

  async function announce(message: string): Promise<void> {
    await log('info', message);
  }

  async function answerQuestion(sessionID: string, formID: string): Promise<void> {
    if (activePermissionPolls.has(formID)) {
      await trace(`${formID}: already polling, not starting a second poll`);
      return;
    }

    const field = forms
      .get(formID)
      ?.fields.find((candidate) => !('hidden' in candidate && candidate.hidden));
    const options = field && 'options' in field ? (field.options ?? []) : [];
    await trace(`${formID}: answerQuestion started, ${options.length} options offered`);

    const result = await pollForResponse(formID);
    if (result.kind !== 'question') {
      if (result.kind === 'permission') {
        await report(`${formID}: expected a question response but got a permission one`, undefined);
      }
      return;
    }

    const option = options[result.optionIndex];
    if (!field || !option) {
      await report(
        `${formID}: option index ${result.optionIndex} is out of range (${options.length} options offered)`,
        undefined,
      );
      return;
    }
    await trace(`${formID}: option index ${result.optionIndex} resolved to a value`);

    const answer = { [field.key]: field.type === 'multiselect' ? [option.value] : option.value };
    try {
      await deps.replyForm(sessionID, formID, answer);
      await trace(`${formID}: reply relayed to the CLI`);
    } catch (error) {
      await report(`${formID}: reply could not be relayed`, error);
    }
  }

  async function answerPermission(sessionID: string, requestID: string): Promise<void> {
    const result = await pollForResponse(requestID);
    if (result.kind !== 'permission') return;
    try {
      await deps.replyPermission(
        sessionID,
        requestID,
        result.response === 'allow' ? 'once' : 'reject',
      );
    } catch (error) {
      await report(`${requestID}: permission reply rejected`, error);
    }
  }

  function describeStartup(): string {
    const ha = resolveHaConfig();
    const entity = config.permissionResponseEntity ?? DEFAULT_RESPONSE_ENTITY;
    const timeout = config.permissionTimeout ?? DEFAULT_PERMISSION_TIMEOUT;
    const remote = ha ? 'enabled' : `disabled (${describeMissingHaConfig()})`;
    return `started version=${pkg.version}, entity=${entity}, permissionTimeout=${timeout}s, remoteReplies=${remote}`;
  }

  const tracker = createAgentStateTracker({
    emitRepeatedBusy: true,
    onWaiting: async (sessionID, waiting) => {
      const id = waiting.id ?? '(unresolved)';
      if (recordActivity(sessionID)) {
        await trace(
          `${id}: reactivated idle session ${sessionID} from incoming ${waiting.reason} request`,
        );
      }

      await send('waiting', sessionID, {
        durationMs: elapsedSince(sessionID),
        waiting,
      });

      if (!waiting.id) return;
      const answer =
        waiting.reason === 'question'
          ? answerQuestion(sessionID, waiting.id)
          : answerPermission(sessionID, waiting.id);
      void answer.catch((error: unknown) => report(`${id}: remote reply failed`, error));
    },
    onBusy: async (sessionID) => {
      if (!sessions.has(sessionID)) return;
      recordActivity(sessionID);
      await send('busy', sessionID, { durationMs: elapsedSince(sessionID) });
    },
    onIdle: async (sessionID) => {
      if (!sessions.has(sessionID)) return;
      const durationMs = elapsedSince(sessionID);
      sessions.delete(sessionID);
      await send('idle', sessionID, { durationMs });
    },
    onError: async (sessionID) => {
      if (!sessions.has(sessionID)) return;
      const durationMs = elapsedSince(sessionID);
      sessions.delete(sessionID);
      await send('error', sessionID, { durationMs });
    },
    onResolved: (_sessionID, requestID) => {
      if (activePermissionPolls.has(requestID)) repliedPermissions.add(requestID);
    },
  });

  const staleSessionSweep = setInterval(
    () => sweepStaleSessions(Date.now()),
    STALE_SESSION_SWEEP_INTERVAL_MS,
  );
  staleSessionSweep.unref();

  void announce(describeStartup());

  async function handle(event: OpenCodeEvent): Promise<void> {
    if (event.type === 'session.execution.started') recordActivity(event.data.sessionID);
    if (event.type === 'form.created') forms.set(event.data.form.id, event.data.form);
    await tracker.handle(event);
    if (event.type === 'form.replied' || event.type === 'form.cancelled') {
      forms.delete(event.data.id);
    }
  }

  async function dispose(): Promise<void> {
    clearInterval(staleSessionSweep);
    for (const [sessionId, session] of sessions.entries()) {
      sessions.delete(sessionId);
      void send('idle', sessionId, { durationMs: Date.now() - session.start });
    }
    await Promise.race([
      Promise.all([...inflightWebhooks.values()]),
      sleep(WEBHOOK_DRAIN_TIMEOUT_MS),
    ]);
  }

  return { handle, dispose };
}

function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path;
}

export function createDebugLog(config: Config): HomeAssistantDeps['log'] {
  if (!config.debug) return () => {};
  const path = expandHome(config.debugLogPath ?? DEFAULT_DEBUG_LOG_PATH);
  let ready: Promise<unknown> | undefined;
  return async (level, message) => {
    ready ??= mkdir(dirname(path), { recursive: true }).catch(() => {});
    await ready;
    await appendFile(path, `${new Date().toISOString()} ${level} ${message}\n`).catch(() => {});
  };
}

export default {
  id: 'opencode-homeassistant',
  async setup(ctx) {
    const config: Config = { ...loadConfig(), ...(ctx.options as Config) };
    const rpc = await ctx.rpc.register(HomeAssistantRpc, {});
    const homeAssistant = createHomeAssistant({
      directory: ctx.location.directory,
      config,
      log: createDebugLog(config),
      replyPermission: (sessionID, requestID, decision) =>
        ctx.permission.reply({ sessionID, requestID, decision }),
      replyForm: (sessionID, formID, answer) =>
        rpc.events.emit('answer', { sessionID, formID, answer }),
    });

    const controller = new AbortController();
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        await homeAssistant.handle(event);
      }
    })().catch(() => {});

    return async () => {
      controller.abort();
      await homeAssistant.dispose();
    };
  },
} satisfies Plugin.Plugin;
