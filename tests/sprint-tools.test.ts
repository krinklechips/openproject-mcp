import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { setupMcpServer } from '../src/server-setup.ts';

let mcp: Client;
let api: any;
let patches: any[];
let task: any;
let sprint: any;
const collection = (elements: any[], total = elements.length) => ({ _type: 'Collection', _embedded: { elements }, total, count: elements.length, offset: 1, pageSize: 100 });
const status = (id: number, name: string, isClosed = false) => ({ id, name, isClosed });

beforeEach(async () => {
  process.env.OPENPROJECT_URL = 'https://openproject.test.invalid';
  process.env.OPENPROJECT_API_KEY = 'test-key';
  const setup = setupMcpServer();
  api = await setup.initClient();
  patches = [];
  sprint = { _type: 'Sprint', id: 24, name: 'KUP week', startDate: '2026-10-05', finishDate: '2026-10-11', _links: { definingWorkspace: { href: '/api/v3/projects/17' }, status: { href: 'urn:openproject-org:api:v3:sprints:status:in_planning', title: 'In planning' } } };
  task = { id: 101, lockVersion: 3, subject: 'Deliver feature', estimatedTime: null, dueDate: null, startDate: null, _links: { project: { href: '/api/v3/projects/17' }, sprint: { href: null }, assignee: { href: null }, status: { href: '/api/v3/statuses/1', title: 'New' } } };
  api.getProject = async () => ({ id: 17, identifier: 'kup', name: 'KUP' });
  api.listProjectSprints = async () => collection([sprint]);
  api.getSprint = async () => sprint;
  api.listProjectWorkPackages = async () => collection([{ ...task, _links: { ...task._links, sprint: { href: '/api/v3/sprints/24' } } }]);
  api.getWorkPackage = async () => structuredClone(task);
  api.listStatuses = async () => collection([status(1, 'New'), status(12, 'Closed', true), status(14, 'Rejected', true)]);
  api.validateWorkPackageUpdate = async (_id: number, body: any) => ({ _embedded: { validationErrors: {}, schema: { sprint: { writable: true } }, payload: body } });
  api.updateWorkPackage = async (id: number, body: any) => { patches.push({ id, body }); task = { ...task, lockVersion: 4, _links: { ...task._links, ...body._links } }; return task; };
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await setup.server.connect(st);
  mcp = new Client({ name: 'sprint-test', version: '1' });
  await mcp.connect(ct);
});
afterEach(async () => { await mcp.close(); });

async function call(name: string, args: any) {
  const r = await mcp.callTool({ name, arguments: args });
  const text = (r.content as any[])[0]?.text ?? '';
  let data: any;
  try { data = JSON.parse(text); } catch { data = { error: text }; }
  return { error: r.isError === true, data, text };
}

test('registers sprint tools without claiming unsupported lifecycle writes', async () => {
  const names = (await mcp.listTools()).tools.map(t => t.name);
  for (const n of ['list_project_sprints', 'get_sprint', 'list_sprint_work_packages', 'get_sprint_readiness', 'plan_weekly_sprints', 'assign_work_packages_to_sprint']) expect(names).toContain(n);
  expect(names).not.toContain('start_sprint');
});

test('lists real sprints and exposes read-only lifecycle capability', async () => {
  const r = await call('list_project_sprints', { projectId: 17 });
  expect(r.error).toBe(false);
  expect(r.data.sprints[0].id).toBe(24);
  expect(r.data.capabilities.lifecycleViaApi).toBe(false);
});

test('weekly plan spans month/year boundary and does not create records', async () => {
  const r = await call('plan_weekly_sprints', { projectId: 17, firstMonday: '2026-12-28', weeks: 2 });
  expect(r.error).toBe(false);
  expect(r.data.weeks.map((w: any) => [w.startDate, w.finishDate])).toEqual([['2026-12-28', '2027-01-03'], ['2027-01-04', '2027-01-10']]);
  expect(r.data.persisted).toBe(false);
  expect(patches).toHaveLength(0);
});

test('weekly plan detects existing matching sprint instead of suggesting a duplicate', async () => {
  const r = await call('plan_weekly_sprints', { projectId: 17, firstMonday: '2026-10-05', weeks: 1 });
  expect(r.data.weeks[0].existingSprintIds).toEqual([24]);
});

test('rejects invalid dates and non-Monday starts', async () => {
  for (const d of ['2026-02-30', '2026-10-06']) expect((await call('plan_weekly_sprints', { projectId: 17, firstMonday: d })).error).toBe(true);
});

test('readiness reports missing data and incomplete pagination honestly', async () => {
  api.listProjectWorkPackages = async () => collection([{ ...task, _links: { ...task._links, sprint: { href: '/api/v3/sprints/24' } } }], 101);
  const r = await call('get_sprint_readiness', { projectId: 17, sprintId: 24, maxPages: 1 });
  expect(r.error).toBe(false);
  expect(r.data.complete).toBe(false);
  expect(r.data.ready).toBe(false);
  expect(r.data.issues[0].missing).toContain('assignee');
  expect(r.data.issues[0].missing).toContain('estimate');
});

test('Rejected is separate from accepted Closed and does not imply weekly throughput', async () => {
  api.listProjectWorkPackages = async () => collection([12, 14].map((id, i) => ({ ...task, id: i + 1, _links: { ...task._links, sprint: { href: '/api/v3/sprints/24' }, status: { href: `/api/v3/statuses/${id}`, title: id === 12 ? 'Closed' : 'Rejected' } } })));
  const r = await call('get_sprint_readiness', { projectId: 17, sprintId: 24 });
  expect(r.data.counts.accepted).toBe(1);
  expect(r.data.counts.rejected).toBe(1);
  expect(r.data.basis).toContain('current');
});

test('assignment previews by default and validates against server form', async () => {
  const r = await call('assign_work_packages_to_sprint', { projectId: 17, sprintId: 24, items: [{ id: 101 }] });
  expect(r.error).toBe(false);
  expect(r.data.preview).toBe(true);
  expect(r.data.results[0].lockVersion).toBe(3);
  expect(patches).toHaveLength(0);
});

test('apply requires reviewed version and does not retry a stale task', async () => {
  for (const item of [{ id: 101 }, { id: 101, lockVersion: 2 }]) {
    const r = await call('assign_work_packages_to_sprint', { projectId: 17, sprintId: 24, apply: true, items: [item] });
    expect(r.error).toBe(true);
  }
  expect(patches).toHaveLength(0);
});

test('apply writes only sprint and lockVersion then verifies persistence', async () => {
  const r = await call('assign_work_packages_to_sprint', { projectId: 17, sprintId: 24, apply: true, items: [{ id: 101, lockVersion: 3 }] });
  expect(r.error).toBe(false);
  expect(r.data.results[0].status).toBe('updated');
  expect(patches).toEqual([{ id: 101, body: { lockVersion: 3, _links: { sprint: { href: '/api/v3/sprints/24' } } } }]);
});

test('rejects cross-project tasks and completed destinations without writing', async () => {
  task._links.project.href = '/api/v3/projects/99';
  expect((await call('assign_work_packages_to_sprint', { projectId: 17, sprintId: 24, items: [{ id: 101 }] })).error).toBe(true);
  task._links.project.href = '/api/v3/projects/17';
  sprint._links.status.href = 'urn:openproject-org:api:v3:sprints:status:completed';
  expect((await call('assign_work_packages_to_sprint', { projectId: 17, sprintId: 24, items: [{ id: 101 }] })).error).toBe(true);
  expect(patches).toHaveLength(0);
});

test('rejects form validation errors and read-only sprint fields', async () => {
  api.validateWorkPackageUpdate = async () => ({ _embedded: { validationErrors: { sprint: { message: 'Not allowed' } }, schema: { sprint: { writable: true } } } });
  expect((await call('assign_work_packages_to_sprint', { projectId: 17, sprintId: 24, items: [{ id: 101 }] })).error).toBe(true);
  api.validateWorkPackageUpdate = async () => ({ _embedded: { validationErrors: {}, schema: { sprint: { writable: false } } } });
  expect((await call('assign_work_packages_to_sprint', { projectId: 17, sprintId: 24, items: [{ id: 101 }] })).error).toBe(true);
  expect(patches).toHaveLength(0);
});

test('rejects duplicates and oversized batches', async () => {
  expect((await call('assign_work_packages_to_sprint', { projectId: 17, sprintId: 24, items: [{ id: 101 }, { id: 101 }] })).error).toBe(true);
  expect((await call('assign_work_packages_to_sprint', { projectId: 17, sprintId: 24, items: Array.from({length: 51}, (_, i) => ({ id: i + 1 })) })).error).toBe(true);
});

test('all validation finishes before any task is changed', async () => {
  api.getWorkPackage = async (id: number) => ({ ...structuredClone(task), id });
  api.validateWorkPackageUpdate = async (id: number, body: any) => ({ _embedded: { validationErrors: id === 102 ? { sprint: { message: 'Denied' } } : {}, schema: { sprint: { writable: true } }, payload: body } });
  const r = await call('assign_work_packages_to_sprint', { projectId: 17, sprintId: 24, apply: true, items: [{ id: 101, lockVersion: 3 }, { id: 102, lockVersion: 3 }] });
  expect(r.error).toBe(true);
  expect(r.text).toContain('failed form validation');
  expect(patches).toHaveLength(0);
});

test('write conflict stops the batch without retry or false success', async () => {
  api.getWorkPackage = async (id: number) => ({ ...structuredClone(task), id });
  api.updateWorkPackage = async (id: number) => { patches.push(id); throw new Error('409 UpdateConflict'); };
  const r = await call('assign_work_packages_to_sprint', { projectId: 17, sprintId: 24, apply: true, items: [{ id: 101, lockVersion: 3 }, { id: 102, lockVersion: 3 }] });
  expect(r.error).toBe(true);
  expect(r.data.results.map((x: any) => x.status)).toEqual(['unconfirmed', 'skipped']);
  expect(patches).toEqual([101]);
});

test('mismatched readback is not reported as a saved assignment', async () => {
  api.updateWorkPackage = async () => task;
  const r = await call('assign_work_packages_to_sprint', { projectId: 17, sprintId: 24, apply: true, items: [{ id: 101, lockVersion: 3 }] });
  expect(r.error).toBe(true);
  expect(r.data.results[0].status).toBe('unconfirmed');
});

test('closed task visibility is explicit and pages are followed', async () => {
  const calls: any[] = [];
  api.listProjectWorkPackages = async (projectId: number, params: any) => {
    calls.push({ projectId, params });
    return collection([{ ...task, id: params.offset, _links: { ...task._links, sprint: { href: '/api/v3/sprints/24' } } }], 2);
  };
  const r = await call('list_sprint_work_packages', { projectId: 17, sprintId: 24 });
  expect(r.error).toBe(false);
  expect(r.data.complete).toBe(true);
  expect(r.data.tasks.map((x: any) => x.id)).toEqual([1, 2]);
  expect(JSON.parse(calls[0].params.filters)).toContainEqual({ status: { operator: '*', values: [] } });
});

test('repeated pages cannot produce an inflated or complete report', async () => {
  api.listProjectWorkPackages = async () => collection([{ ...task, _links: { ...task._links, sprint: { href: '/api/v3/sprints/24' } } }], 2);
  const r = await call('list_sprint_work_packages', { projectId: 17, sprintId: 24 });
  expect(r.data.complete).toBe(false);
  expect(r.data.tasks).toHaveLength(1);
});

test('empty sprints are not ready to start', async () => {
  api.listProjectWorkPackages = async () => collection([]);
  const r = await call('get_sprint_readiness', { projectId: 17, sprintId: 24 });
  expect(r.data.ready).toBe(false);
  expect(r.data.sprintIssues).toContain('emptySprint');
});

test('task results outside requested sprint are rejected', async () => {
  api.listProjectWorkPackages = async () => collection([task]);
  const r = await call('list_sprint_work_packages', { projectId: 17, sprintId: 24 });
  expect(r.error).toBe(true);
  expect(r.text).toContain('outside the requested');
});

test('readiness identifies a deadline after sprint end', async () => {
  task.dueDate = '2026-10-12';
  const r = await call('get_sprint_readiness', { projectId: 17, sprintId: 24 });
  expect(r.data.issues[0].warnings).toContain('finishAfterSprint');
});
