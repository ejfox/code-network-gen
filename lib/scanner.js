'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_IGNORE_DIRS = new Set([
  // Agent worktrees hold whole copies of the repo and duplicate every node.
  '.claude',
  '.git',
  '.next',
  '.nuxt',
  '.output',
  '.turbo',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
]);

const SUPPORTED_EXTENSIONS = new Set([
  '.cjs',
  '.js',
  '.jsx',
  '.mjs',
  '.ts',
  '.tsx',
  '.vue',
]);

function normalizePath(filePath) {
  return filePath.split(path.sep).join('/');
}

function isMinifiedFile(relativePath, content) {
  const fileName = path.basename(relativePath);
  if (fileName.includes('.min.')) return true;

  const sample = content.slice(0, 2000);
  return sample.split('\n').some((line) => line.length > 300);
}

function scanDirectory(rootDir, options = {}) {
  const ignoreDirs = new Set([
    ...DEFAULT_IGNORE_DIRS,
    ...(options.ignoreDirs || []),
  ]);
  const files = [];
  const errors = [];

  function walkDirectory(currentDir) {
    let entries;

    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch (error) {
      errors.push({
        file: normalizePath(path.relative(rootDir, currentDir)) || '.',
        message: error.message,
      });
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relativePath = normalizePath(path.relative(rootDir, fullPath));

      if (entry.isDirectory()) {
        if (!ignoreDirs.has(entry.name)) {
          walkDirectory(fullPath);
        }
        continue;
      }

      if (!entry.isFile()) continue;

      const ext = path.extname(entry.name).toLowerCase();
      if (!SUPPORTED_EXTENSIONS.has(ext)) continue;

      try {
        const content = fs.readFileSync(fullPath, 'utf8');
        if (!isMinifiedFile(relativePath, content)) {
          files.push({
            absolutePath: fullPath,
            content,
            ext,
            relativePath,
          });
        }
      } catch (error) {
        errors.push({
          file: relativePath,
          message: error.message,
        });
      }
    }
  }

  walkDirectory(rootDir);

  return {
    errors,
    files,
    processedFiles: files.length,
  };
}

module.exports = {
  scanDirectory,
};
