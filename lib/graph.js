'use strict';

function createGraph() {
  const nodes = new Map();
  const edges = new Map();

  function addNode(file, name, type, lines = '') {
    if (!file || !name) return null;

    const id = `${file}:${name}`;
    const existing = nodes.get(id);

    if (existing) {
      if (lines && existing.lines && !existing.lines.includes(lines)) {
        existing.lines = `${existing.lines}, ${lines}`;
      } else if (lines && !existing.lines) {
        existing.lines = lines;
      }
      return existing;
    }

    const node = {
      file,
      id,
      label: name,
      name,
      type,
      lines,
    };

    nodes.set(id, node);
    return node;
  }

  function addGlobalNode(file) {
    return addNode(file, 'global', 'global', '');
  }

  function addEdge(sourceFile, sourceName, targetFile, targetName, type) {
    if (!sourceFile || !sourceName || !targetFile || !targetName) return;

    const source = `${sourceFile}:${sourceName}`;
    const target = `${targetFile}:${targetName}`;
    const key = `${source}\u0000${target}\u0000${type}`;

    if (!edges.has(key)) {
      edges.set(key, { source, target, type });
    }
  }

  function buildNameIndex() {
    const index = new Map();

    for (const node of nodes.values()) {
      if (!index.has(node.label)) {
        index.set(node.label, []);
      }
      index.get(node.label).push(node);
    }

    return index;
  }

  function toJSON() {
    return {
      nodes: Array.from(nodes.values()),
      edges: Array.from(edges.values()),
    };
  }

  return {
    addEdge,
    addGlobalNode,
    addNode,
    buildNameIndex,
    toJSON,
  };
}

module.exports = {
  createGraph,
};
