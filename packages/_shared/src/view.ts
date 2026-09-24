import type { Plugin } from '@opencode/plugin/tui';
import { eventSessionID } from './location.ts';
import type { OpenCodeEvent } from './opencode.ts';

type ViewContext = Pick<Plugin.Context, 'data' | 'ui'>;

export function createViewFilter(context: ViewContext, tracks: (sessionID: string) => boolean) {
  function visible(sessionID: string): boolean {
    const root = context.data.session.root(sessionID);
    const route = context.ui.router.current();
    if (route.type === 'session' && context.data.session.root(route.sessionID) === root) {
      return true;
    }
    return (
      context.ui.tabs.enabled() && context.ui.tabs.list().some((tab) => tab.sessionID === root)
    );
  }

  return function shows(event: OpenCodeEvent): boolean {
    const sessionID = eventSessionID(event);
    return sessionID !== undefined && (tracks(sessionID) || visible(sessionID));
  };
}
