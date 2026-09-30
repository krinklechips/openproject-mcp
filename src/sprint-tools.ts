import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { OpenProjectClient } from './openproject-client.ts';
import { assignTasks, compactSprint, compactTask, elements, projectLinks, readiness, scopedSprint, SPRINT_CAPABILITIES, sprintTasks, weeklyPlan } from './sprints.ts';

const id = z.number().int().positive();
const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };
const maxPages = z.number().int().min(1).max(10).default(5).describe('Maximum pages of 100 tasks. Reports state whether results are complete.');

export function registerSprintTools(server: McpServer, getClient: () => OpenProjectClient) {
  const run = async (fn: (client: OpenProjectClient) => Promise<unknown>) => {
    try { return { content: [{ type: 'text' as const, text: JSON.stringify(await fn(getClient()), null, 2) }] }; }
    catch (error) { return { isError: true, content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }] }; }
  };

  server.tool('list_project_sprints', 'List native OpenProject sprints in a project, including planned, active and completed. Sprints are not versions. Requires OpenProject sprint API support.', {
    projectId: id, offset: id.default(1), pageSize: z.number().int().min(1).max(100).default(100),
  }, readOnly, args => run(async client => {
    const page = await client.listProjectSprints(args.projectId, { offset: args.offset, pageSize: args.pageSize });
    const sprints = elements(page).map(compactSprint);
    const total = page.total ?? null;
    return { ...await projectLinks(client, args.projectId), sprints, total, offset: args.offset, pageSize: args.pageSize,
      nextOffset: total !== null && args.offset * args.pageSize < total ? args.offset + 1 : null,
      capabilities: SPRINT_CAPABILITIES };
  }));

  server.tool('get_sprint', 'Read one native sprint defined in the given project, with lifecycle limitations and browser planning links.', {
    projectId: id, sprintId: id,
  }, readOnly, args => run(async client => ({ ...await projectLinks(client, args.projectId), sprint: compactSprint(await scopedSprint(client, args.projectId, args.sprintId)), capabilities: SPRINT_CAPABILITIES })));

  server.tool('list_sprint_work_packages', 'List current tasks assigned to a native sprint, including closed tasks. Bounded pagination reports completeness; not a history of weekly completions.', {
    projectId: id, sprintId: id, maxPages,
  }, readOnly, args => run(async client => {
    const r = await sprintTasks(client, args.projectId, args.sprintId, args.maxPages);
    return { sprint: compactSprint(r.sprint), tasks: r.rows.map(compactTask), complete: r.complete, total: r.total, returned: r.returned, pages: r.pages };
  }));

  server.tool('get_sprint_readiness', 'Check current sprint tasks for missing owner, estimate and dates, dates outside the sprint, and status counts. Rejected is separate from accepted Closed. Does not infer historical throughput or team capacity.', {
    projectId: id, sprintId: id, maxPages,
  }, readOnly, args => run(client => readiness(client, args.projectId, args.sprintId, args.maxPages)));

  server.tool('plan_weekly_sprints', 'Prepare a Monday-Sunday sprint schedule and detect existing or overlapping sprints. READ ONLY: returns a draft and browser links, never creates sprints. Lifecycle writes are not exposed by the documented sprint API.', {
    projectId: id, firstMonday: z.string().describe('Explicit local calendar date YYYY-MM-DD, which must be Monday.'), weeks: z.number().int().min(1).max(12).default(2),
  }, readOnly, args => run(client => weeklyPlan(client, args.projectId, args.firstMonday, args.weeks)));

  server.tool('assign_work_packages_to_sprint', 'Preview or apply assignment of up to 50 existing tasks to a native sprint in the SAME project. Defaults to preview. Apply only the user-requested moves, providing the lockVersions from a reviewed preview. Validates all tasks before writes, stops on write failure, never silently retries conflicts. Does not start or create sprints.', {
    projectId: id, sprintId: id,
    items: z.array(z.object({ id, lockVersion: z.number().int().nonnegative().optional() })).min(1).max(50),
    apply: z.boolean().default(false), notify: z.boolean().default(true),
  }, { readOnlyHint: false, destructiveHint: false, openWorldHint: true }, async args => {
    const r = await run(client => assignTasks(client, args));
    if (!('isError' in r) && JSON.parse(r.content[0]!.text).partialFailure) return { ...r, isError: true };
    return r;
  });
}
