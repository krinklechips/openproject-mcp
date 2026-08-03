/**
 * Wiki page helpers.
 *
 * OpenProject's API v3 wiki resource is a documented stub: `GET
 * /api/v3/wiki_pages/{id}` is the only verb, and its representer exposes just
 * `id`, `title`, the owning project and the page's attachments — the page body
 * (markdown) is not part of the API at all, and there is no create/update
 * endpoint. See OpenProject's API FAQ: "It is not possible to update wiki pages
 * via the API; only retrieving wiki page information is supported."
 *
 * These pure helpers shape that thin response into a predictable payload and
 * state the limitation explicitly, so a calling agent does not silently assume
 * it fetched page content or that a write is possible.
 */

import { isImageContentType, type UploadedAttachmentResult } from './attachments.ts';
import type { WikiPage } from './openproject-client.ts';

/** Explains what the OpenProject API does and does not expose for wiki pages. */
export const WIKI_API_LIMITATION =
  'OpenProject API v3 exposes wiki pages as metadata only (id, title, project, attachments). ' +
  'The page body/markdown is not available through the API, and the API cannot create, update, or delete wiki pages — ' +
  'use the OpenProject web UI for page content.';

export interface WikiPageSummary {
  id: number;
  title: string;
  projectId: number | null;
  project: string | null;
  /** API path for this page's attachment collection, when advertised. */
  attachmentsHref: string | null;
  /** Always false: the API never returns wiki page content. */
  contentAvailable: false;
  note: string;
}

function extractId(href: string | undefined, resource: string): number | null {
  if (!href) return null;
  const match = href.match(new RegExp(`/${resource}/(\\d+)(?:/|$)`));
  return match && match[1] ? Number(match[1]) : null;
}

/** Shape a raw wiki page HAL response into the summary returned by get_wiki_page. */
export function summarizeWikiPage(page: WikiPage): WikiPageSummary {
  const links = page._links ?? {};
  const projectId = extractId(links.project?.href, 'projects');

  return {
    id: page.id,
    title: page.title,
    projectId,
    project: links.project?.title ?? (projectId !== null ? `Project #${projectId}` : null),
    attachmentsHref: links.attachments?.href ?? null,
    contentAvailable: false,
    note: WIKI_API_LIMITATION,
  };
}

/**
 * Markdown snippets for files just uploaded to a wiki page. Wiki page bodies are
 * not writable through the API, so nothing is embedded automatically — these are
 * handed back for a human to paste into the page in the web UI. Images use image
 * syntax, everything else a plain link.
 */
export function buildWikiAttachmentMarkdown(results: UploadedAttachmentResult[]): string[] {
  return results
    .filter((result) => result.status === 'uploaded' && typeof result.id === 'number')
    .map((result) => {
      const href = `/api/v3/attachments/${result.id}/content`;
      const prefix = isImageContentType(result.contentType) ? '!' : '';
      return `${prefix}[${result.fileName}](${href})`;
    });
}
