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
