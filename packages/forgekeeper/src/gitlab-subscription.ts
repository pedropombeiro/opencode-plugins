import type { Exec } from './exec';
import type { FeedbackEvents, GitLabMergeRequest } from './forge';
import { cableSocket } from './cable-socket';
import { SubscriptionRateLimit, subscriptionRetryAt } from './subscription-retry';

export type { CableSocket } from './cable-socket';

export async function subscribeToNotes(
  run: Exec,
  directory: string,
  request: GitLabMergeRequest,
  events: FeedbackEvents,
  signal: AbortSignal,
  socket = cableSocket,
) {
  const url = new URL(request.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return;
  const match = url.pathname.match(/^\/(.+)\/-\/merge_requests\/([1-9]\d*)\/?$/);
  if (!match || signal.aborted) return;
  const auth = await run('glab', ['config', 'get', 'token', '--host', url.hostname], directory);
  if (signal.aborted) return;
  if (auth.code !== 0 || !auth.stdout.trim())
    throw new Error('Subscription credentials unavailable');
  const result = await run(
    'glab',
    [
      'api',
      `projects/${encodeURIComponent(decodeURIComponent(match[1]))}/merge_requests/${match[2]}`,
      '--hostname',
      url.hostname,
    ],
    directory,
  );
  if (signal.aborted) return;
  if (result.code !== 0) throw new Error('Subscription target lookup failed');
  const mr = JSON.parse(result.stdout) as { id?: number; project_id?: number };
  if (!Number.isSafeInteger(mr.id) || !Number.isSafeInteger(mr.project_id))
    throw new Error('Invalid subscription target');
  const identifier = JSON.stringify({
    channel: 'Noteable::NotesChannel',
    project_id: mr.project_id,
    noteable_type: 'MergeRequest',
    noteable_id: mr.id,
  });
  await new Promise<void>((resolve, reject) => {
    const ws = socket(`wss://${url.host}/-/cable`, auth.stdout.trim(), url.origin);
    let ended = false;
    let confirmed = false;
    let rateLimit: SubscriptionRateLimit | undefined;
    let timer: ReturnType<typeof setTimeout>;
    const finish = () => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      ws.onresponse = null;
      ws.close();
      if (rateLimit) reject(rateLimit);
      else resolve();
    };
    const heartbeat = () => {
      clearTimeout(timer);
      timer = setTimeout(finish, confirmed ? 45_000 : 15_000);
    };
    heartbeat();
    signal.addEventListener('abort', finish, { once: true });
    ws.onerror = finish;
    ws.onclose = finish;
    ws.onresponse = (status, headers) => {
      if (status === 429)
        rateLimit = new SubscriptionRateLimit(subscriptionRetryAt(headers) ?? Date.now() + 60_000);
      finish();
    };
    ws.onmessage = (data) => {
      if (ended) return;
      try {
        const message = JSON.parse(String(data));
        if (confirmed) heartbeat();
        if (message.type === 'welcome')
          ws.send(JSON.stringify({ command: 'subscribe', identifier }));
        if (message.type === 'disconnect') finish();
        if (message.identifier !== identifier) return;
        if (message.type === 'reject_subscription') finish();
        if (message.type === 'confirm_subscription' && !confirmed) {
          confirmed = true;
          heartbeat();
          events.connected();
        }
        if (confirmed && message.message?.event === 'updated') events.changed();
      } catch {
        finish();
      }
    };
    if (signal.aborted) finish();
  });
}
