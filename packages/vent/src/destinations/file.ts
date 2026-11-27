import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { formatFileOccurrence, formatFileSection } from '../format.ts';
import { buildMatchQuery, findBestMatch } from '../match.ts';
import { canonicalizePath, expandHome, type FileDestination } from '../options.ts';
import type { VentInput, VentMetadata, VentResult } from './types.ts';

export interface MarkdownSection {
  id: string;
  title: string;
  body: string;
  startLine: number;
  endLine: number;
}

const DEFAULT_HEADER = '# Agent vents\n';
const STALE_LOCK_MS = 30_000;

const fileLocks = new Map<string, Promise<unknown>>();

function withFileLock<T>(filePath: string, task: () => Promise<T>): Promise<T> {
  const key = canonicalizePath(filePath);
  const previous = fileLocks.get(key) ?? Promise.resolve();
  const next = previous.then(task, task);
  const cleanup = next.then(
    () => {
      if (fileLocks.get(key) === cleanup) fileLocks.delete(key);
    },
    () => {
      if (fileLocks.get(key) === cleanup) fileLocks.delete(key);
    },
  );
  fileLocks.set(key, cleanup);
  return next;
}

async function withCrossProcessLock<T>(
  filePath: string,
  signal: AbortSignal | undefined,
  task: (canonicalTarget: string) => Promise<T>,
): Promise<T> {
  const canonical = canonicalizePath(filePath);
  const lockPath = `${canonical}.lock`;
  const lockToken = randomUUID();
  await mkdir(dirname(canonical), { recursive: true });

  while (true) {
    signal?.throwIfAborted();
    try {
      const handle = await open(lockPath, 'wx');
      try {
        await handle.writeFile(lockToken, 'utf8');
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;
      try {
        const lockStat = await lstat(lockPath);
        if (Date.now() - lockStat.mtimeMs > STALE_LOCK_MS) {
          await unlink(lockPath).catch(() => {});
        }
      } catch {
        // Wait before retrying if the lock was concurrently removed or unreadable.
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  try {
    signal?.throwIfAborted();
    return await task(canonical);
  } finally {
    try {
      const currentOwner = await readFile(lockPath, 'utf8');
      if (currentOwner === lockToken) {
        await unlink(lockPath).catch(() => {});
      }
    } catch {
      // Lock was already removed.
    }
  }
}

async function writeAtomicFile(
  filePath: string,
  content: string,
  signal: AbortSignal | undefined,
  mode?: number,
): Promise<void> {
  signal?.throwIfAborted();
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, content, {
      encoding: 'utf8',
      flag: 'wx',
      ...(mode !== undefined ? { mode } : {}),
    });
    signal?.throwIfAborted();
    await rename(tempPath, filePath);
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }
}

export function parseMarkdownSections(content: string): MarkdownSection[] {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  const sections: MarkdownSection[] = [];
  let fenceChar: '`' | '~' | undefined;
  let fenceLength = 0;

  let currentStart = -1;
  let currentTitle = '';

  const closeCurrent = (endLine: number) => {
    if (currentStart < 0) return;
    sections.push({
      id: `line:${currentStart + 1}`,
      title: currentTitle,
      body: lines
        .slice(currentStart + 1, endLine)
        .join('\n')
        .trim(),
      startLine: currentStart,
      endLine,
    });
    currentStart = -1;
    currentTitle = '';
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;

    if (fenceChar) {
      if (new RegExp(`^[ ]{0,3}${fenceChar}{${fenceLength},}[ \\t]*$`).test(line)) {
        fenceChar = undefined;
        fenceLength = 0;
      }
      continue;
    }

    const openFence = line.match(/^[ ]{0,3}(`{3,}|~{3,})(.*)$/);
    if (openFence && (openFence[1]![0] !== '`' || !openFence[2]!.includes('`'))) {
      fenceChar = openFence[1]![0] as '`' | '~';
      fenceLength = openFence[1]!.length;
      continue;
    }

    const headingMatch = line.match(/^##\s+(.+?)\s*$/);
    if (headingMatch) {
      closeCurrent(i);
      currentStart = i;
      currentTitle = headingMatch[1]!;
    }
  }

  closeCurrent(lines.length);
  return sections;
}

export async function ventToFile(
  destinationName: string,
  destination: FileDestination,
  input: VentInput,
  metadata: VentMetadata,
  deps: { threshold: number; home?: string; signal?: AbortSignal },
): Promise<VentResult> {
  deps.signal?.throwIfAborted();
  const resolvedPath = expandHome(destination.path, deps.home);

  return withFileLock(resolvedPath, () =>
    withCrossProcessLock(resolvedPath, deps.signal, async (targetPath) => {
      let existing: string;
      let existingMode: number | undefined;
      try {
        const existingStat = await stat(targetPath);
        existingMode = existingStat.mode & 0o777;
        existing = (await readFile(targetPath, 'utf8')).replace(/\r\n?/g, '\n');
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') throw error;
        existing = DEFAULT_HEADER;
      }

      const sections = parseMarkdownSections(existing);
      const match = findBestMatch(buildMatchQuery(input), sections, deps.threshold);

      let updated: string;
      if (match) {
        const section = match.item;
        const lines = existing.split('\n');
        let insertAt = section.endLine;
        while (insertAt > section.startLine + 1 && lines[insertAt - 1]?.trim() === '') {
          insertAt -= 1;
        }

        const occurrenceLines = ['', ...formatFileOccurrence(input, metadata).split('\n')];
        const hasFollowingSection = section.endLine < lines.length;
        if (hasFollowingSection) {
          occurrenceLines.push('');
        }

        const nextLines = [
          ...lines.slice(0, insertAt),
          ...occurrenceLines,
          ...lines.slice(section.endLine),
        ];
        updated = `${nextLines.join('\n').replace(/\n+$/, '')}\n`;

        await writeAtomicFile(targetPath, updated, deps.signal, existingMode);

        return {
          action: 'commented',
          destination: destinationName,
          destinationType: 'file',
          path: resolvedPath,
          title: input.title,
          matchedTitle: section.title,
          matchScore: Number(match.score.toFixed(2)),
        };
      }

      const base = existing.trimEnd();
      const prefix = base ? `${base}\n\n` : `${DEFAULT_HEADER}\n`;
      updated = `${prefix}${formatFileSection(input, metadata)}\n`;

      await writeAtomicFile(targetPath, updated, deps.signal, existingMode);

      return {
        action: 'created',
        destination: destinationName,
        destinationType: 'file',
        path: resolvedPath,
        title: input.title,
      };
    }),
  );
}
