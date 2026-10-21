# Linear access: API key, then Claude MCP

Use already exposed Linear tools when they can do the requested work. Discover their current names and verify the right workspace with a read-only call.

If `LINEAR_API_KEY` is absent, **try connecting Linear through Claude MCP before asking for a key or abandoning the task**:

1. From the target project run `node <skill>/scripts/setup.mjs linear --target <project>`. For implementing/checking Linear tasks this is the application project; for design publication it is the design project. `--check` only inspects.
2. The helper lists Claude Code's configured MCP servers. It reuses an official Linear connection under any recognized name. If none exists, it registers `https://mcp.linear.app/mcp` with `claude mcp add --transport http --scope local linear-server …`. Local scope keeps registration out of the repository. It never adds API-key headers, copies tokens, removes a server or overwrites a conflicting entry.
3. If authentication is needed, ask the user to open Claude Code in that project, run `/mcp`, select Linear and finish browser sign-in. Where supported, `claude mcp login <discovered-name>` is another interactive route. Never request a password, API key or OAuth callback in chat. Do not print raw CLI configuration/diagnostics or copy Claude's stored credentials.
4. Rediscover Linear tools in the active Claude session and make a read-only call. The registration step alone is not evidence of authenticated access. If the new tools are not yet visible, explain how to reconnect/reopen the session. An existing read-only connection can read tasks; do not claim that it can publish.
5. Continue the original operation and exact task IDs. A `needs_mcp` result is a handoff to the interactive agent, not an issue creation or completed verification.

When Claude Code is unavailable, use an existing Linear connector in the active Claude environment (Claude settings → Connectors → Linear), or give the precise missing setup step. From a Codex-only session, configuring Claude does not grant this session Claude's tools. Keep the prepared data and identify the Claude step still needed; do not launch a separate model to publish or borrow its tokens.

## After connection

For a Linear ID supplied to `start-task`/`sim-verify-task`, read the requested issues and their linked changes. Reading never creates or modifies issues, comments or attachments. A description or PR-only request does not require a Linear issue or this setup.

For `designs.mjs linear`, the no-key path saves `linear-preview/`, returns `published: false` and attempts MCP setup. Follow the existing approval/version/selection. Re-read the current version before remote writes. Search each `handoff:<repo>:<batch>:<task>` marker before creating a task; for a named existing issue, search its comments before posting. Keep one publisher per batch. After a confirmed remote result, record that task immediately with `--record T1=TEAM-123@<actual-url>`. An interrupted or uncertain write must be reconciled before retrying.

For `attach`, `comment` and artifact links, use the available MCP capabilities and report actual results. Upload screenshots and the HTML page when supported. If a capability is absent, keep the local files and explicitly identify the missing attachment rather than claiming success or inventing a public URL. Read access, registration and an issue result do not prove that its attachments were uploaded.

References: [Linear's official MCP setup](https://linear.app/docs/mcp), [Claude Code MCP management and authentication](https://code.claude.com/docs/en/mcp).
