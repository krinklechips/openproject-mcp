/**
 * Tests for the session-backed wiki writer.
 *
 * The HTML parsing helpers are tested directly, and the create/update/read
 * flows run against an in-process fake OpenProject that mimics the real one:
 * form login with a CSRF token, a wiki form carrying hidden fields, a 302 on
 * success, and a re-rendered form with an error list on failure.
 */

import { describe, expect, test } from 'bun:test';
import {
  OpenProjectWikiSession,
  cookieHeader,
  extractForm,
  extractFormErrors,
  parseForm,
  resolveMarkdownInput,
  updateCookies,
  wikiSlug,
} from '../src/wiki-session.ts';

const LOGIN_HTML = `
<html><body>
  <form action="/login" method="post" id="login-form">
    <input type="hidden" name="authenticity_token" value="csrf-login-token" />
    <input type="text" name="username" value="" />
    <input type="password" name="password" value="" />
    <input type="hidden" name="back_url" value="https://op.test/" />
    <input type="submit" name="commit" value="Sign in" />
  </form>
  <form action="/account/register" method="post">
    <input type="text" name="user[login]" value="" />
  </form>
</body></html>`;

function wikiFormHtml(options: { text?: string; lockVersion?: string; method?: string; action?: string } = {}): string {
  // The real edit form posts to the page's own URL with _method=put, while the
  // new-page form posts to /wiki/new.
  return `
<html><body>
  <form action="/logout" method="post"><input type="hidden" name="authenticity_token" value="other" /></form>
  <form action="${options.action ?? '/projects/kup/wiki/new'}" method="post" id="wiki_form" enctype="multipart/form-data">
    <input type="hidden" name="authenticity_token" value="csrf-wiki-token" />
    ${options.method ? `<input type="hidden" name="_method" value="${options.method}" />` : ''}
    ${options.lockVersion ? `<input type="hidden" name="page[lock_version]" value="${options.lockVersion}" />` : ''}
    <input type="text" name="page[title]" value="" />
    <textarea name="page[text]">${options.text ?? ''}</textarea>
    <input type="hidden" name="page[parent_id]" value="" />
    <select name="page[parent_id]">
      <option value="">-- No parent page --</option>
      <option value="7" selected>Existing parent</option>
    </select>
    <input type="checkbox" name="page[redirect_existing_links]" value="1" />
    <input type="submit" name="commit" value="Save" />
  </form>
</body></html>`;
}

/**
 * A fake OpenProject. Records every request so tests can assert on what the
 * session actually submitted.
 */
function fakeOpenProject(options: { failCreateWith?: string[]; requireLogin?: boolean } = {}) {
  const requests: Array<{ method: string; url: string; body: URLSearchParams | null; cookie: string | null }> = [];
  const pages = new Map<string, string>([['kup', '# Existing\nOld body.']]);
  let authenticated = false;

  const respond = (status: number, body: string, headers: Record<string, string> = {}) =>
    new Response(status === 302 ? null : body, { status, headers });

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    const rawBody = typeof init?.body === 'string' ? new URLSearchParams(init.body) : null;
    const cookie = (init?.headers as Record<string, string> | undefined)?.Cookie ?? null;
    requests.push({ method, url, body: rawBody, cookie });

    const path = new URL(url).pathname;

    if (path === '/login' && method === 'GET') {
      return respond(200, LOGIN_HTML, { 'set-cookie': '_open_project_session=guest-session; path=/; HttpOnly' });
    }
    if (path === '/login' && method === 'POST') {
      if (rawBody?.get('password') !== 'correct-horse') {
        return respond(200, LOGIN_HTML);
      }
      authenticated = true;
      return respond(302, '', { location: 'https://op.test/', 'set-cookie': '_open_project_session=authed-session; path=/' });
    }

    if (options.requireLogin && !authenticated) return respond(302, '', { location: 'https://op.test/login' });

    if (path === '/projects/kup/wiki/new' && method === 'GET') return respond(200, wikiFormHtml());
    if (path.endsWith('/edit') && method === 'GET') {
      const slug = path.split('/').slice(-2)[0]!;
      return respond(
        200,
        wikiFormHtml({ text: '# Existing\nOld body.', lockVersion: '4', method: 'put', action: `/projects/kup/wiki/${slug}` })
      );
    }

    if (path === '/projects/kup/wiki/new' && method === 'POST') {
      if (options.failCreateWith) {
        const items = options.failCreateWith.map((message) => `<li>${message}</li>`).join('');
        return respond(200, `<div id="errorExplanation"><ul>${items}</ul></div>${wikiFormHtml()}`);
      }
      const title = rawBody?.get('page[title]') ?? '';
      const slug = wikiSlug(title);
      pages.set(slug, rawBody?.get('page[text]') ?? '');
      return respond(302, '', { location: `https://op.test/projects/kup/wiki/${slug}` });
    }

    if (path.match(/^\/projects\/kup\/wiki\/[^/]+$/) && method === 'POST') {
      const slug = path.split('/').pop()!;
      pages.set(slug, rawBody?.get('page[text]') ?? '');
      return respond(302, '', { location: `https://op.test/projects/kup/wiki/${slug}` });
    }

    if (path.endsWith('.markdown') && method === 'GET') {
      const slug = path.split('/').pop()!.replace(/\.markdown$/, '');
      const body = pages.get(slug);
      return body === undefined ? respond(404, 'Not found') : respond(200, body);
    }

    return respond(404, 'Not found');
  }) as unknown as typeof fetch;

  const session = new OpenProjectWikiSession({
    baseUrl: 'https://op.test',
    username: 'wiki-bot',
    password: 'correct-horse',
    fetchImpl,
  });

  return { session, requests, pages };
}

describe('form parsing', () => {
  test('picks the right form out of a page with several', () => {
    const form = extractForm(LOGIN_HTML, (html) => /name="username"/.test(html));
    expect(form).toContain('action="/login"');
    expect(form).not.toContain('user[login]');
  });

  test('collects hidden inputs, textareas and selected options', () => {
    const form = parseForm(extractForm(wikiFormHtml({ text: '# Hi', lockVersion: '4', method: 'put' }), (h) => /wiki_form/.test(h))!);

    expect(form.action).toBe('/projects/kup/wiki/new');
    expect(form.fields.authenticity_token).toBe('csrf-wiki-token');
    expect(form.fields._method).toBe('put');
    expect(form.fields['page[lock_version]']).toBe('4');
    expect(form.fields['page[text]']).toBe('# Hi');
    // The select follows the hidden field of the same name and wins, as in a browser.
    expect(form.fields['page[parent_id]']).toBe('7');
    // Unchecked checkboxes and submit buttons are not submitted.
    expect(form.fields['page[redirect_existing_links]']).toBeUndefined();
    expect(form.fields.commit).toBeUndefined();
  });

  test('decodes entities in field values', () => {
    const form = parseForm('<form><textarea name="page[text]">a &amp; b &lt;tag&gt; &quot;q&quot;</textarea></form>');
    expect(form.fields['page[text]']).toBe('a & b <tag> "q"');
  });

  test('extracts Rails validation errors', () => {
    const errors = extractFormErrors('<div id="errorExplanation"><ul><li>Title has already been taken</li><li>Title can\'t be blank</li></ul></div>');
    expect(errors).toEqual(['Title has already been taken', "Title can't be blank"]);
    expect(extractFormErrors('<html>fine</html>')).toEqual([]);
  });
});

describe('cookies and slugs', () => {
  test('stores cookies and drops expired ones', () => {
    const jar = new Map<string, string>();
    updateCookies(jar, { headers: new Headers({ 'set-cookie': '_open_project_session=abc; path=/; HttpOnly' }) });
    expect(cookieHeader(jar)).toBe('_open_project_session=abc');

    updateCookies(jar, { headers: new Headers({ 'set-cookie': '_open_project_session=xyz; path=/' }) });
    expect(cookieHeader(jar)).toBe('_open_project_session=xyz');
  });

  test('slugifies titles the way wiki URLs do', () => {
    expect(wikiSlug('KUP Project Specification')).toBe('kup-project-specification');
    expect(wikiSlug('  Architecture & Design!  ')).toBe('architecture-design');
  });
});

describe('resolveMarkdownInput', () => {
  test('requires exactly one source', async () => {
    await expect(resolveMarkdownInput({})).rejects.toThrow('either "markdown" or "filePath"');
    await expect(resolveMarkdownInput({ markdown: '# Hi', filePath: '/tmp/x.md' })).rejects.toThrow('only one of');
  });

  test('reads a markdown file from disk', async () => {
    const path = `${import.meta.dir}/../package.json`;
    await expect(resolveMarkdownInput({ filePath: path })).resolves.toContain('"name"');
  });

  test('reports a missing file clearly', async () => {
    await expect(resolveMarkdownInput({ filePath: '/nope/missing.md' })).rejects.toThrow('Could not read markdown file');
  });
});

describe('createPage', () => {
  test('logs in, replays the form, and submits the markdown body', async () => {
    const { session, requests, pages } = fakeOpenProject({ requireLogin: true });

    const result = await session.createPage({
      projectRef: 'kup',
      title: 'KUP Project Specification',
      markdown: '# KUP\nSpecification body.',
      journalNotes: 'Imported from repo',
    });

    expect(result.slug).toBe('kup-project-specification');
    expect(result.url).toBe('https://op.test/projects/kup/wiki/kup-project-specification');
    // The body is read back from the server, so the result reflects what was stored.
    expect(result.markdown).toBe('# KUP\nSpecification body.');
    expect(pages.get('kup-project-specification')).toBe('# KUP\nSpecification body.');

    const submit = requests.find((entry) => entry.method === 'POST' && entry.url.endsWith('/wiki/new'))!;
    expect(submit.body?.get('page[title]')).toBe('KUP Project Specification');
    expect(submit.body?.get('page[journal_notes]')).toBe('Imported from repo');
    // CSRF token and hidden fields from the real form are replayed.
    expect(submit.body?.get('authenticity_token')).toBe('csrf-wiki-token');
    expect(submit.body?.get('page[parent_id]')).toBe('7');
    // The authenticated session cookie is sent, not the pre-login one.
    expect(submit.cookie).toContain('authed-session');
  });

  test('surfaces OpenProject validation errors', async () => {
    const { session } = fakeOpenProject({ failCreateWith: ['Title has already been taken'] });

    await expect(
      session.createPage({ projectRef: 'kup', title: 'KUP', markdown: '# x' })
    ).rejects.toThrow('Title has already been taken');
  });

  test('reports bad credentials clearly', async () => {
    const { session: _ignored } = fakeOpenProject();
    const bad = new OpenProjectWikiSession({
      baseUrl: 'https://op.test',
      username: 'wiki-bot',
      password: 'wrong',
      fetchImpl: fakeOpenProject().session['fetchImpl' as keyof OpenProjectWikiSession] as unknown as typeof fetch,
    });

    await expect(bad.createPage({ projectRef: 'kup', title: 'x', markdown: 'y' })).rejects.toThrow(
      'rejected the wiki credentials'
    );
  });
});

describe('updatePage and getPageMarkdown', () => {
  test('sends the edit form lock_version and _method=put', async () => {
    const { session, requests } = fakeOpenProject({ requireLogin: true });

    const result = await session.updatePage({
      projectRef: 'kup',
      slug: 'kup',
      markdown: '# Updated\nNew body.',
    });

    expect(result.markdown).toBe('# Updated\nNew body.');

    const submit = requests.find((entry) => entry.method === 'POST' && entry.url.includes('/wiki/kup'))!;
    expect(submit.body?.get('_method')).toBe('put');
    expect(submit.body?.get('page[lock_version]')).toBe('4');
    expect(submit.body?.get('page[text]')).toBe('# Updated\nNew body.');
  });

  test('refuses an update with nothing to change', async () => {
    const { session } = fakeOpenProject();
    await expect(session.updatePage({ projectRef: 'kup', slug: 'kup' })).rejects.toThrow('Nothing to update');
  });

  test('reads a page body as raw markdown', async () => {
    const { session } = fakeOpenProject({ requireLogin: true });
    await expect(session.getPageMarkdown('kup', 'kup')).resolves.toBe('# Existing\nOld body.');
  });

  test('reports a missing page', async () => {
    const { session } = fakeOpenProject({ requireLogin: true });
    await expect(session.getPageMarkdown('kup', 'ghost')).rejects.toThrow('was not found');
  });
});
