import fs from 'node:fs';
import path from 'node:path';

/** A local CLI double: never reads/writes the user's Claude configuration. */
export function mockClaude(root) {
  const bin = path.join(root, 'mock-cli');
  fs.mkdirSync(bin, { recursive: true });
  const state = path.join(root, 'mock-mcp-state.json');
  const log = path.join(root, 'mock-mcp-calls.jsonl');
  const file = path.join(bin, 'claude');
  fs.writeFileSync(file, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.MCP_TEST_LOG, JSON.stringify(args) + '\\n');
if (args.join(' ') === 'mcp list') {
  console.log(fs.existsSync(process.env.MCP_TEST_STATE)
    ? 'linear-server: https://mcp.linear.app/mcp (HTTP) - ! Needs authentication'
    : 'No MCP servers configured.');
} else if (args[0] === 'mcp' && args[1] === 'add') {
  fs.writeFileSync(process.env.MCP_TEST_STATE, '{}');
  console.log('Added MCP server.');
} else { process.exit(2); }
`, { mode: 0o755 });
  return { PATH: `${bin}${path.delimiter}${process.env.PATH}`, MCP_TEST_STATE: state, MCP_TEST_LOG: log };
}
