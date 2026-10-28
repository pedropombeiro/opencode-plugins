import { randomBytes } from 'node:crypto';

export interface CableSocket {
  send(data: string): void;
  close(): void;
  onmessage: ((data: string) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
  onresponse: ((status: number, headers: Headers) => void) | null;
}

export function cableSocket(url: string, credential: string, origin: string): CableSocket {
  const headers = { Authorization: `Bearer ${credential}`, Origin: origin };
  const ws = new WebSocket(url, { protocols: ['actioncable-v1-json'], headers });
  const abort = new AbortController();
  let opened = false;
  let probing = false;
  const socket: CableSocket = {
    send: (data) => ws.send(data),
    close: () => {
      abort.abort();
      ws.close();
    },
    onmessage: null,
    onerror: null,
    onclose: null,
    onresponse: null,
  };
  ws.onopen = () => {
    opened = true;
  };
  ws.onmessage = ({ data }) => socket.onmessage?.(String(data));
  ws.onclose = () => {
    if (!probing) socket.onclose?.();
  };
  ws.onerror = async () => {
    if (abort.signal.aborted || probing) return;
    if (opened) {
      socket.onerror?.();
      return;
    }
    probing = true;
    const endpoint = new URL(url);
    endpoint.protocol = endpoint.protocol === 'wss:' ? 'https:' : 'http:';
    try {
      const response = await fetch(endpoint, {
        redirect: 'manual',
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]),
        headers: {
          ...headers,
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
          'Sec-WebSocket-Protocol': 'actioncable-v1-json',
        },
      });
      try {
        if (!abort.signal.aborted) socket.onresponse?.(response.status, response.headers);
      } finally {
        await response.body?.cancel();
      }
    } catch {
      if (!abort.signal.aborted) socket.onerror?.();
    }
  };
  return socket;
}
