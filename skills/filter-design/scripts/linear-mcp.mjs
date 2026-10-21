// Configure the official Linear MCP in Claude Code without copying OAuth credentials.
import { spawnSync } from 'node:child_process';

export const LINEAR_MCP_URL = 'https://mcp.linear.app/mcp';
const SERVER = 'linear-server';
const LOGIN = 'Open Claude Code in this project, run /mcp, select Linear and complete the browser sign-in. Then discover the Linear tools and verify access with a read-only request.';

function entry(line) {
  const m = /^(.+?):\s+(https:\/\/\S+)\s+\((?:HTTP|SSE)\)\s+-\s+(.+)$/i.exec(line.trim());
  if (!m) return null;
  let url;
  try { url = new URL(m[2]); } catch { return null; }
  const route = url.pathname.replace(/\/$/, '');
  if (url.origin !== 'https://mcp.linear.app' || url.username || url.password || url.search || url.hash || !['/mcp', '/mcp/readonly', '/sse'].includes(route)) return null;
  const status = m[3].replace(/^[✓✔]\s*/, '');
  return {
    server: m[1],
    status: route === '/mcp/readonly' ? 'read_only'
      : /^Connected\b/i.test(status) ? 'connected'
        : /needs authentication|not authenticated|unauthenticated/i.test(status) ? 'needs_authentication'
          : /pending approval/i.test(status) ? 'approval_required' : 'connection_unverified',
  };
}

/** A registered server is not proof that OAuth or the requested Linear operation succeeded. */
export function ensureLinearMcp(root, { connect = true, run = spawnSync } = {}) {
  const call = (args) => run('claude', ['mcp', ...args], {
    cwd: root, encoding: 'utf8', timeout: 10_000, maxBuffer: 256 << 10,
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' },
  });
  const result = (status, extra = {}) => ({
    transport: 'claude_mcp', status, ...extra,
    next: status === 'connected' ? 'Discover the Linear MCP tools in the active Claude session and verify access with a read-only request.'
      : status === 'cli_missing' ? 'Open this project in Claude Code with the Linear connector, or install Claude Code and retry. Keep the prepared task data.'
        : status === 'name_conflict' ? 'An existing MCP uses the name linear-server for a different endpoint. Inspect it in /mcp; do not replace it automatically.'
          : LOGIN,
  });
  // Capture but never echo CLI output: MCP diagnostics can contain headers or auth links.
  const listed = call(['list']);
  if (listed.error?.code === 'ENOENT') return result('cli_missing');
  if (listed.error || listed.status !== 0) return result('discovery_failed');
  const lines = String(listed.stdout ?? '').replace(/\x1b\[[0-9;]*m/g, '').split('\n');
  const known = lines.map(entry).filter(Boolean);
  if (known.length) {
    const found = known.find((x) => x.status === 'connected') ?? known.find((x) => x.status !== 'read_only') ?? known[0];
    return result(found.status, { server: found.server, added: false });
  }
  if (lines.some((line) => /^\s*linear-server:/.test(line))) return result('name_conflict');
  if (lines.some((line) => line.includes('mcp.linear.app'))) return result('connection_unverified', { added: false });
  // An unrecognized listing must not cause a duplicate registration.
  if (!lines.some((line) => /No MCP servers configured/i.test(line) || /^.+?:\s+.+\s+-\s+.+$/.test(line))) return result('discovery_failed');
  if (!connect) return result('not_configured');
  const added = call(['add', '--transport', 'http', '--scope', 'local', SERVER, LINEAR_MCP_URL]);
  if (added.error || added.status !== 0) return result('configuration_failed');
  const checked = call(['list']);
  const found = !checked.error && checked.status === 0
    ? String(checked.stdout ?? '').replace(/\x1b\[[0-9;]*m/g, '').split('\n').map(entry).find((x) => x?.server === SERVER)
    : null;
  return result(found?.status ?? 'registered', { server: SERVER, added: true });
}
