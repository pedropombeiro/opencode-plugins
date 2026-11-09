export const NOTICE_TEXT = '[cache-coach: a prompt cache notice for the user. Ignore it.]';

interface MessageLike {
  role: string;
  content: readonly unknown[];
}

const isNotice = (message: MessageLike) => {
  if (message.role !== 'user' || message.content.length !== 1) return false;
  const part = message.content[0] as { type?: unknown; text?: unknown } | undefined;
  return part?.type === 'text' && part.text === NOTICE_TEXT;
};

export const withoutNotices = <T extends MessageLike>(messages: readonly T[]): T[] =>
  messages.filter((message) => !isNotice(message));
