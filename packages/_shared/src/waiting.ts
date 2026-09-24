import type { EventOf, FormInfo } from './opencode.ts';

export interface WaitingQuestionOption {
  label: string;
  value?: string;
  description?: string;
}

export interface WaitingQuestion {
  header: string;
  question: string;
  options: WaitingQuestionOption[];
  multiple?: boolean;
}

export interface WaitingDetail {
  reason: 'permission' | 'question';
  id?: string;
  type?: string;
  title?: string;
  pattern?: string | string[];
  questions?: WaitingQuestion[];
}

export function permissionDetail(permission: EventOf<'permission.asked'>['data']): WaitingDetail {
  const resource = permission.resources[0];
  return {
    reason: 'permission',
    id: permission.id,
    type: permission.action,
    title: resource ? `${permission.action}: ${resource}` : permission.action,
    pattern: permission.resources,
  };
}

export function formDetail(form: FormInfo): WaitingDetail {
  return {
    reason: 'question',
    id: form.id,
    title: form.title,
    questions: form.fields
      .filter((field) => !('hidden' in field && field.hidden))
      .map((field) => ({
        header: field.title ?? form.title,
        question: field.description ?? '',
        options:
          'options' in field && field.options
            ? field.options.map((option) => ({
                label: option.label,
                value: option.value,
                description: option.description,
              }))
            : [],
        multiple: field.type === 'multiselect' ? true : undefined,
      })),
  };
}
