import { describe, expect, test } from 'bun:test';
import type { CommentDetail } from '../../forge';
import { MAX_LINK_LENGTH, MAX_LINKED_NOTES } from '../../review-summary';
import type { GraphQL } from './adapter';
import { fetchLinkedNote, linkedNotes, parseNoteLink } from './linked-notes';

const HOST = 'gitlab.com';
// The real example: a review on one project links to an issue note in another.
const ISSUE_NOTE = 'https://gitlab.com/gitlab-org/orbit/agents/-/issues/168#note_4109406715';

const detail = (id: string, body: string): CommentDetail => ({
  id,
  url: `https://gitlab.com/gitlab-org/gitlab/-/merge_requests/265873#note_${id}`,
  username: 'dgruzd',
  body,
});

describe('parseNoteLink', () => {
  test('accepts issue, work item, and MR notes on the host, in canonical form', () => {
    expect(parseNoteLink(ISSUE_NOTE, HOST)).toEqual({
      url: ISSUE_NOTE,
      project: 'gitlab-org/orbit/agents',
      resource: 'issue',
      iid: '168',
      noteID: '4109406715',
    });
    expect(parseNoteLink('https://gitlab.com/g/p/-/work_items/2#note_3', HOST)?.resource).toBe(
      'issue',
    );
    expect(
      parseNoteLink('https://GITLAB.com/g/p/-/merge_requests/2/diffs?x=1#note_3', HOST),
    ).toEqual({
      url: 'https://gitlab.com/g/p/-/merge_requests/2#note_3',
      project: 'g/p',
      resource: 'merge_request',
      iid: '2',
      noteID: '3',
    });
  });

  test('rejects anything else', () => {
    for (const link of [
      'http://gitlab.com/g/p/-/issues/1#note_2',
      'https://evil.example/g/p/-/issues/1#note_2',
      'https://gitlab.com.evil.example/g/p/-/issues/1#note_2',
      'https://gitlab.com:8443/g/p/-/issues/1#note_2',
      'https://user:token@gitlab.com/g/p/-/issues/1#note_2',
      'https://gitlab.com/g/p/-/issues/1',
      'https://gitlab.com/g/p/-/issues/1#note_x',
      'https://gitlab.com/g/p/-/issues/1#note_2_3',
      'https://gitlab.com/g/p/-/issues/1/diffs#note_2',
      'https://gitlab.com/groups/g/-/epics/1#note_2',
      'https://gitlab.com/g/p/-/snippets/1#note_2',
      'https://gitlab.com/api/v4/projects/1/issues/1/notes#note_2',
      'javascript:alert(1)//gitlab.com/g/p/-/issues/1#note_2',
      'not a url',
    ])
      expect(parseNoteLink(link, HOST)).toBeUndefined();
  });
});

describe('linkedNotes', () => {
  test("collects note links from comments' own text, without duplicates or the comments themselves", () => {
    const details = [
      detail(
        '1',
        `See [Further details](${ISSUE_NOTE}). Also https://gitlab.com/gitlab-org/orbit/agents/-/work_items/168#note_4109406715.`,
      ),
      detail(
        '2',
        'Same as https://gitlab.com/gitlab-org/gitlab/-/merge_requests/265873#note_1, and https://evil.example/g/p/-/issues/1#note_9, and https://gitlab.com/g/p/-/merge_requests/4#note_5!',
      ),
    ];
    details[1].replies = [{ username: 'x', body: 'https://gitlab.com/g/p/-/issues/9#note_9' }];
    expect(linkedNotes(HOST, details)).toEqual([
      ISSUE_NOTE,
      'https://gitlab.com/g/p/-/merge_requests/4#note_5',
    ]);
  });

  test('skips links too long to list', () => {
    const long = `https://gitlab.com/${'a'.repeat(MAX_LINK_LENGTH)}/-/issues/1#note_2`;
    const huge = `https://gitlab.com/${'a'.repeat(50_000)}/-/issues/1#note_2`;
    expect(parseNoteLink(long, HOST)).toBeUndefined();
    expect(linkedNotes(HOST, [detail('1', `${long} ${huge} ${ISSUE_NOTE}`)])).toEqual([ISSUE_NOTE]);
  });

  test('keeps at most a few links', () => {
    const body = Array.from(
      { length: MAX_LINKED_NOTES + 3 },
      (_, index) => `https://gitlab.com/g/p/-/issues/${index + 1}#note_${index + 100}`,
    ).join(' ');
    expect(linkedNotes(HOST, [detail('1', body)])).toHaveLength(MAX_LINKED_NOTES);
  });
});

describe('fetchLinkedNote', () => {
  const responding =
    (note: unknown, seen: unknown[] = []): GraphQL =>
    async (host, query, variables) => {
      seen.push({ host, query, variables });
      return { note };
    };

  test('reads the note through one fixed query, and accepts its work item URL', async () => {
    const seen: unknown[] = [];
    const transport = responding(
      {
        id: 'gid://gitlab/Note/4109406715',
        url: 'https://gitlab.com/gitlab-org/orbit/agents/-/work_items/168#note_4109406715',
        body: 'Details',
        author: { username: 'dgruzd' },
      },
      seen,
    );
    expect(await fetchLinkedNote(transport, HOST, ISSUE_NOTE)).toEqual({
      url: ISSUE_NOTE,
      username: 'dgruzd',
      body: 'Details',
    });
    expect(seen).toEqual([
      {
        host: HOST,
        query: expect.stringContaining('note(id: $id)'),
        variables: { id: 'gid://gitlab/Note/4109406715' },
      },
    ]);
  });

  test('accepts every note type GitLab answers with, but not other objects', async () => {
    const answer = (id: string) =>
      responding({
        id,
        url: 'https://gitlab.com/gitlab-org/orbit/agents/-/work_items/168#note_4109406715',
        body: 'Details',
        author: { username: 'dgruzd' },
      });
    for (const type of ['Note', 'DiffNote', 'DiscussionNote', 'LegacyDiffNote'])
      expect(
        await fetchLinkedNote(answer(`gid://gitlab/${type}/4109406715`), HOST, ISSUE_NOTE),
      ).toMatchObject({ body: 'Details' });
    for (const id of [
      'gid://gitlab/Issue/4109406715',
      'gid://gitlab/DiffNote/41094067150',
      'gid://other/Note/4109406715',
      '4109406715',
    ])
      expect(await fetchLinkedNote(answer(id), HOST, ISSUE_NOTE)).toBeUndefined();
  });

  test('rejects notes that belong to another resource, and notes it cannot read', async () => {
    const note = (url: string, id = 'gid://gitlab/Note/4109406715') => ({
      id,
      url,
      body: 'Secret',
      author: { username: 'someone' },
    });
    for (const response of [
      null,
      note('https://gitlab.com/gitlab-org/other/-/issues/168#note_4109406715'),
      note('https://gitlab.com/gitlab-org/orbit/agents/-/issues/169#note_4109406715'),
      note('https://gitlab.com/gitlab-org/orbit/agents/-/merge_requests/168#note_4109406715'),
      note('https://evil.example/gitlab-org/orbit/agents/-/issues/168#note_4109406715'),
      note(ISSUE_NOTE, 'gid://gitlab/Note/1'),
      { ...note(ISSUE_NOTE), author: null },
    ])
      expect(await fetchLinkedNote(responding(response), HOST, ISSUE_NOTE)).toBeUndefined();
  });

  test('reads only canonical links on its host, without a request otherwise', async () => {
    const seen: unknown[] = [];
    const transport = responding(null, seen);
    for (const link of [
      'https://evil.example/gitlab-org/orbit/agents/-/issues/168#note_4109406715',
      `${ISSUE_NOTE.replace('#', '?x=1#')}`,
      'https://gitlab.com/g/p/-/merge_requests/2/diffs#note_3',
    ])
      expect(await fetchLinkedNote(transport, HOST, link)).toBeUndefined();
    expect(seen).toEqual([]);
  });
});
