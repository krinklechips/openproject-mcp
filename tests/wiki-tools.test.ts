/**
 * Registration/validation tests for the wiki page MCP tools. The tool contract
 * is verified over an in-memory transport pair, so no live OpenProject instance
 * is required — network calls fail fast against an unreachable host.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { setupMcpServer } from '../src/server-setup.ts';

let client: Client;

async function callTool(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  return { isError: result.isError === true, text: content[0]?.text ?? '' };
}

async function toolByName(name: string) {
  const tools = await client.listTools();
  return tools.tools.find((entry) => entry.name === name);
}

beforeAll(async () => {
  // Force an unreachable host so any network call fails fast locally.
  process.env.OPENPROJECT_URL = 'http://openproject.test.invalid';
  process.env.OPENPROJECT_API_KEY = 'test-key';
  // Assert the unconfigured path deterministically, even on a machine that has
  // real wiki credentials exported.
  delete process.env.OPENPROJECT_USERNAME;
  delete process.env.OPENPROJECT_PASSWORD;

  const { server, initClient } = setupMcpServer({ name: 'test-server', version: '0.0.0' });
  await initClient();

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
});

afterAll(async () => {
  await client?.close();
});

describe('wiki page tools', () => {
  test('the read-only wiki tools are registered', async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((entry) => entry.name);

    expect(names).toContain('get_wiki_page');
    expect(names).toContain('list_wiki_page_attachments');
    expect(names).toContain('add_wiki_page_attachment');
  });

  test('the session-backed write tools are registered', async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((entry) => entry.name);

    expect(names).toContain('create_wiki_page');
    expect(names).toContain('update_wiki_page');
    expect(names).toContain('get_wiki_page_content');
  });

  test('no tools are advertised for operations nothing can do', async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((entry) => entry.name);

    // There is no API list endpoint, and page deletion was never implemented.
    expect(names).not.toContain('list_wiki_pages');
    expect(names).not.toContain('delete_wiki_page');
  });

  test('create_wiki_page accepts a markdown file path or inline markdown', async () => {
    const tool = await toolByName('create_wiki_page');
    const schema = tool?.inputSchema as { properties?: Record<string, { type?: string }>; required?: string[] };
    const properties = Object.keys(schema?.properties ?? {});

    expect(properties).toEqual(expect.arrayContaining(['projectId', 'title', 'filePath', 'markdown', 'parentId']));
    // The body may come from either source, so neither is individually required.
    expect(schema?.required ?? []).toEqual(expect.arrayContaining(['projectId', 'title']));
    expect(schema?.required ?? []).not.toContain('filePath');
    expect(schema?.required ?? []).not.toContain('markdown');
  });

  test('update_wiki_page identifies the page by project and slug', async () => {
    const tool = await toolByName('update_wiki_page');
    const schema = tool?.inputSchema as { properties?: Record<string, unknown>; required?: string[] };

    expect(Object.keys(schema?.properties ?? {})).toEqual(expect.arrayContaining(['projectId', 'slug', 'filePath', 'markdown']));
    expect(schema?.required ?? []).toEqual(expect.arrayContaining(['projectId', 'slug']));
  });

  test('write tools explain what to configure when credentials are absent', async () => {
    const result = await callTool('create_wiki_page', {
      projectId: 17,
      title: 'KUP Project Specification',
      markdown: '# KUP',
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('OPENPROJECT_USERNAME');
    expect(result.text).toContain('OPENPROJECT_PASSWORD');
    // The message must say why an API key is not enough.
    expect(result.text).toMatch(/API key cannot create or edit wiki pages/i);
  });

  test('get_wiki_page states that page content and writes are unavailable', async () => {
    const tool = await toolByName('get_wiki_page');
    expect(tool?.description).toContain('metadata only');
    expect(tool?.description).toMatch(/cannot return the page body/i);

    const schema = tool?.inputSchema as { properties?: Record<string, { type?: string }>; required?: string[] };
    expect(schema?.properties?.id?.type).toBe('number');
    expect(schema?.required ?? []).toContain('id');
  });

  test('get_wiki_page rejects a title in place of a numeric id', async () => {
    const result = await callTool('get_wiki_page', { id: 'Onboarding Guide' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('Invalid arguments');
  });

  test('add_wiki_page_attachment takes files by filePath or base64, without an inline flag', async () => {
    const tool = await toolByName('add_wiki_page_attachment');
    const schema = tool?.inputSchema as {
      properties?: Record<string, { type?: string; items?: { properties?: Record<string, unknown> } }>;
      required?: string[];
    };

    expect(schema?.properties?.attachments?.type).toBe('array');
    expect(schema?.required ?? []).toEqual(expect.arrayContaining(['id', 'attachments']));

    const itemProperties = Object.keys(schema?.properties?.attachments?.items?.properties ?? {});
    expect(itemProperties).toContain('filePath');
    expect(itemProperties).toContain('base64');
    expect(itemProperties).toContain('fileName');
    // A wiki page body cannot be written, so nothing can be embedded inline.
    expect(itemProperties).not.toContain('inline');
  });

  test('add_wiki_page_attachment passes validation and fails only at the network layer', async () => {
    const result = await callTool('add_wiki_page_attachment', {
      id: 42,
      attachments: [{ fileName: 'notes.md', base64: Buffer.from('# Notes').toString('base64') }],
    });

    expect(result.isError).toBe(true);
    expect(result.text).not.toContain('Invalid arguments');
  });

  test('add_wiki_page_attachment requires at least one file', async () => {
    const result = await callTool('add_wiki_page_attachment', { id: 42, attachments: [] });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('Invalid arguments');
  });
});
