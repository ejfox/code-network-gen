'use strict';

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function generateGexf(nodes, edges) {
  const timestamp = new Date().toISOString().split('T')[0];
  const nodeRows = nodes.map((node) => {
    const nodeId = escapeXml(node.id);
    const nodeLabel = escapeXml(node.label || node.id);
    const nodeType = escapeXml(node.type || 'unknown');
    const nodeLines = escapeXml(node.lines || '');

    return `      <node id="${nodeId}" label="${nodeLabel}">
        <attvalues>
          <attvalue for="0" value="${nodeType}"/>
          <attvalue for="1" value="${nodeLines}"/>
        </attvalues>
      </node>`;
  });

  const edgeRows = edges.map((edge, index) => {
    const edgeId = `e${index}`;
    const source = escapeXml(edge.source);
    const target = escapeXml(edge.target);
    const edgeType = escapeXml(edge.type || 'unknown');

    return `      <edge id="${edgeId}" source="${source}" target="${target}">
        <attvalues>
          <attvalue for="0" value="${edgeType}"/>
        </attvalues>
      </edge>`;
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<gexf xmlns="http://gexf.net/1.2" version="1.2">
  <meta lastmodifieddate="${timestamp}">
    <creator>code-network-gen</creator>
    <description>Network analysis of JavaScript code structure</description>
  </meta>
  <graph mode="static" defaultedgetype="directed">
    <attributes class="node">
      <attribute id="0" title="type" type="string"/>
      <attribute id="1" title="lines" type="string"/>
    </attributes>
    <attributes class="edge">
      <attribute id="0" title="type" type="string"/>
    </attributes>
    <nodes>
${nodeRows.join('\n')}
    </nodes>
    <edges>
${edgeRows.join('\n')}
    </edges>
  </graph>
</gexf>`;
}

function generateGraphml(nodes, edges) {
  const nodeRows = nodes.map((node) => {
    const nodeId = escapeXml(node.id);
    const nodeLabel = escapeXml(node.label || node.id);
    const nodeType = escapeXml(node.type || 'unknown');
    const nodeLines = escapeXml(node.lines || '');

    return `    <node id="${nodeId}">
      <data key="d0">${nodeLabel}</data>
      <data key="d1">${nodeType}</data>
      <data key="d2">${nodeLines}</data>
    </node>`;
  });

  const edgeRows = edges.map((edge, index) => {
    const edgeId = `e${index}`;
    const source = escapeXml(edge.source);
    const target = escapeXml(edge.target);
    const edgeType = escapeXml(edge.type || 'unknown');

    return `    <edge id="${edgeId}" source="${source}" target="${target}">
      <data key="d3">${edgeType}</data>
    </edge>`;
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<graphml xmlns="http://graphml.graphdrawing.org/xmlns"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://graphml.graphdrawing.org/xmlns
         http://graphml.graphdrawing.org/xmlns/1.0/graphml.xsd">
  <key id="d0" for="node" attr.name="label" attr.type="string"/>
  <key id="d1" for="node" attr.name="type" attr.type="string"/>
  <key id="d2" for="node" attr.name="lines" attr.type="string"/>
  <key id="d3" for="edge" attr.name="type" attr.type="string"/>
  <graph id="CodeNetwork" edgedefault="directed">
${nodeRows.join('\n')}
${edgeRows.join('\n')}
  </graph>
</graphml>`;
}

function escapeDot(str) {
  return String(str).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function dotNodeColor(nodeType) {
  switch (nodeType) {
    case 'class':
      return 'lightyellow';
    case 'dependency':
      return 'khaki';
    case 'function':
      return 'lightgreen';
    case 'global':
      return 'mistyrose';
    case 'method':
      return 'lightcoral';
    default:
      return 'lightgray';
  }
}

function dotEdgeStyle(edgeType) {
  switch (edgeType) {
    case 'calls':
      return ' [color=blue, label="calls"]';
    case 'imports':
      return ' [color=green, label="imports", style=dashed]';
    case 'requires':
      return ' [color=darkgreen, label="requires", style=dashed]';
    default:
      return ` [label="${escapeDot(edgeType)}"]`;
  }
}

function generateDot(nodes, edges) {
  const lines = [
    'digraph CodeNetwork {',
    '  graph [rankdir=TB, splines=true];',
    '  node [shape=box, style=filled, fillcolor=lightblue];',
    '  edge [color=gray];',
    '',
  ];

  for (const node of nodes) {
    const nodeId = escapeDot(node.id);
    const nodeType = node.type || 'unknown';
    const labelParts = [
      node.label || node.id,
      node.lines,
      `(${nodeType})`,
    ].filter(Boolean);
    const nodeLabel = escapeDot(labelParts.join('\\n'));
    lines.push(
      `  "${nodeId}" [label="${nodeLabel}", fillcolor=${dotNodeColor(nodeType)}];`,
    );
  }

  lines.push('');

  for (const edge of edges) {
    const source = escapeDot(edge.source);
    const target = escapeDot(edge.target);
    const edgeType = edge.type || 'unknown';
    lines.push(`  "${source}" -> "${target}"${dotEdgeStyle(edgeType)};`);
  }

  lines.push('}');
  return `${lines.join('\n')}\n`;
}

function escapeMermaidId(str) {
  return String(str)
    .replace(/[[\]{}"'():./\s-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function escapeMermaidLabel(str) {
  return String(str).replace(/["']/g, '');
}

function getNodeShape(nodeType) {
  switch (nodeType) {
    case 'class':
      return ['{{', '}}'];
    case 'dependency':
      return ['[', ']'];
    case 'global':
      return ['>', ']'];
    case 'method':
      return ['(', ')'];
    default:
      return ['[', ']'];
  }
}

function filterForMermaid(nodes, edges) {
  const maxNodes = 50;
  const maxEdges = 100;

  if (nodes.length <= maxNodes && edges.length <= maxEdges) {
    const nodeIds = new Set(nodes.map((node) => node.id));
    return {
      edges: edges.filter(
        (edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target),
      ),
      nodes,
    };
  }

  const connectionCounts = new Map(nodes.map((node) => [node.id, 0]));

  for (const edge of edges) {
    connectionCounts.set(
      edge.source,
      (connectionCounts.get(edge.source) || 0) + 1,
    );
    connectionCounts.set(
      edge.target,
      (connectionCounts.get(edge.target) || 0) + 1,
    );
  }

  const typeScores = {
    class: 3,
    dependency: 1,
    function: 2,
    global: 1,
    method: 1,
  };

  const selectedNodes = nodes
    .map((node) => {
      const connections = connectionCounts.get(node.id) || 0;
      const typeScore = typeScores[node.type] || 0;
      const nameLength = (node.label || node.id).length;

      return {
        ...node,
        score:
          connections * 5 + typeScore * 3 + Math.max(0, (50 - nameLength) / 10),
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, maxNodes);

  const selectedIds = new Set(selectedNodes.map((node) => node.id));
  const selectedEdges = edges
    .filter(
      (edge) => selectedIds.has(edge.source) && selectedIds.has(edge.target),
    )
    .slice(0, maxEdges);

  return {
    edges: selectedEdges,
    nodes: selectedNodes,
  };
}

function generateMermaid(nodes, edges) {
  const { nodes: filteredNodes, edges: filteredEdges } = filterForMermaid(
    nodes,
    edges,
  );
  const idMapping = new Map();
  const lines = [
    'flowchart TD',
    '    %% Code Network Analysis - Generated by code-network-gen',
    `    %% Total nodes: ${filteredNodes.length}, Total edges: ${filteredEdges.length}`,
    '',
  ];

  for (const node of filteredNodes) {
    const nodeId = escapeMermaidId(node.id);
    const labelParts = [
      node.label || node.id.split(':').pop() || 'unknown',
      node.lines,
      `(${node.type || 'unknown'})`,
    ].filter(Boolean);
    const nodeLabel = escapeMermaidLabel(labelParts.join(' '));
    const [shapeStart, shapeEnd] = getNodeShape(node.type);

    idMapping.set(node.id, nodeId);
    lines.push(`    ${nodeId}${shapeStart}"${nodeLabel}"${shapeEnd}`);
  }

  if (filteredNodes.length > 0 && filteredEdges.length > 0) {
    lines.push('', '    %% Connections');
  }

  for (const edge of filteredEdges) {
    const sourceId = idMapping.get(edge.source);
    const targetId = idMapping.get(edge.target);
    if (!sourceId || !targetId) continue;

    const arrowStyle = ['imports', 'requires'].includes(edge.type)
      ? '-.->'
      : '-->';
    lines.push(`    ${sourceId} ${arrowStyle} ${targetId}`);
  }

  lines.push(
    '',
    '    %% Styling',
    '    classDef functionClass fill:#e1f5fe,stroke:#01579b,stroke-width:2px',
    '    classDef methodClass fill:#f3e5f5,stroke:#4a148c,stroke-width:2px',
    '    classDef classClass fill:#fff3e0,stroke:#e65100,stroke-width:2px',
    '    classDef globalClass fill:#ffebee,stroke:#c62828,stroke-width:2px',
    '    classDef dependencyClass fill:#fff8e1,stroke:#ff8f00,stroke-width:2px',
  );

  const nodesByType = new Map();
  for (const node of filteredNodes) {
    const nodeId = idMapping.get(node.id);
    if (!nodeId) continue;

    const type = node.type || 'unknown';
    if (!nodesByType.has(type)) {
      nodesByType.set(type, []);
    }
    nodesByType.get(type).push(nodeId);
  }

  const classNames = {
    class: 'classClass',
    dependency: 'dependencyClass',
    function: 'functionClass',
    global: 'globalClass',
    method: 'methodClass',
  };

  for (const [type, nodeIds] of nodesByType.entries()) {
    if (classNames[type] && nodeIds.length > 0) {
      lines.push(`    class ${nodeIds.join(',')} ${classNames[type]}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

module.exports = {
  generateDot,
  generateGexf,
  generateGraphml,
  generateMermaid,
};
