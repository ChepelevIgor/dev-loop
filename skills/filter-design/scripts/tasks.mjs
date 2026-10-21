#!/usr/bin/env node
// Read specific Linear tasks for start-task or sim-verify-task; never create/update issues.
//   node scripts/tasks.mjs show T-10 [T-11 ...] [--root <application project>]
//   IDs may also be comma-separated. Each task keeps its own description and links.
// Without LINEAR_API_KEY, try the Linear MCP in Claude Code and return the exact IDs to read.
import path from 'node:path';
import { cliHelp, isMain } from './lib.mjs';
import { client, linearKey } from './linear.mjs';
import { ensureLinearMcp } from './linear-mcp.mjs';

export function taskIds(values) {
  const ids = values.flatMap((value) => value.split(',')).map((value) => value.trim().toUpperCase());
  if (!ids.length || ids.some((id) => !/^[A-Z][A-Z0-9]*-\d+$/.test(id))) throw new Error('Provide Linear task IDs, for example T-10 T-11');
  return [...new Set(ids)];
}

export async function readTasks(values, { root = process.cwd(), key = linearKey(root), getClient = client, connect = ensureLinearMcp } = {}) {
  const identifiers = taskIds(values);
  if (!key) return { status: 'needs_mcp', operation: 'read_tasks', identifiers, tasks: [], connection: connect(root),
    next: 'In Claude, discover the Linear MCP tools and read each requested issue, its description, acceptance criteria and linked PRs. This is read-only; do not create issues or comments. Preserve these IDs while browser sign-in is pending.' };
  const L = getClient(key);
  const tasks = [];
  const unavailable = [];
  for (const id of identifiers) {
    try { tasks.push(await L.taskDetails(id)); }
    catch { unavailable.push({ identifier: id, reason: 'Could not read the complete task. Check its ID, account access and Linear connection before reviewing it.' }); }
  }
  return { status: unavailable.length ? (tasks.length ? 'partial' : 'unavailable') : 'ready', identifiers, tasks, unavailable };
}

async function main() {
  const argv = process.argv.slice(2);
  if (cliHelp(argv, import.meta.url)) return;
  if (argv.shift() !== 'show') throw new Error('Use: tasks.mjs show T-10 [T-11 ...] [--root <project>]');
  let root = process.cwd();
  const ids = [];
  while (argv.length) {
    const value = argv.shift();
    if (value === '--root') {
      if (!argv.length || argv[0].startsWith('--')) throw new Error('--root needs a project directory');
      root = path.resolve(argv.shift());
    } else {
      if (value.startsWith('--')) throw new Error('Unknown option; use --help');
      ids.push(value);
    }
  }
  console.log(JSON.stringify(await readTasks(ids, { root })));
}

if (isMain(import.meta.url)) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
