'use strict';

const SKIP_KEYS = new Set([
  'comments',
  'loc',
  'parent',
  'range',
  'raw',
  'tokens',
]);

function isNode(value) {
  return value && typeof value.type === 'string';
}

function traverse(node, visitors, ancestors = []) {
  if (!isNode(node)) return;

  const parent = ancestors[ancestors.length - 1] || null;
  const shouldSkip = visitors.enter?.(node, parent, ancestors) === false;

  if (!shouldSkip) {
    ancestors.push(node);

    for (const [key, value] of Object.entries(node)) {
      if (SKIP_KEYS.has(key)) continue;

      if (Array.isArray(value)) {
        for (const child of value) {
          traverse(child, visitors, ancestors);
        }
      } else if (isNode(value)) {
        traverse(value, visitors, ancestors);
      }
    }

    ancestors.pop();
  }

  visitors.leave?.(node, parent, ancestors);
}

module.exports = {
  traverse,
};
