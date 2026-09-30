import type { HALResponse, OpenProjectClient, Sprint, WorkPackage } from './openproject-client.ts';

export const SPRINT_CAPABILITIES = {
  lifecycleViaApi: false,
  lifecycleInstructions: 'Create, edit, start and complete sprints through OpenProject Backlogs > Backlog and sprints. The documented sprint API exposes reads only.',
  assignment: 'Work-package sprint assignment is validated against the server form and current permissions.',
  enterpriseLimits: 'Multiple active sprints in one project and cross-project sprint sharing require the appropriate OpenProject edition. This connector does not change those limits.',
};

export function elements<T>(page: HALResponse<T>): T[] {
  return (page._embedded?.elements as T[] | undefined) ?? page.elements ?? [];
}

export function sprintState(sprint: Sprint): string {
  const href = sprint._links.status?.href ?? '';
  return href.startsWith('urn:openproject-org:api:v3:sprints:status:') ? href.split(':').at(-1)! : 'unknown';
}

function resourceId(href: string | null | undefined, resource: string): number | null {
  const match = href?.match(new RegExp(`^/api/v3/(?:${resource})/([1-9][0-9]*)$`));
  return match ? Number(match[1]) : null;
}

export function compactSprint(sprint: Sprint) {
  return { id: sprint.id, name: sprint.name, status: sprintState(sprint), startDate: sprint.startDate ?? null,
    finishDate: sprint.finishDate ?? null, startedAt: sprint.startedAt ?? null, completedAt: sprint.completedAt ?? null,
    definingProjectId: resourceId(sprint._links.definingWorkspace?.href, 'projects|workspaces') };
}

export async function scopedSprint(client: OpenProjectClient, projectId: number, sprintId: number) {
  const sprint = await client.getSprint(sprintId);
  if (sprint.id !== sprintId || compactSprint(sprint).definingProjectId !== projectId) {
    throw new Error('Sprint is not defined in the requested project. Cross-project/shared sprint writes are not supported by these tools.');
  }
  return sprint;
}

export async function projectLinks(client: OpenProjectClient, projectId: number) {
  const project = await client.getProject(projectId);
  const base = `/projects/${encodeURIComponent(project.identifier)}`;
  return { projectId: project.id, projectName: project.name, planningPath: `${base}/backlogs/backlog`, sprintHistoryPath: `${base}/backlogs/sprints` };
}

async function collect<T extends { id: number }>(fetchPage: (offset: number) => Promise<HALResponse<T>>, maxPages: number) {
  const rows: T[] = [];
  const ids = new Set<number>();
  let total: number | undefined;
  let pages = 0;
  let complete = false;
  for (let offset = 1; offset <= maxPages; offset++) {
    const page = await fetchPage(offset);
    pages++;
    const entries = elements(page);
    if (Number.isFinite(page.total)) total = page.total;
    let newRows = 0;
    for (const row of entries) if (!ids.has(row.id)) { ids.add(row.id); rows.push(row); newRows++; }
    if (total !== undefined && rows.length >= total) { complete = true; break; }
    if (entries.length === 0) { complete = total === undefined || rows.length >= total; break; }
    if (newRows === 0) break;
  }
  return { rows, total: total ?? null, returned: rows.length, pages, complete };
}

export async function sprintTasks(client: OpenProjectClient, projectId: number, sprintId: number, maxPages: number) {
  const sprint = await scopedSprint(client, projectId, sprintId);
  const filters = JSON.stringify([{ sprint: { operator: '=', values: [String(sprintId)] } }, { status: { operator: '*', values: [] } }]);
  const result = await collect(offset => client.listProjectWorkPackages(projectId, { offset, pageSize: 100, filters, sortBy: '[["id","asc"]]' }), maxPages);
  for (const row of result.rows) {
    if (resourceId(row._links.project?.href, 'projects|workspaces') !== projectId || resourceId(row._links.sprint?.href, 'sprints') !== sprintId) {
      throw new Error('OpenProject returned tasks outside the requested project/sprint. No summary produced.');
    }
  }
  return { ...result, sprint };
}

export function compactTask(row: WorkPackage) {
  return { id: row.id, subject: row.subject, lockVersion: row.lockVersion, assignee: row._links.assignee?.title ?? null,
    status: row._links.status?.title ?? null, startDate: row.startDate ?? null, finishDate: row.dueDate ?? null,
    estimatedTime: row.estimatedTime ?? null, spentTime: row.spentTime ?? null, path: `/work_packages/${row.id}` };
}

export async function readiness(client: OpenProjectClient, projectId: number, sprintId: number, maxPages: number) {
  const result = await sprintTasks(client, projectId, sprintId, maxPages);
  const statuses = elements(await client.listStatuses());
  const issues: { id: number; subject: string; missing: string[]; warnings: string[]; path: string }[] = [];
  const counts = { totalObserved: result.rows.length, open: 0, accepted: 0, rejected: 0, otherClosed: 0, unknownStatus: 0 };
  const byStatus: Record<string, number> = {};
  for (const row of result.rows) {
    const status = statuses.find(s => s.id === resourceId(row._links.status?.href, 'statuses'));
    const label = status?.name ?? row._links.status?.title ?? 'Unknown';
    byStatus[label] = (byStatus[label] ?? 0) + 1;
    if (!status) counts.unknownStatus++;
    else if (/^rejected$/i.test(status.name)) counts.rejected++;
    else if (status.isClosed && /^closed$/i.test(status.name)) counts.accepted++;
    else if (status.isClosed) counts.otherClosed++;
    else counts.open++;
    if (status?.isClosed) continue;
    const missing: string[] = [];
    const warnings: string[] = [];
    if (!row._links.assignee?.href) missing.push('assignee');
    if (!row.startDate) missing.push('startDate');
    if (!row.dueDate) missing.push('finishDate');
    if (!row.estimatedTime || !/[1-9]/.test(row.estimatedTime)) missing.push('estimate');
    if (row.dueDate && result.sprint.finishDate && row.dueDate > result.sprint.finishDate) warnings.push('finishAfterSprint');
    if (row.dueDate && result.sprint.startDate && row.dueDate < result.sprint.startDate) warnings.push('finishBeforeSprint');
    if (row.startDate && row.dueDate && row.startDate > row.dueDate) warnings.push('invalidDateRange');
    if (missing.length || warnings.length) issues.push({ id: row.id, subject: row.subject, missing, warnings, path: `/work_packages/${row.id}` });
  }
  const sprintIssues: string[] = [];
  if (!result.sprint.startDate || !result.sprint.finishDate) sprintIssues.push('missingSprintDates');
  if (result.sprint.startDate && result.sprint.finishDate && result.sprint.startDate > result.sprint.finishDate) sprintIssues.push('invalidSprintDates');
  if (!result.rows.length) sprintIssues.push('emptySprint');
  return { sprint: compactSprint(result.sprint), complete: result.complete, total: result.total, pages: result.pages,
    ready: result.complete && !issues.length && !sprintIssues.length && !counts.unknownStatus && sprintState(result.sprint) === 'in_planning',
    counts, byStatus, issues, sprintIssues,
    basis: 'Current task state only; not historical weekly throughput or a frozen commitment. Accepted means current status named Closed with isClosed=true; verify acceptance evidence. Rejected is reported separately.',
    limitations: ['Readiness checks only owner, dates and estimate. Capacity, dependencies and acceptance criteria still need team review.', 'Missing estimates and dates are reported, never invented.'] };
}

export async function weeklyPlan(client: OpenProjectClient, projectId: number, firstMonday: string, weeks: number) {
  const first = new Date(`${firstMonday}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(firstMonday) || !Number.isFinite(first.getTime()) || first.toISOString().slice(0, 10) !== firstMonday || first.getUTCDay() !== 1) {
    throw new Error('firstMonday must be a valid Monday in YYYY-MM-DD format.');
  }
  const links = await projectLinks(client, projectId);
  const existing = await collect(offset => client.listProjectSprints(projectId, { offset, pageSize: 100 }), 10);
  const date = (days: number) => new Date(first.getTime() + days * 86_400_000).toISOString().slice(0, 10);
  return { ...links, persisted: false, existingSprintsComplete: existing.complete, capabilities: SPRINT_CAPABILITIES,
    weeks: Array.from({ length: weeks }, (_, index) => {
      const startDate = date(index * 7), finishDate = date(index * 7 + 6);
      return { name: `${links.projectName} - Week of ${startDate}`, startDate, finishDate,
        existingSprintIds: existing.rows.filter(s => s.startDate === startDate && s.finishDate === finishDate).map(s => s.id),
        overlappingSprintIds: existing.rows.filter(s => s.startDate && s.finishDate && s.startDate <= finishDate && s.finishDate >= startDate).map(s => s.id) };
    }), instructions: 'This is a draft, not saved sprints. Review existing and overlapping sprints, then create any missing weeks in the linked planning page. If the existing list is incomplete, do not assume a week is absent.' };
}

export async function assignTasks(client: OpenProjectClient, input: {
  projectId: number; sprintId: number; items: { id: number; lockVersion?: number }[]; apply: boolean; notify: boolean;
}) {
  if (new Set(input.items.map(i => i.id)).size !== input.items.length) throw new Error('Duplicate work package IDs are not allowed.');
  if (input.apply && input.items.some(i => i.lockVersion === undefined)) throw new Error('Applying requires the lockVersion returned by a reviewed preview for every task.');
  const sprint = await scopedSprint(client, input.projectId, input.sprintId);
  if (!['in_planning', 'active'].includes(sprintState(sprint))) throw new Error('Destination sprint must be in planning or active.');
  const href = `/api/v3/sprints/${input.sprintId}`;
  const prepared = [];
  // Complete every preflight before the first write; never silently retry conflicts.
  for (const item of input.items) {
    const task = await client.getWorkPackage(item.id);
    if (resourceId(task._links.project?.href, 'projects|workspaces') !== input.projectId) throw new Error(`Task ${item.id} belongs to another project.`);
    if (item.lockVersion !== undefined && item.lockVersion !== task.lockVersion) throw new Error(`Task ${item.id} changed since preview. Refresh the preview; no tasks were updated.`);
    const body = { lockVersion: task.lockVersion, _links: { sprint: { href } } };
    const form = await client.validateWorkPackageUpdate(item.id, body);
    const validation = form._embedded;
    if (!validation?.validationErrors || Object.keys(validation.validationErrors).length) throw new Error(`Task ${item.id} failed form validation: ${JSON.stringify(validation?.validationErrors ?? 'missing validation result')}`);
    if (validation.schema?.sprint?.writable !== true) throw new Error(`Sprint field is not writable for task ${item.id}. Check OpenProject permissions/version.`);
    if (validation.payload?._links?.sprint?.href !== href) throw new Error(`Sprint assignment was not accepted by the form for task ${item.id}.`);
    prepared.push({ task, body });
  }
  const results: Record<string, unknown>[] = [];
  if (!input.apply) return { preview: true, sprint: compactSprint(sprint), results: prepared.map(({task}) => ({ ...compactTask(task), fromSprint: task._links.sprint?.href ?? null, toSprintId: input.sprintId, status: task._links.sprint?.href === href ? 'unchanged' : 'wouldUpdate' })) };
  // Recheck destination after potentially long validation.
  const latest = await scopedSprint(client, input.projectId, input.sprintId);
  if (!['in_planning', 'active'].includes(sprintState(latest))) throw new Error('Sprint state changed during validation; no tasks were updated.');
  let stopped = false;
  for (const {task, body} of prepared) {
    if (stopped) { results.push({ id: task.id, status: 'skipped' }); continue; }
    if (task._links.sprint?.href === href) { results.push({ id: task.id, status: 'unchanged' }); continue; }
    try {
      await client.updateWorkPackage(task.id, body, input.notify);
      const saved = await client.getWorkPackage(task.id);
      if (saved._links.sprint?.href !== href) throw new Error('Readback did not confirm the requested sprint.');
      results.push({ id: task.id, status: 'updated', lockVersion: saved.lockVersion, sprintId: input.sprintId });
    } catch (error) {
      stopped = true;
      results.push({ id: task.id, status: 'unconfirmed', error: error instanceof Error ? error.message : String(error), nextAction: 'Read this task before retrying; a failed response may still have saved the change. Remaining tasks were skipped.' });
    }
  }
  return { preview: false, sprint: compactSprint(sprint), results, partialFailure: stopped };
}
