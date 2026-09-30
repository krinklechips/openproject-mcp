# Sprint management implementation plan

Goal: Extend Ratanak's existing connector with actual sprint discovery, planning,
readiness review and guarded task assignment using the configured OpenProject API.

Architecture: Keep the API-key transport and current server setup. Add typed
sprint client methods, a focused sprint service, and MCP registrations shared by
stdio and HTTP. No second task database, browser credential storage, or license
changes. OpenProject remains the source of truth.

Tech stack: Existing Bun, TypeScript, Zod and MCP SDK.

## Design and verified constraints

User approved enhancing the MCP for sprint planning and reporting. Alternatives
were browser-only operation, an API connector extension, or a separate planning
application. Extend the existing API connector: it is simpler to maintain and
does not create competing sprint records.

Official sprint API exposes GET collection and single-sprint endpoints, not
create/start/complete. Live KUP GET endpoints returned sprints 24 and 25. The
work-package schema marks sprint writable, and a POST to work package 3207's
validation form accepted sprint 24 with no validation errors. This was a form
validation only, not a live task update.

Lifecycle actions return browser planning links and explicit capability limits.
No fabricated create/start endpoints or version-as-sprint fallback. Parallel
active sprints and sharing remain subject to OpenProject's edition and settings.

## Tasks

1. Add protocol tests for sprint tool registration, list filtering, readiness
   gaps, Monday-based date planning, and assignment preview. Run and see them fail.
2. Add `Sprint`, collection methods, single read and task-update form validation
   to `src/openproject-client.ts`. Add helpers in `src/sprints.ts` and registrations
   in `src/sprint-tools.ts`, imported by `src/server-setup.ts`.
3. Assign tasks through a dedicated tool, defaulting to preview. Validate project,
   destination sprint state, task lockVersion and form errors; no silent conflict
   retry. Bound batches and report per-item results. Confirm saved sprint via readback.
4. Readiness reports include current status buckets, missing owner/estimate/dates,
   finish dates outside sprint, and pagination completeness. Rejected is not
   accepted delivery. Do not infer historical completion from updated timestamps.
5. Add documentation of capabilities, example prompts and lifecycle limitations.
6. Run focused protocol and regression tests, TypeScript verification, and real
   stdio read-only checks against project 17. Do not create test work in production.
7. Fast-forward the clean installed checkout to the tested commit. Verify the
   configured launcher advertises and executes the new tools in a fresh process.
   Existing Codex sessions may require reconnecting to refresh their tool catalog.

## Verification commands

Use `/Users/enochphan/.local/share/openproject-mcp-runtime/node_modules/.bin/bun`.
Run `bun test tests/sprint-tools.test.ts` for red/green, then focused bulk-update,
work-package and sprint tests. Live check is read-only/validation-only and must
not log credentials. No Portal/Core changes or related CI changes are in scope.
