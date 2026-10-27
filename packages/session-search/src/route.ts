import type { OpenAction, OpenRequest } from './rpc.ts';

export type Route = { readonly type: string; readonly sessionID?: string };

export function showsSource(route: Route, request: Pick<OpenRequest, 'sourceSessionIDs'>): boolean {
  return (
    route.type === 'session' &&
    route.sessionID !== undefined &&
    request.sourceSessionIDs.includes(route.sessionID)
  );
}

export function openAction(tabsEnabled: boolean, request: Pick<OpenRequest, 'root'>): OpenAction {
  return tabsEnabled && request.root ? 'tab' : 'route';
}

export interface SessionUI {
  router: {
    current(): Route;
    navigate(route: { type: 'session'; sessionID: string }): void;
  };
  tabs: {
    enabled(): boolean;
    focus(sessionID: string): unknown;
    close(sessionID: string): unknown;
  };
}

export function openRequested(ui: SessionUI, request: OpenRequest): OpenAction | undefined {
  if (!showsSource(ui.router.current(), request)) return;
  const tabsEnabled = ui.tabs.enabled();
  const action = openAction(tabsEnabled, request);
  if (action === 'tab') ui.tabs.focus(request.sessionID);
  else ui.router.navigate({ type: 'session', sessionID: request.sessionID });

  const current = ui.router.current();
  if (current.type !== 'session' || current.sessionID !== request.sessionID) return;

  const sourceRootID = request.sourceSessionIDs[request.sourceSessionIDs.length - 1];
  if (
    request.closeSource &&
    tabsEnabled &&
    sourceRootID &&
    sourceRootID !== request.rootSessionID
  ) {
    ui.tabs.close(sourceRootID);
  }
  return action;
}
