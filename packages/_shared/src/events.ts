export interface WaitingQuestionOption {
  label: string;
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

export interface PermissionAskedEvent {
  type: 'permission.asked';
  properties: {
    id: string;
    sessionID: string;
    permission: string;
    patterns?: string[];
  };
}

export interface PermissionRepliedEvent {
  type: 'permission.replied';
  properties: {
    sessionID: string;
    permissionID?: string;
    requestID?: string;
  };
}

export interface QuestionAskedEvent {
  type: 'question.asked';
  properties: {
    id: string;
    sessionID: string;
    questions?: WaitingQuestion[];
    tool?: { callID: string };
  };
}

export interface QuestionRepliedEvent {
  type: 'question.replied' | 'question.rejected';
  properties: {
    sessionID: string;
    requestID: string;
  };
}

export function readRequestId(properties: Record<string, unknown>): string | undefined {
  const requestID = properties['requestID'];
  if (typeof requestID === 'string') return requestID;
  const permissionID = properties['permissionID'];
  return typeof permissionID === 'string' ? permissionID : undefined;
}

export function questionDetail(args: unknown): WaitingDetail {
  const questions = Array.isArray((args as { questions?: unknown })?.questions)
    ? (args as { questions: unknown[] }).questions
        .filter(
          (question): question is Record<string, unknown> =>
            typeof question === 'object' && question !== null,
        )
        .filter(
          (question) =>
            typeof question['header'] === 'string' || typeof question['question'] === 'string',
        )
        .map((question) => ({
          header: typeof question['header'] === 'string' ? question['header'] : '',
          question: typeof question['question'] === 'string' ? question['question'] : '',
          options: Array.isArray(question['options'])
            ? question['options']
                .filter(
                  (option): option is Record<string, unknown> =>
                    typeof option === 'object' && option !== null,
                )
                .filter((option) => typeof option['label'] === 'string')
                .map((option) => ({
                  label: option['label'] as string,
                  description:
                    typeof option['description'] === 'string' ? option['description'] : undefined,
                }))
            : [],
          multiple: typeof question['multiple'] === 'boolean' ? question['multiple'] : undefined,
        }))
    : undefined;
  return { reason: 'question', title: questions?.[0]?.header, questions };
}
