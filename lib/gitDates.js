'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');

const run = promisify(execFile);

async function git(cwd, args) {
  try {
    const { stdout } = await run('git', args, {
      cwd,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/** first commit that added the file, following renames */
async function fileCreated(cwd, file) {
  const dates = await git(cwd, [
    'log',
    '--follow',
    '--diff-filter=A',
    '--format=%as',
    '--',
    `:(literal)${file}`,
  ]);
  return dates[dates.length - 1] || null;
}

/** first commit on this path that changed how often `name` appears */
async function nameFirstSeen(cwd, file, name) {
  const dates = await git(cwd, [
    'log',
    '--reverse',
    '--format=%as',
    `-S${name}`,
    '--',
    `:(literal)${file}`,
  ]);
  return dates[0] || null;
}

async function pool(items, size, worker) {
  let next = 0;
  const lanes = Array.from(
    { length: Math.min(size, items.length) },
    async () => {
      while (next < items.length) {
        const item = items[next++];
        await worker(item);
      }
    },
  );
  await Promise.all(lanes);
}

/**
 * Sets `created` (YYYY-MM-DD) on each node from git history: a file's first
 * commit; a function's first commit that added its name to its file, never
 * earlier than the file (a rename restarts the path's history, so the later
 * of the two is right). Nodes outside git history are left without one.
 */
async function addGitDates(nodes, cwd, { concurrency = 8 } = {}) {
  const files = [
    ...new Set(
      nodes.map((node) => node.file).filter((f) => f && f !== 'package.json'),
    ),
  ];
  const created = new Map();
  await pool(files, concurrency, async (file) => {
    created.set(file, await fileCreated(cwd, file));
  });
  await pool(nodes, concurrency, async (node) => {
    if (!node.file || node.file === 'package.json') return;
    const born = created.get(node.file);
    if (node.name === 'global') {
      if (born) node.created = born;
      return;
    }
    const seen = await nameFirstSeen(cwd, node.file, node.name);
    const date = seen && (!born || seen > born) ? seen : born;
    if (date) node.created = date;
  });
  return nodes;
}

module.exports = { addGitDates };
