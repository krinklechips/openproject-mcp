/**
 * Unit tests for the wiki page helpers. These cover the response shaping for
 * get_wiki_page and the markdown snippets returned after uploading files to a
 * wiki page — no live OpenProject instance required.
 */

import { describe, expect, test } from 'bun:test';
import { WIKI_API_LIMITATION, buildWikiAttachmentMarkdown, summarizeWikiPage } from '../src/wiki.ts';
import type { UploadedAttachmentResult } from '../src/attachments.ts';
import type { WikiPage } from '../src/openproject-client.ts';

function wikiPage(overrides: Partial<WikiPage> = {}): WikiPage {
  return {
    id: 42,
    title: 'Onboarding Guide',
    _links: {
      self: { href: '/api/v3/wiki_pages/42' },
      project: { href: '/api/v3/projects/80', title: 'Tonle Automation' },
      attachments: { href: '/api/v3/wiki_pages/42/attachments' },
    },
    ...overrides,
  };
}

describe('summarizeWikiPage', () => {
  test('extracts id, title, project and attachments link', () => {
    const summary = summarizeWikiPage(wikiPage());

    expect(summary.id).toBe(42);
    expect(summary.title).toBe('Onboarding Guide');
    expect(summary.projectId).toBe(80);
    expect(summary.project).toBe('Tonle Automation');
    expect(summary.attachmentsHref).toBe('/api/v3/wiki_pages/42/attachments');
  });

  test('always reports that page content is unavailable', () => {
    const summary = summarizeWikiPage(wikiPage());

    expect(summary.contentAvailable).toBe(false);
    expect(summary.note).toBe(WIKI_API_LIMITATION);
    // The note must keep saying writes are impossible, so an agent does not retry.
    expect(summary.note).toContain('cannot create, update, or delete');
  });

  test('falls back to a placeholder name when the project link has no title', () => {
    const summary = summarizeWikiPage(
      wikiPage({ _links: { project: { href: '/api/v3/projects/7' } } })
    );

    expect(summary.projectId).toBe(7);
    expect(summary.project).toBe('Project #7');
    expect(summary.attachmentsHref).toBeNull();
  });

  test('tolerates a page with no links at all', () => {
    const summary = summarizeWikiPage({ id: 3, title: 'Stub', _links: {} });

    expect(summary.projectId).toBeNull();
    expect(summary.project).toBeNull();
    expect(summary.attachmentsHref).toBeNull();
  });
});

describe('buildWikiAttachmentMarkdown', () => {
  const results: UploadedAttachmentResult[] = [
    { status: 'uploaded', id: 1, fileName: 'diagram.png', contentType: 'image/png', inline: false },
    { status: 'uploaded', id: 2, fileName: 'notes.md', contentType: 'text/markdown', inline: false },
    { status: 'failed', fileName: 'broken.pdf', contentType: 'application/pdf', inline: false, error: 'boom' },
  ];

  test('uses image syntax for images and link syntax for other files', () => {
    expect(buildWikiAttachmentMarkdown(results)).toEqual([
      '![diagram.png](/api/v3/attachments/1/content)',
      '[notes.md](/api/v3/attachments/2/content)',
    ]);
  });

  test('skips failed uploads and uploads without an id', () => {
    expect(buildWikiAttachmentMarkdown([results[2]!])).toEqual([]);
    expect(
      buildWikiAttachmentMarkdown([
        { status: 'uploaded', fileName: 'no-id.txt', contentType: 'text/plain', inline: false },
      ])
    ).toEqual([]);
  });

  test('returns an empty list when nothing was uploaded', () => {
    expect(buildWikiAttachmentMarkdown([])).toEqual([]);
  });
});
