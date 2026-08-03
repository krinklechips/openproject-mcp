/**
 * Session-backed wiki page writer.
 *
 * OpenProject's API v3 cannot read a wiki page's body or write pages at all —
 * `GET /api/v3/wiki_pages/{id}` is the only wiki verb it defines (see
 * `src/wiki.ts`). The web UI's own Rails endpoints *can* do all of it, so this
 * module drives those the way a browser would: form login, then submit the same
 * forms the UI submits.
 *
 *   read   GET  /projects/:project/wiki/:slug.markdown   → raw markdown body
 *   create POST /projects/:project/wiki/new              → page[title], page[text]
 *   update PUT  /projects/:project/wiki/:slug            → + page[lock_version]
 *
 * Rather than hardcoding form fields, every request re-fetches the real form and
 * replays *all* of its inputs (`authenticity_token`, `_method`, `lock_version`,
 * `parent_id`, …), overriding only the values being changed. That keeps the
 * writer working across OpenProject versions that add or rename hidden fields,
 * and keeps CSRF and optimistic locking correct by construction.
 *
 * This needs a real username and password — an API key authenticates `/api/v3`
 * only and is rejected by these routes. Accounts behind 2FA or SSO cannot be
 * used, and that is reported as a clear error rather than a generic failure.
 */

import * as fs from 'fs';

export interface WikiSessionConfig {
  baseUrl: string;
  username: string;
  password: string;
  timeout?: number;
  /** Injectable fetch, for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/** A parsed HTML form: where to submit it and every field it would send. */
export interface ParsedForm {
  action: string | null;
  method: string;
  fields: Record<string, string>;
}

export interface WikiPageResult {
  title: string;
  slug: string;
  projectRef: string;
  url: string;
  markdown: string;
}

const DEFAULT_TIMEOUT = 30000;

/** Decode the handful of HTML entities that appear in form values. */
function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&amp;/g, '&');
}

function attribute(tag: string, name: string): string | undefined {
  const match =
    tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i')) ??
    tag.match(new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`, 'i'));
  return match ? decodeEntities(match[1] ?? '') : undefined;
}

/**
 * Isolate one `<form>` element from a page. `predicate` picks the form when a
 * page has several (the OpenProject layout always ships a logout form, and the
 * login page carries a registration form too).
 */
export function extractForm(html: string, predicate: (formHtml: string) => boolean): string | null {
  const formPattern = /<form\b[\s\S]*?<\/form>/gi;
  for (const match of html.matchAll(formPattern)) {
    const formHtml = match[0];
    if (predicate(formHtml)) return formHtml;
  }
  return null;
}

/**
 * Read a form's submit target and its complete field set: inputs (skipping
 * unchecked checkboxes/radios and submit buttons), textareas, and the selected
 * option of each select.
 */
export function parseForm(formHtml: string): ParsedForm {
  const openingTag = formHtml.match(/<form\b[^>]*>/i)?.[0] ?? '';
  const fields: Record<string, string> = {};

  for (const match of formHtml.matchAll(/<input\b[^>]*>/gi)) {
    const tag = match[0];
    const name = attribute(tag, 'name');
    if (!name) continue;

    const type = (attribute(tag, 'type') ?? 'text').toLowerCase();
    if (type === 'submit' || type === 'button' || type === 'image' || type === 'file') continue;
    // A browser only submits checked checkboxes/radios.
    if ((type === 'checkbox' || type === 'radio') && !/\bchecked\b/i.test(tag)) continue;

    fields[name] = attribute(tag, 'value') ?? '';
  }

  for (const match of formHtml.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi)) {
    const name = attribute(`<textarea ${match[1] ?? ''}>`, 'name');
    if (name) fields[name] = decodeEntities(match[2] ?? '');
  }

  for (const match of formHtml.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
    const name = attribute(`<select ${match[1] ?? ''}>`, 'name');
    if (!name) continue;
    const options = [...(match[2] ?? '').matchAll(/<option\b([^>]*)>/gi)];
    const selected = options.find((option) => /\bselected\b/i.test(option[1] ?? '')) ?? options[0];
    if (selected) fields[name] = attribute(`<option ${selected[1] ?? ''}>`, 'value') ?? '';
  }

  return {
    action: attribute(openingTag, 'action') ?? null,
    method: (attribute(openingTag, 'method') ?? 'post').toLowerCase(),
    fields,
  };
}

/** Pull the Rails error list out of a re-rendered form page, if present. */
export function extractFormErrors(html: string): string[] {
  const block = html.match(/<div[^>]*\bid=["']errorExplanation["'][\s\S]*?<\/div>/i)?.[0]
    ?? html.match(/<div[^>]*class=["'][^"']*errorExplanation[^"']*["'][\s\S]*?<\/div>/i)?.[0];
  if (!block) return [];

  return [...block.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)]
    .map((match) => decodeEntities((match[1] ?? '').replace(/<[^>]+>/g, '').trim()))
    .filter((message) => message !== '');
}

/** Turn a page title into the slug OpenProject uses in wiki URLs. */
export function wikiSlug(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Merge `Set-Cookie` headers from a response into a cookie jar. */
export function updateCookies(jar: Map<string, string>, response: { headers: Headers }): void {
  const raw = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter((value): value is string => typeof value === 'string');

  for (const cookie of raw) {
    const pair = cookie.split(';')[0] ?? '';
    const index = pair.indexOf('=');
    if (index <= 0) continue;
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    // An expired cookie clears the entry, matching browser behaviour on logout.
    if (/;\s*max-age=0\b/i.test(cookie)) jar.delete(name);
    else jar.set(name, value);
  }
}

export function cookieHeader(jar: Map<string, string>): string {
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

/** Read wiki markdown from a local file, validating it is usable text. */
export async function readMarkdownFile(filePath: string): Promise<string> {
  let content: string;
  try {
    content = await fs.promises.readFile(filePath, 'utf8');
  } catch (error) {
    throw new Error(`Could not read markdown file "${filePath}": ${error instanceof Error ? error.message : String(error)}`);
  }
  if (content.trim() === '') {
    throw new Error(`Markdown file "${filePath}" is empty`);
  }
  return content;
}

/**
 * Resolve the wiki body for a write tool: exactly one of a local markdown file
 * or an inline markdown string.
 */
export async function resolveMarkdownInput(input: { markdown?: string; filePath?: string }): Promise<string> {
  const hasMarkdown = typeof input.markdown === 'string' && input.markdown.trim() !== '';
  const hasPath = typeof input.filePath === 'string' && input.filePath.trim() !== '';

  if (!hasMarkdown && !hasPath) {
    throw new Error('Provide the page body as either "markdown" or "filePath"');
  }
  if (hasMarkdown && hasPath) {
    throw new Error('Provide only one of "markdown" or "filePath", not both');
  }

  return hasPath ? readMarkdownFile(input.filePath!.trim()) : input.markdown!;
}

export class OpenProjectWikiSession {
  private readonly baseUrl: string;
  private readonly username: string;
  private readonly password: string;
  private readonly timeout: number;
  private readonly fetchImpl: typeof fetch;
  private readonly cookies = new Map<string, string>();
  private loggedIn = false;

  constructor(config: WikiSessionConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.username = config.username;
    this.password = config.password;
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  private url(pathOrUrl: string): string {
    if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
    return `${this.baseUrl}${pathOrUrl.startsWith('/') ? '' : '/'}${pathOrUrl}`;
  }

  /**
   * Perform one request with the cookie jar attached, never auto-following
   * redirects: Rails signals success on these forms with a 302, and the target
   * carries the created/updated page's slug.
   */
  private async request(
    method: string,
    pathOrUrl: string,
    body?: URLSearchParams
  ): Promise<{ status: number; location: string | null; text: string }> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const headers: Record<string, string> = { Accept: 'text/html,application/xhtml+xml' };
      const cookie = cookieHeader(this.cookies);
      if (cookie) headers.Cookie = cookie;
      if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded';

      const response = await this.fetchImpl(this.url(pathOrUrl), {
        method,
        headers,
        body: body ? body.toString() : undefined,
        redirect: 'manual',
        signal: controller.signal,
      });

      updateCookies(this.cookies, response);

      return {
        status: response.status,
        location: response.headers.get('location'),
        text: response.status === 302 || response.status === 303 ? '' : await response.text(),
      };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Wiki request timed out after ${this.timeout}ms: ${method} ${pathOrUrl}`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /** Log in through the web form, establishing the session cookie. */
  async login(): Promise<void> {
    if (this.loggedIn) return;

    const loginPage = await this.request('GET', '/login');
    const formHtml = extractForm(loginPage.text, (form) => /name=["']username["']/i.test(form));
    if (!formHtml) {
      throw new Error(
        'Could not find the OpenProject login form. If this instance uses SSO/OmniAuth, session-based wiki writing is not available.'
      );
    }

    const form = parseForm(formHtml);
    const body = new URLSearchParams({ ...form.fields, username: this.username, password: this.password });
    const result = await this.request('POST', form.action ?? '/login', body);

    // A successful login redirects; a failed one re-renders the form with a flash.
    if (result.status === 302 || result.status === 303) {
      if (result.location && /\/login\/otp|two_factor|\/login\/consent/i.test(result.location)) {
        throw new Error(
          'Login requires an additional step (two-factor authentication or consent). Session-based wiki writing needs an account without 2FA/SSO.'
        );
      }
      this.loggedIn = true;
      return;
    }

    if (/name=["']username["']/i.test(result.text)) {
      throw new Error('OpenProject rejected the wiki credentials (invalid username or password).');
    }

    throw new Error(`Unexpected login response (HTTP ${result.status}).`);
  }

  /** Fetch a wiki page's raw markdown body. */
  async getPageMarkdown(projectRef: string | number, slug: string): Promise<string> {
    await this.login();
    const result = await this.request('GET', `/projects/${projectRef}/wiki/${slug}.markdown`);

    if (result.status === 200) return result.text;
    if (result.status === 404) throw new Error(`Wiki page "${slug}" was not found in project ${projectRef}`);
    if (result.status === 403) throw new Error(`Not permitted to view wiki page "${slug}" in project ${projectRef}`);
    throw new Error(`Could not read wiki page "${slug}" (HTTP ${result.status})`);
  }

  /**
   * Submit a wiki form (create or update) and resolve the resulting page.
   * `formUrl` is the page carrying the form; `overrides` are the fields to set.
   */
  private async submitPageForm(
    projectRef: string | number,
    formUrl: string,
    overrides: Record<string, string>,
    action: 'create' | 'update'
  ): Promise<{ slug: string }> {
    const page = await this.request('GET', formUrl);
    if (page.status === 403) {
      throw new Error(`Not permitted to ${action} wiki pages in project ${projectRef} (needs the "edit wiki pages" permission).`);
    }
    if (page.status === 404) {
      throw new Error(
        `Could not open the wiki form at ${formUrl} (HTTP 404). Check the project reference and that its wiki module is enabled.`
      );
    }

    const formHtml = extractForm(page.text, (form) => /id=["']wiki_form["']/i.test(form));
    if (!formHtml) {
      if (/name=["']username["']/i.test(page.text)) {
        throw new Error('The wiki session expired or was rejected. Check the configured wiki credentials.');
      }
      throw new Error(`Could not find the wiki editor form at ${formUrl}.`);
    }

    const form = parseForm(formHtml);
    const body = new URLSearchParams({ ...form.fields, ...overrides });
    const result = await this.request('POST', form.action ?? formUrl, body);

    if (result.status === 302 || result.status === 303) {
      const slug = (result.location ?? '').split('/wiki/')[1]?.split(/[?#]/)[0] ?? '';
      return { slug: decodeURIComponent(slug) };
    }

    const errors = extractFormErrors(result.text);
    if (errors.length > 0) {
      throw new Error(`OpenProject rejected the wiki page: ${errors.join('; ')}`);
    }
    throw new Error(`Wiki ${action} failed (HTTP ${result.status}).`);
  }

  /** Create a wiki page with a markdown body. */
  async createPage(options: {
    projectRef: string | number;
    title: string;
    markdown: string;
    parentId?: number;
    journalNotes?: string;
  }): Promise<WikiPageResult> {
    await this.login();

    const overrides: Record<string, string> = {
      'page[title]': options.title,
      'page[text]': options.markdown,
    };
    if (options.parentId !== undefined) overrides['page[parent_id]'] = String(options.parentId);
    if (options.journalNotes) overrides['page[journal_notes]'] = options.journalNotes;

    const { slug } = await this.submitPageForm(
      options.projectRef,
      `/projects/${options.projectRef}/wiki/new`,
      overrides,
      'create'
    );

    const resolvedSlug = slug || wikiSlug(options.title);
    return {
      title: options.title,
      slug: resolvedSlug,
      projectRef: String(options.projectRef),
      url: `${this.baseUrl}/projects/${options.projectRef}/wiki/${resolvedSlug}`,
      markdown: await this.getPageMarkdown(options.projectRef, resolvedSlug),
    };
  }

  /**
   * Update an existing wiki page. The edit form supplies the current
   * `lock_version`, so a concurrent edit is rejected by OpenProject rather than
   * silently overwritten.
   */
  async updatePage(options: {
    projectRef: string | number;
    slug: string;
    markdown?: string;
    title?: string;
    journalNotes?: string;
  }): Promise<WikiPageResult> {
    await this.login();

    const overrides: Record<string, string> = {};
    if (options.markdown !== undefined) overrides['page[text]'] = options.markdown;
    if (options.title !== undefined) overrides['page[title]'] = options.title;
    if (options.journalNotes) overrides['page[journal_notes]'] = options.journalNotes;

    if (Object.keys(overrides).length === 0) {
      throw new Error('Nothing to update: provide markdown/filePath or a new title');
    }

    const { slug } = await this.submitPageForm(
      options.projectRef,
      `/projects/${options.projectRef}/wiki/${options.slug}/edit`,
      overrides,
      'update'
    );

    const resolvedSlug = slug || (options.title ? wikiSlug(options.title) : options.slug);
    return {
      title: options.title ?? resolvedSlug,
      slug: resolvedSlug,
      projectRef: String(options.projectRef),
      url: `${this.baseUrl}/projects/${options.projectRef}/wiki/${resolvedSlug}`,
      markdown: await this.getPageMarkdown(options.projectRef, resolvedSlug),
    };
  }
}

/**
 * Build a wiki session from the environment. Returns null when credentials are
 * absent, so the wiki write tools can explain what to configure instead of
 * failing with a generic error.
 */
export function createWikiSession(): OpenProjectWikiSession | null {
  const baseUrl = process.env.OPENPROJECT_URL;
  const username = process.env.OPENPROJECT_USERNAME;
  const password = process.env.OPENPROJECT_PASSWORD;

  if (!baseUrl || !username || !password) return null;

  return new OpenProjectWikiSession({
    baseUrl,
    username,
    password,
    timeout: process.env.OPENPROJECT_TIMEOUT ? parseInt(process.env.OPENPROJECT_TIMEOUT) : DEFAULT_TIMEOUT,
  });
}

export const WIKI_CREDENTIALS_MISSING =
  'Wiki writing needs a web session: set OPENPROJECT_USERNAME and OPENPROJECT_PASSWORD (an API key cannot create or edit wiki pages — ' +
  'OpenProject API v3 has no endpoint for it). Use an account with the "edit wiki pages" permission and without 2FA/SSO.';
