export function parseConcatenatedJson<T>(raw: string): T {
  const trimmed = raw.trim();
  if (!trimmed) return {} as T;
  try {
    return JSON.parse(trimmed) as T;
  } catch (firstError) {
    const values: unknown[] = [];
    let index = 0;

    while (index < trimmed.length) {
      while (index < trimmed.length && /\s/.test(trimmed[index]!)) {
        index += 1;
      }
      if (index >= trimmed.length) break;

      const startChar = trimmed[index];
      if (startChar !== '[' && startChar !== '{') {
        throw firstError;
      }

      let depth = 0;
      let inString = false;
      let escaped = false;
      let end = index;

      for (; end < trimmed.length; end += 1) {
        const ch = trimmed[end]!;
        if (inString) {
          if (escaped) {
            escaped = false;
          } else if (ch === '\\') {
            escaped = true;
          } else if (ch === '"') {
            inString = false;
          }
          continue;
        }
        if (ch === '"') {
          inString = true;
        } else if (ch === '[' || ch === '{') {
          depth += 1;
        } else if (ch === ']' || ch === '}') {
          depth -= 1;
          if (depth < 0) throw firstError;
          if (depth === 0) {
            end += 1;
            break;
          }
        }
      }

      if (depth !== 0 || inString) {
        throw firstError;
      }

      values.push(JSON.parse(trimmed.slice(index, end)) as unknown);
      index = end;
    }

    if (values.length <= 1) {
      throw firstError;
    }

    const items: unknown[] = [];
    for (const value of values) {
      if (Array.isArray(value)) items.push(...value);
      else items.push(value);
    }
    return items as unknown as T;
  }
}

export function withoutResolutionLabels(
  labels: readonly string[],
  prefix: string | undefined,
): string[] {
  return prefix ? labels.filter((label) => !label.startsWith(prefix)) : [...labels];
}

export function describeClosedMatch(
  labels: readonly string[],
  reopenLabels: readonly string[] | undefined,
  closedUrl?: string,
): string {
  const labelText = labels.length > 0 ? ` Labels: ${labels.join(', ')}.` : '';
  const intro = `No issue or comment was created.${labelText}`;
  const ask = 'Ask the user before calling `vent` again';
  const pin = closedUrl ? ` Pass \`closedMatchUrl: "${closedUrl}"\` to confirm the issue.` : '';

  if (!reopenLabels || reopenLabels.length === 0) {
    return (
      `${intro} ${ask} with \`onClosedMatch: "reopen"\` (reopen it and add this occurrence) ` +
      `or \`"create"\` (file a new item that links the closed one).${pin}`
    );
  }
  if (labels.some((label) => reopenLabels.includes(label))) {
    return (
      `${intro} It was closed without a confirmed fix, so this occurrence is new evidence. ` +
      `${ask} with \`onClosedMatch: "reopen"\`.${pin}`
    );
  }
  return (
    `${intro} It was closed with a resolution, so a recurrence is likely a regression. ` +
    `${ask} with \`onClosedMatch: "create"\` to file a new item that links it.${pin}`
  );
}

export function relatedToClosed(url: string): string {
  return `Related to the closed issue ${url}.`;
}
