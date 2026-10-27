import type { Plugin } from '@opencode/plugin/tui';

export type OpenCodeEvent = Parameters<
  Parameters<Plugin.Context['data']['listen']>[0]
>[0]['details'];

export type EventOf<Type extends OpenCodeEvent['type']> = Extract<OpenCodeEvent, { type: Type }>;

export type FormInfo = EventOf<'form.created'>['data']['form'];

export type FormField = FormInfo['fields'][number];
