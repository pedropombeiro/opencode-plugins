import { promptTokens, usd, type ModelRef, type Price, type Tokens } from './cache';

export interface Thresholds {
  minPrompt: number;
  missRequests: number;
  missInput: number;
  missShare: number;
  baselineRequests: number;
  baselineShare: number;
  regressionShare: number;
  regressionDrop: number;
  recoveryRequests: number;
  recoveryShare: number;
  recoveryMargin: number;
  persistRequests: number;
  fullShare: number;
  history: number;
  sessions: number;
  seen: number;
}

export const THRESHOLDS: Thresholds = {
  minPrompt: 8_000,
  missRequests: 4,
  missInput: 100_000,
  missShare: 0.05,
  baselineRequests: 5,
  baselineShare: 0.5,
  regressionShare: 0.3,
  regressionDrop: 0.4,
  recoveryRequests: 3,
  recoveryShare: 0.5,
  recoveryMargin: 0.2,
  persistRequests: 3,
  fullShare: 0.05,
  history: 20,
  sessions: 50,
  seen: 200,
};

export interface Observation {
  sessionID: string;
  stepID: string;
  model: ModelRef & { variant?: string };
  agent?: string;
  started: number;
  tokens: Tokens;
  ttl: number;
  cachePriced: boolean;
  price?: Price;
}

export interface Window {
  share: number;
  input: number;
  written: number;
  requests: number;
}

export type Pattern = 'full' | 'partial';

export interface IncidentRecord {
  key: string;
  incident: number;
  opened: number;
  assumed: boolean;
  requests: number;
  lost: number;
  extra?: number;
  pattern: Pattern;
  partialShare?: number;
  open: boolean;
  notified: boolean;
}

export type Finding =
  | {
      type: 'low';
      key: string;
      incident: number;
      reason: 'miss' | 'regression';
      window: Window;
      baseline?: number;
      assumed: boolean;
    }
  | {
      type: 'persistent';
      key: string;
      incident: number;
      window: Window;
      baseline?: number;
      record: IncidentRecord;
    }
  | {
      type: 'recovered';
      key: string;
      incident: number;
      window: Window;
      notified: boolean;
      record: IncidentRecord;
    };

export interface Summary {
  incidents: number;
  open: number;
  lost: number;
  extra?: number;
  assumed: number;
  last?: IncidentRecord;
}

type Totals = Omit<Summary, 'last'>;

export type Skip =
  | 'invalid'
  | 'duplicate'
  | 'empty'
  | 'late'
  | 'reset'
  | 'telemetry'
  | 'small'
  | 'eligible';

export type Status =
  | { kind: 'unknown' }
  | { kind: 'waiting' }
  | { kind: 'ok'; window: Window }
  | { kind: 'low'; window: Window; baseline?: number };

interface Sample {
  read: number;
  write: number;
  input: number;
  lost: number;
  extra?: number;
}

interface Incident {
  number: number;
  baseline?: number;
  assumed: boolean;
  window: Window;
  since: Sample[];
  after: number;
  record: IncidentRecord;
  totals: Totals;
  full: number;
  partial: number;
  partialRead: number;
}

interface Track {
  last?: number;
  prompt?: number;
  telemetry: boolean;
  assumed: boolean;
  recent: Sample[];
  history: Sample[];
  incident?: Incident;
  incidents: number;
}

interface SessionState {
  current?: string;
  reset: boolean;
  seen: Set<string>;
  tracks: Map<string, Track>;
  last?: IncidentRecord;
  totals: Totals;
}

export const contextKey = (model: ModelRef & { variant?: string }, agent?: string) =>
  `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ''}${agent ? `@${agent}` : ''}`;

function summarize(samples: readonly Sample[]): Window {
  let read = 0;
  let input = 0;
  let written = 0;
  for (const sample of samples) {
    read += sample.read;
    input += sample.input;
    written += sample.write;
  }
  return { share: input > 0 ? read / input : 0, input, written, requests: samples.length };
}

const valid = (value: number) => Number.isFinite(value) && value >= 0;

export function createHealth(
  thresholds: Thresholds = THRESHOLDS,
  trace: (skip: Skip) => void = () => {},
) {
  const sessions = new Map<string, SessionState>();
  const skip = (reason: Skip): undefined => {
    trace(reason);
    return undefined;
  };

  function sessionOf(sessionID: string): SessionState {
    let state = sessions.get(sessionID);
    if (state) {
      sessions.delete(sessionID);
      sessions.set(sessionID, state);
      return state;
    }
    state = {
      reset: false,
      seen: new Set(),
      tracks: new Map(),
      totals: { incidents: 0, open: 0, lost: 0, assumed: 0 },
    };
    sessions.set(sessionID, state);
    while (sessions.size > thresholds.sessions) {
      const oldest = sessions.keys().next().value;
      if (oldest === undefined) break;
      sessions.delete(oldest);
    }
    return state;
  }

  function see(state: SessionState, stepID: string): boolean {
    if (state.seen.has(stepID)) return false;
    state.seen.add(stepID);
    if (state.seen.size > thresholds.seen) {
      const oldest = state.seen.values().next().value;
      if (oldest !== undefined) state.seen.delete(oldest);
    }
    return true;
  }

  function trackOf(state: SessionState, key: string): Track {
    let track = state.tracks.get(key);
    if (!track) {
      track = { telemetry: false, assumed: false, recent: [], history: [], incidents: 0 };
      state.tracks.set(key, track);
    }
    return track;
  }

  function baselineOf(track: Track): number | undefined {
    if (track.history.length < thresholds.baselineRequests) return undefined;
    const { share } = summarize(track.history);
    return share >= thresholds.baselineShare ? share : undefined;
  }

  function record(track: Track, sample: Sample) {
    track.recent.push(sample);
    if (track.recent.length <= thresholds.missRequests) return;
    const left = track.recent.shift();
    if (!left || track.incident) return;
    track.history.push(left);
    if (track.history.length > thresholds.history) track.history.shift();
  }

  function account(incident: Incident, sample: Sample) {
    const { record, totals } = incident;
    record.requests += 1;
    record.lost += sample.lost;
    if (sample.extra !== undefined) record.extra = (record.extra ?? 0) + sample.extra;
    if (!incident.assumed) {
      totals.lost += sample.lost;
      if (sample.extra !== undefined) totals.extra = (totals.extra ?? 0) + sample.extra;
    }
    const share = sample.input > 0 ? sample.read / sample.input : 0;
    if (share >= thresholds.regressionShare) return;
    if (share < thresholds.fullShare) incident.full += 1;
    else {
      incident.partial += 1;
      incident.partialRead += share;
    }
    record.pattern = incident.partial > incident.full ? 'partial' : 'full';
    if (record.pattern === 'partial') record.partialShare = incident.partialRead / incident.partial;
    else delete record.partialShare;
  }

  function close(incident: Incident) {
    if (!incident.record.open) return;
    incident.record.open = false;
    if (!incident.assumed) incident.totals.open -= 1;
  }

  function detect(
    key: string,
    state: SessionState,
    track: Track,
    opened: number,
  ): Finding | undefined {
    if (track.recent.length < thresholds.missRequests) return undefined;
    const window = summarize(track.recent);
    if (window.input < thresholds.missInput) return undefined;
    const baseline = baselineOf(track);
    const regressed =
      baseline !== undefined &&
      window.share < thresholds.regressionShare &&
      baseline - window.share >= thresholds.regressionDrop;
    if (!regressed && window.share >= thresholds.missShare) return undefined;
    track.incidents += 1;
    const assumed = !track.telemetry;
    const record: IncidentRecord = {
      key,
      incident: track.incidents,
      opened,
      assumed,
      requests: 0,
      lost: 0,
      pattern: 'full',
      open: true,
      notified: false,
    };
    const incident: Incident = {
      number: track.incidents,
      assumed,
      window,
      since: [],
      after: 0,
      record,
      totals: state.totals,
      full: 0,
      partial: 0,
      partialRead: 0,
      ...(regressed ? { baseline } : {}),
    };
    if (assumed) state.totals.assumed += 1;
    else {
      state.totals.incidents += 1;
      state.totals.open += 1;
    }
    for (const sample of track.recent) account(incident, sample);
    track.incident = incident;
    state.last = record;
    return {
      type: 'low',
      key,
      incident: track.incident.number,
      reason: regressed ? 'regression' : 'miss',
      window,
      ...(regressed ? { baseline } : {}),
      assumed: !track.telemetry,
    };
  }

  function recover(key: string, track: Track, sample: Sample): Finding | undefined {
    const incident = track.incident;
    if (!incident) return undefined;
    account(incident, sample);
    incident.since.push(sample);
    if (incident.since.length > thresholds.recoveryRequests) incident.since.shift();
    const window = summarize(incident.since);
    const target = Math.max(
      thresholds.recoveryShare,
      (incident.baseline ?? 0) - thresholds.recoveryMargin,
    );
    if (incident.since.length >= thresholds.recoveryRequests && window.share >= target) {
      track.incident = undefined;
      track.recent = [];
      close(incident);
      return {
        type: 'recovered',
        key,
        incident: incident.number,
        window,
        notified: incident.record.notified,
        record: { ...incident.record },
      };
    }
    const share = sample.input > 0 ? sample.read / sample.input : 0;
    if (share >= thresholds.regressionShare) return undefined;
    incident.after += 1;
    if (incident.assumed || incident.record.notified) return undefined;
    if (incident.after < thresholds.persistRequests) return undefined;
    incident.record.notified = true;
    return {
      type: 'persistent',
      key,
      incident: incident.number,
      window: summarize(track.recent),
      ...(incident.baseline === undefined ? {} : { baseline: incident.baseline }),
      record: { ...incident.record },
    };
  }

  function sampleOf(track: Track, tokens: Tokens, price?: Price): Sample {
    const read = tokens.cache.read;
    const write = tokens.cache.write;
    const fresh = tokens.input + write;
    const lost = Math.min(fresh, Math.max(0, (track.prompt ?? 0) - read));
    const sample: Sample = { read, write, input: read + fresh, lost };
    if (!price || fresh === 0) return sample;
    const paid = (write * price.write + tokens.input * price.input) / fresh;
    return { ...sample, extra: usd(lost, Math.max(0, paid - price.read)) };
  }

  function observe(input: Observation): Finding | undefined {
    const { tokens } = input;
    const parts = [tokens.input, tokens.cache.read, tokens.cache.write];
    if (!parts.every(valid)) return skip('invalid');
    const state = sessionOf(input.sessionID);
    if (!see(state, input.stepID)) return skip('duplicate');
    const prompt = promptTokens(tokens);
    if (prompt === 0) return skip('empty');
    const key = contextKey(input.model, input.agent);
    const track = trackOf(state, key);
    if (track.last !== undefined && input.started < track.last) return skip('late');
    const reported = tokens.cache.read + tokens.cache.write > 0;
    if (reported && !track.telemetry && track.incident?.assumed) {
      close(track.incident);
      track.incident = undefined;
      track.recent = [];
    }
    if (reported) track.telemetry = true;
    track.assumed = !track.telemetry && input.cachePriced;
    const previous = track.prompt;
    track.prompt = prompt;
    const switched = state.current !== key;
    const continuous =
      !switched &&
      !state.reset &&
      track.last !== undefined &&
      input.started - track.last <= input.ttl;
    state.current = key;
    state.reset = false;
    track.last = input.started;
    if (!continuous) {
      track.recent = [];
      if (track.incident) track.incident.since = [];
      return skip('reset');
    }
    if (!track.telemetry && !input.cachePriced) return skip('telemetry');
    if (prompt < thresholds.minPrompt) return skip('small');
    trace('eligible');
    const sample = sampleOf({ ...track, prompt: previous }, tokens, input.price);
    if (track.incident) {
      track.recent.push(sample);
      if (track.recent.length > thresholds.missRequests) track.recent.shift();
      return recover(key, track, sample);
    }
    record(track, sample);
    return detect(key, state, track, input.started);
  }

  function compacted(sessionID: string) {
    const state = sessions.get(sessionID);
    if (!state) return;
    state.reset = true;
    for (const track of state.tracks.values()) {
      track.recent = [];
      track.history = [];
      track.prompt = undefined;
      if (track.incident) close(track.incident);
      track.incident = undefined;
    }
  }

  function summary(sessionID: string): Summary {
    const state = sessions.get(sessionID);
    if (!state) return { incidents: 0, open: 0, lost: 0, assumed: 0 };
    return { ...state.totals, ...(state.last ? { last: { ...state.last } } : {}) };
  }

  function status(
    sessionID: string,
    model: ModelRef & { variant?: string },
    agent?: string,
  ): Status {
    const track = sessions.get(sessionID)?.tracks.get(contextKey(model, agent));
    if (!track || (!track.telemetry && !track.assumed)) return { kind: 'unknown' };
    if (track.incident)
      return {
        kind: 'low',
        window:
          track.recent.length < thresholds.missRequests
            ? track.incident.window
            : summarize(track.recent),
        ...(track.incident.baseline === undefined ? {} : { baseline: track.incident.baseline }),
      };
    if (track.recent.length < thresholds.missRequests) return { kind: 'waiting' };
    return { kind: 'ok', window: summarize(track.recent) };
  }

  return {
    observe,
    failed: (sessionID: string, stepID: string) => void see(sessionOf(sessionID), stepID),
    compacted,
    status,
    summary,
  };
}

export type Health = ReturnType<typeof createHealth>;
