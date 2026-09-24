import type { Plugin } from '@opencode/plugin';

export type OpenCodeEvent =
  ReturnType<Plugin.Context['event']['subscribe']> extends AsyncIterable<infer Event>
    ? Event
    : never;

export type EventOf<Type extends OpenCodeEvent['type']> = Extract<OpenCodeEvent, { type: Type }>;

export type FormInfo = EventOf<'form.created'>['data']['form'];

export type FormField = FormInfo['fields'][number];
