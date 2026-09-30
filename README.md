# Tonle OpenProject MCP Server

A Model Context Protocol (MCP) server that connects AI assistants (Claude, Cursor, Windsurf, etc.) to OpenProject's API v3.

## Quick Start

### 1. Install Bun

```bash
curl -fsSL https://bun.sh/install | bash
```

### 2. Clone & Install

```bash
git clone https://github.com/liratanak/tonle.git
cd tonle
bun install
```

### 3. Configure Environment

Create a `.env` file or set environment variables:

```bash
OPENPROJECT_URL=https://your-instance.openproject.com
OPENPROJECT_API_KEY=your-api-key-here
```

**Get your API key:**
- Log into OpenProject → My Account → Access Tokens → Generate

### 4. Run the Server

```bash
# Stdio mode (default)
bun run index.ts

# HTTP mode
bun run start:http
```

### 5. Test with MCP Inspector

```bash
bunx @modelcontextprotocol/inspector bun run index.ts
```

## Using with MCP Clients

Add to your MCP client configuration (e.g., `claude_desktop_config.json`, `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "openproject": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/tonle/index.ts"],
      "env": {
        "OPENPROJECT_URL": "https://your-instance.openproject.com",
        "OPENPROJECT_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

**Configuration file locations:**
- **Claude Desktop** (macOS): `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Claude Desktop** (Windows): `%APPDATA%\Claude\claude_desktop_config.json`
- **Claude Desktop** (Linux): `~/.config/Claude/claude_desktop_config.json`
- **Cursor**: `.cursor/mcp.json` in project root

## What You Can Do

Once connected, you can ask your AI assistant to:

- "List all my OpenProject projects"
- "Create a new task in project X titled 'Setup testing environment'"
- "Show me all work packages assigned to me"
- "Update work package #123 to status 'In Progress'"
- "Move #45, #46 and #47 to the next sprint and assign them all to Bob" (bulk update in one call)
- "How many hours did Vanntha log last month?" (timesheet totals per user, project and day)
- "Summary total hours by members, by projects in 1 table for last month" (timesheet member × project summary table)
- "Show me wiki page 37 and attach these notes to it" (wiki page metadata + attachments — see the limitation below)
- And much more...

### Native sprint planning (OpenProject 17.3+)

This connector now understands native **sprints**, which are separate from
release **versions**. It uses the existing API key and the connected account's
permissions. It does not unlock Enterprise features or change the OpenProject UI.

| Tool | Purpose |
|---|---|
| `list_project_sprints` | List planned, active and completed sprints, with pagination. |
| `get_sprint` | Read sprint dates/state and show browser planning links. |
| `list_sprint_work_packages` | Read assigned work, including closed items; report incomplete results. |
| `get_sprint_readiness` | Flag missing assignees, estimates and dates, and finish dates outside the sprint. |
| `plan_weekly_sprints` | Draft Monday-Sunday weeks and identify existing/overlapping sprints. Does not save them. |
| `assign_work_packages_to_sprint` | Preview, then apply requested task moves with optimistic locking and readback. |

Example prompts:

- "List KUP's planned sprints."
- "Prepare the next two weekly sprints starting Monday 5 October 2026."
- "Check whether sprint 24 has owners, estimates and dates for every open item."
- "Preview moving tasks 101 and 102 into sprint 24."
- "Apply those reviewed moves." The caller supplies the lockVersions from the
  preview and `apply: true`. Conflicts require a fresh preview; they are not retried.

Use numeric project and sprint IDs. These management tools handle sprints defined
in that project; shared/cross-project sprint management is intentionally excluded.
Assignment batches are limited to 50 items. Every item is validated before any
write; writes stop at the first failure. A failed response is reported as
unconfirmed rather than assumed not to have saved. Task owners, dates and statuses
are not changed by the assignment tool. Notifications default to OpenProject's
normal behavior (`notify: true`).

**Lifecycle limitation:** the documented sprint API provides reads, not
create/edit/start/complete operations. Use **Backlogs > Backlog and sprints** for
those actions; the tools return project-relative planning links. The weekly plan
is explicitly a draft. No invented write endpoints, direct database changes or
stored browser credentials are used. The server enforces permissions and edition
limits, including multiple active sprints and sprint sharing.

Readiness reports describe **current state**, not historical weekly throughput.
`Closed` with `isClosed=true` is counted separately from `Rejected` and other
closed states. Verify acceptance evidence and team capacity before starting a
sprint. Unknown statuses, empty sprints and truncated task collections cannot
produce a ready result. The API does not expose sprint goals on the verified
installation, so this tool does not claim to validate them.

After installing the update, reconnect/restart the MCP client to refresh its tool
catalog. The configured API key and OpenProject database stay the same.

Reference: [OpenProject sprint API](https://www.openproject.org/docs/api/endpoints/sprints/).

### Wiki module support

Publish a markdown file straight to a project wiki:

> "Use docs/KUP-Project-Specification.md to create a wiki page in the KUP project"

| Operation | Tool | Auth needed |
|---|---|---|
| Create a page from markdown | `create_wiki_page` | Username + password |
| Replace a page body / rename | `update_wiki_page` | Username + password |
| Read a page body as markdown | `get_wiki_page_content` | Username + password |
| Get page metadata | `get_wiki_page` | API key |
| List / add / delete attachments | `list_wiki_page_attachments`, `add_wiki_page_attachment`, `delete_attachment` | API key |

**Why wiki writing needs a password.** OpenProject's REST API cannot create or update wiki
pages, and never returns page bodies — API v3 declares exactly one wiki endpoint,
`GET /api/v3/wiki_pages/{id}`, whose response contains only `id`, `title` and links. (Docs
claiming a `POST /api/v3/projects/{id}/wiki_pages` endpoint are wrong; it returns 404.) So the
write tools log in and drive the same web forms the UI uses. Add to your environment:

```bash
OPENPROJECT_USERNAME=your-username
OPENPROJECT_PASSWORD=your-password
```

Use an account with the **"edit wiki pages"** permission, and note that accounts behind 2FA or
SSO cannot be used. Without these variables everything else still works — only the three wiki
write tools return an error explaining what to set.

## Documentation

- **[ARCHITECTURE.md](./ARCHITECTURE.md)** - Technical architecture, implementation details, and API reference
- **[MCP_SERVERS.md](./MCP_SERVERS.md)** - Client-specific configuration examples (if available)
- **[LOGGING.md](./LOGGING.md)** - Comprehensive logging system documentation

## Features

- ✅ Complete OpenProject API v3 coverage (40+ endpoint categories)
- ✅ Work packages, projects, users, time entries, and more
- ✅ Stdio transport (local clients)
- ✅ HTTP transport (remote clients)
- ✅ Type-safe with TypeScript & Zod validation
- ✅ Comprehensive logging system (daily logs by caller/initiator)

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Server not appearing | Check absolute path to `index.ts`, restart client |
| Authentication errors | Verify API key is correct and has permissions |
| Connection timeout | Check `OPENPROJECT_URL` is accessible |
| Bun command not found | Ensure Bun is installed and in your PATH |

## Contributing

```bash
git clone https://github.com/liratanak/tonle.git
cd tonle
bun install
bun run dev    # Development mode
bun test       # Run tests
```

See [ARCHITECTURE.md](./ARCHITECTURE.md) for detailed development information.

## License

MIT License - See LICENSE file for details

## Resources

- **OpenProject**: https://www.openproject.org/docs/
- **OpenProject API**: https://www.openproject.org/docs/api/
- **MCP Specification**: https://spec.modelcontextprotocol.io/
- **MCP SDK**: https://github.com/modelcontextprotocol/typescript-sdk
