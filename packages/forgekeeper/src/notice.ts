import type { Notice } from './rpc';

export interface NoticeHost {
  hasShown: (sessionID: string) => boolean;
  openTab: (sessionID: string) => void;
  toast: (input: { title?: string; message: string; variant: Notice['variant'] }) => void;
}

// Notices about a session go to the CLIs that have shown it. A delivered
// notification reopens the session's tab in the background, so a session
// whose tab was closed can still be found from the toast.
export function showNotice(notice: Notice, host: NoticeHost) {
  const { sessionID } = notice;
  if (sessionID && !host.hasShown(sessionID)) return;
  if (sessionID && notice.variant === 'info') host.openTab(sessionID);
  host.toast({
    ...(notice.title ? { title: notice.title } : {}),
    message: notice.message,
    variant: notice.variant,
  });
}
