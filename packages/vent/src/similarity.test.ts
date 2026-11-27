import { describe, expect, test } from 'bun:test';
import { formatIssueBody } from './format.ts';
import { buildMatchQuery, extractIdentifiers, findBestMatch, similarityScore } from './match.ts';
import { sampleInput, sampleMetadata } from './testing.ts';

describe('similarity matching', () => {
  test('matches recurring friction with paraphrased title and shared identifier', () => {
    const candidates = [
      {
        id: '1',
        title: 'Permission prompt on `glab api` with pagination flag',
        body: 'Calling `glab api --paginate` asks for approval on GET requests.',
      },
      {
        id: '2',
        title: 'Slow test suite startup on macOS',
        body: 'Running integration specs takes two minutes to boot Docker.',
      },
    ];

    const match = findBestMatch(
      { title: sampleInput.title, body: sampleInput.friction },
      candidates,
      0.45,
    );
    expect(match?.item.id).toBe('1');
    expect(match!.score).toBeGreaterThanOrEqual(0.45);
  });

  test('does not match unrelated frictions', () => {
    const score = similarityScore(
      {
        title: 'Broken symlink after running dotfiles bootstrap',
        body: 'Bootstrap script leaves a dangling link in ~/.local/bin.',
      },
      {
        title: 'ClickHouse query timeout on CI pipeline metrics',
        body: 'Querying build duration over 90 days times out after 30 seconds.',
      },
    );
    expect(score).toBeLessThan(0.2);
  });

  test('ignores backticked session metadata inside <details> blocks', () => {
    const metadataBlock = formatIssueBody(
      {
        title: 'ClickHouse query timeout',
        friction: 'Querying build duration times out.',
        context: 'Checking dashboard latency.',
      },
      sampleMetadata,
    );
    expect(extractIdentifiers(metadataBlock).size).toBe(0);

    const score = similarityScore(
      {
        title: 'Broken symlink after bootstrap',
        body: formatIssueBody(
          {
            title: 'Broken symlink after bootstrap',
            friction: 'Bootstrap script leaves a dangling link.',
            context: 'Running dotfiles setup.',
          },
          sampleMetadata,
        ),
      },
      {
        title: 'ClickHouse query timeout',
        body: metadataBlock,
      },
    );
    expect(score).toBeLessThan(0.1);
  });

  test('includes evidence identifiers when building a match query', () => {
    const query = buildMatchQuery({
      title: 'Linter fails to start from shell',
      friction: 'Running the markdown linter fails with a shim version error.',
      evidence: 'Invoking `markdownlint-cli2` prints `No version is set for shim`.',
    });
    const ids = extractIdentifiers(`${query.title}\n${query.body}`);
    expect(ids.has('markdownlint-cli2')).toBe(true);
    expect(ids.has('no version is set for shim')).toBe(true);
  });

  test('matches identical and overlapping non-Latin Unicode titles', () => {
    expect(
      similarityScore(
        { title: '設定画面が開かない', body: 'クリックしても反応しない' },
        { title: '設定画面が開かない', body: '別の説明' },
      ),
    ).toBe(1);

    expect(
      similarityScore(
        { title: '設定画面でエラーが発生する', body: '設定画面を開くとクラッシュする' },
        { title: '設定画面でエラーが発生する問題', body: '設定画面を開くと失敗する' },
      ),
    ).toBeGreaterThan(0.3);
  });
});
