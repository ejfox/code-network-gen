#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const walk = require('acorn-walk');
const { program } = require('commander');
const compiler = require('vue-template-compiler');
const { parse } = require('json2csv');
const { parse: babelParse } = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const nodes = [];
const edges = [];
const methodRegistry = new Map(); // To store method definitions by file and name

// Store available dependencies for efficient lookup
let availableDependencies = new Set();

// Function to load package.json dependencies for reference
function loadPackageDependencies(directoryPath) {
  const packagePath = path.join(directoryPath, 'package.json');
  if (!fs.existsSync(packagePath)) return;
  
  try {
    const packageContent = fs.readFileSync(packagePath, 'utf8');
    const packageData = JSON.parse(packageContent);
    
    const deps = {
      ...packageData.dependencies || {},
      ...packageData.devDependencies || {}
    };
    
    availableDependencies = new Set(Object.keys(deps));
    console.log(`Loaded ${availableDependencies.size} dependencies for import tracking`);
  } catch (error) {
    console.warn(`Could not parse package.json: ${error.message}`);
  }
}


function addNode(file, name, type, lines) {
  const id = `${file}:${name}`;
  methodRegistry.set(id, { file, name, type, lines });
  nodes.push({ id, label: name, type, lines });
}

function addEdge(sourceFile, sourceMethod, targetFile, targetMethod, type) {
  const sourceId = `${sourceFile}:${sourceMethod}`;
  const targetId = `${targetFile}:${targetMethod}`;
  if (methodRegistry.has(targetId)) {
    edges.push({ source: sourceId, target: targetId, type });
  }
}

const parseFile = (filePath) => {
  const content = fs.readFileSync(filePath, 'utf8');
  const ext = path.extname(filePath).toLowerCase();
  
  if (ext === '.vue') {
    const parsed = compiler.parseComponent(content);
    if (parsed.script) parseJavaScript(filePath, parsed.script.content);
  } else {
    parseJavaScript(filePath, content);
  }
};

const getEnclosingFunctionName = (node) => {
  let parent = node;
  while ((parent = parent.parent)) {
    if (parent.type === 'FunctionDeclaration' && parent.id) return parent.id.name;
  }
  return 'global';
};

const parseJavaScript = (filePath, content) => {
  try {
    const ast = acorn.parse(content, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
    const fileName = path.basename(filePath);
    
    walk.simple(ast, {
      FunctionDeclaration(node) {
        if (node.id?.name) {
          const lines = `[${node.loc.start.line}-${node.loc.end.line}]`;
          addNode(fileName, node.id.name, 'function', lines);
        }
      },
      ImportDeclaration(node) {
        if (node.source?.value && availableDependencies.has(node.source.value)) {
          const depName = node.source.value;
          addNode('package.json', depName, 'dependency', '[-]');
          addEdge(fileName, 'global', 'package.json', depName, 'imports');
        }
      },
      CallExpression(node) {
        // Handle require() calls
        if (node.callee?.name === 'require' && node.arguments[0]?.type === 'Literal') {
          const depName = node.arguments[0].value;
          if (availableDependencies.has(depName)) {
            const parentFunction = getEnclosingFunctionName(node);
            addNode('package.json', depName, 'dependency', '[-]');
            addEdge(fileName, parentFunction, 'package.json', depName, 'requires');
          }
        }
        // Handle function calls
        if (node.callee?.type === 'Identifier') {
          const calleeName = node.callee.name;
          const parentFunction = getEnclosingFunctionName(node);
          methodRegistry.forEach((info) => {
            if (info.name === calleeName) {
              addEdge(fileName, parentFunction, info.file, calleeName, 'calls');
            }
          });
        }
      }
    });
  } catch (error) {
    console.warn(`Could not parse ${filePath}: ${error.message}`);
  }
};

const scanDirectory = (directory) => {
  const ignoreDirs = ['node_modules', '.git', 'build', 'dist'];
  const allowedExtensions = ['.js', '.jsx', '.ts', '.tsx', '.vue', '.mjs'];
  
  const isMinifiedFile = (filename, content) => {
    if (filename.includes('.min.') || filename.includes('/dist/')) return true;
    if (content && content.substring(0, 500).split('\n').some(line => line.length > 300)) return true;
    return false;
  };

  const walk = (dir) => {
    try {
      const items = fs.readdirSync(dir);
      for (const item of items) {
        const fullPath = path.join(dir, item);
        const stat = fs.statSync(fullPath);
        
        if (stat.isDirectory() && !ignoreDirs.includes(item)) {
          walk(fullPath);
        } else if (stat.isFile() && allowedExtensions.includes(path.extname(item).toLowerCase())) {
          const content = fs.readFileSync(fullPath, 'utf8');
          if (!isMinifiedFile(fullPath, content)) {
            parseFile(fullPath);
          }
        }
      }
    } catch (error) {
      // Skip inaccessible directories/files
    }
  };

  walk(directory);
  return { processedFiles: 0, totalFiles: 0, errors: [] };
};

// Function to deduplicate nodes and edges
const deduplicate = (nodes, edges) => {
  const uniqueNodes = new Map();
  const uniqueEdges = new Map();
  const referencedNodes = new Set();

  // Deduplicate nodes
  nodes.forEach((node) => {
    const { id, type, lines } = node;
    const key = `${id}-${type}`;
    if (!uniqueNodes.has(key)) {
      uniqueNodes.set(key, node);
    } else {
      const existingNode = uniqueNodes.get(key);
      if (lines && existingNode.lines) {
        existingNode.lines += `, ${lines}`;
      }
    }
  });

  // Deduplicate edges and track referenced nodes
  edges.forEach((edge) => {
    const { source, target, type } = edge;
    const key = `${source}-${target}-${type}`;
    if (!uniqueEdges.has(key)) {
      uniqueEdges.set(key, edge);
      referencedNodes.add(source);
      referencedNodes.add(target);
    }
  });

  // Filter nodes to only include those that are referenced
  const filteredNodes = Array.from(uniqueNodes.values()).filter(({ id }) =>
    referencedNodes.has(id),
  );

  return {
    nodes: filteredNodes,
    edges: Array.from(uniqueEdges.values()),
  };
};

// Function to display the results, including all method interactions
const displayResults = (filterAnonymous = true) => {
  const { nodes: uniqueNodes, edges: uniqueEdges } = deduplicate(nodes, edges);

  const filteredNodes = filterAnonymous
    ? uniqueNodes.filter(
      ({ label }) => label && !label.includes('anonymous'),
    )
    : uniqueNodes;

  const filteredEdges = filterAnonymous
    ? uniqueEdges.filter(
      ({ label }) => label && !label.includes('anonymous'),
    )
    : uniqueEdges;

  console.log('Nodes:');
  filteredNodes.forEach(({ id, label, type }) => {
    const nodeLabel = label || '';
    console.log(`${id} - ${nodeLabel} (${type})`);
  });

  console.log('\nEdges:');
  filteredEdges.forEach(({ source, target, type }) => {
    console.log(`${source} -> ${target} (${type})`);
  });

  console.log(`\nTotal unique nodes: ${filteredNodes.length}`);
  console.log(`Total unique edges: ${filteredEdges.length}`);
};

// Function to generate GEXF (Graph Exchange XML Format) content
function generateGexf(nodes, edges) {
  const escapeXml = (str) => {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  };

  const timestamp = new Date().toISOString().split('T')[0];
  
  let gexf = `<?xml version="1.0" encoding="UTF-8"?>
<gexf xmlns="http://gexf.net/1.2" version="1.2">
  <meta lastmodifieddate="${timestamp}">
    <creator>code-network-gen</creator>
    <description>Network analysis of JavaScript code structure</description>
  </meta>
  <graph mode="static" defaultedgetype="directed">
    <attributes class="node">
      <attribute id="0" title="type" type="string"/>
      <attribute id="1" title="lines" type="integer"/>
    </attributes>
    <attributes class="edge">
      <attribute id="0" title="type" type="string"/>
    </attributes>
    <nodes>
`;

  // Add nodes
  nodes.forEach((node, index) => {
    const nodeId = escapeXml(node.id);
    const nodeLabel = escapeXml(node.label || node.id);
    const nodeType = escapeXml(node.type || 'unknown');
    const nodeLines = node.lines || 0;
    
    gexf += `      <node id="${nodeId}" label="${nodeLabel}">
        <attvalues>
          <attvalue for="0" value="${nodeType}"/>
          <attvalue for="1" value="${nodeLines}"/>
        </attvalues>
      </node>
`;
  });

  gexf += `    </nodes>
    <edges>
`;

  // Add edges
  edges.forEach((edge, index) => {
    const edgeId = `e${index}`;
    const source = escapeXml(edge.source);
    const target = escapeXml(edge.target);
    const edgeType = escapeXml(edge.type || 'unknown');
    
    gexf += `      <edge id="${edgeId}" source="${source}" target="${target}">
        <attvalues>
          <attvalue for="0" value="${edgeType}"/>
        </attvalues>
      </edge>
`;
  });

  gexf += `    </edges>
  </graph>
</gexf>`;

  return gexf;
}

// Function to generate GraphML (Graph Markup Language) content
function generateGraphml(nodes, edges) {
  const escapeXml = (str) => {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  };

  let graphml = `<?xml version="1.0" encoding="UTF-8"?>
<graphml xmlns="http://graphml.graphdrawing.org/xmlns"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://graphml.graphdrawing.org/xmlns
         http://graphml.graphdrawing.org/xmlns/1.0/graphml.xsd">
  <!-- Key definitions for node attributes -->
  <key id="d0" for="node" attr.name="label" attr.type="string"/>
  <key id="d1" for="node" attr.name="type" attr.type="string"/>
  <key id="d2" for="node" attr.name="lines" attr.type="string"/>
  
  <!-- Key definitions for edge attributes -->
  <key id="d3" for="edge" attr.name="type" attr.type="string"/>
  
  <graph id="CodeNetwork" edgedefault="directed">
`;

  // Add nodes
  nodes.forEach((node) => {
    const nodeId = escapeXml(node.id);
    const nodeLabel = escapeXml(node.label || node.id);
    const nodeType = escapeXml(node.type || 'unknown');
    const nodeLines = escapeXml(node.lines || '');
    
    graphml += `    <node id="${nodeId}">
      <data key="d0">${nodeLabel}</data>
      <data key="d1">${nodeType}</data>
      <data key="d2">${nodeLines}</data>
    </node>
`;
  });

  // Add edges
  edges.forEach((edge, index) => {
    const edgeId = `e${index}`;
    const source = escapeXml(edge.source);
    const target = escapeXml(edge.target);
    const edgeType = escapeXml(edge.type || 'unknown');
    
    graphml += `    <edge id="${edgeId}" source="${source}" target="${target}">
      <data key="d3">${edgeType}</data>
    </edge>
`;
  });

  graphml += `  </graph>
</graphml>`;

  return graphml;
}

// Function to generate DOT (Graphviz) content
function generateDot(nodes, edges) {
  const escapeDot = (str) => {
    return String(str)
      .replace(/\\/g, '\\\\')  // Escape backslashes first
      .replace(/"/g, '\\"');   // Escape double quotes
  };

  let dot = `digraph CodeNetwork {\n`;
  dot += `  // Graph attributes\n`;
  dot += `  graph [rankdir=TB, splines=true];\n`;
  dot += `  node [shape=box, style=filled, fillcolor=lightblue];\n`;
  dot += `  edge [color=gray];\n\n`;

  // Add nodes
  dot += `  // Nodes\n`;
  nodes.forEach((node) => {
    const nodeId = escapeDot(node.id);
    const nodeLabel = escapeDot(node.label || node.id);
    const nodeType = node.type || 'unknown';
    const nodeLines = node.lines || '';
    
    // Create a more descriptive label
    let fullLabel = nodeLabel;
    if (nodeLines) {
      fullLabel += `\\n${nodeLines}`;
    }
    if (nodeType) {
      fullLabel += `\\n(${nodeType})`;
    }
    
    // Set different colors based on node type
    let nodeColor = 'lightblue';
    switch (nodeType) {
      case 'function':
        nodeColor = 'lightgreen';
        break;
      case 'method':
        nodeColor = 'lightcoral';
        break;
      case 'class':
        nodeColor = 'lightyellow';
        break;
      case 'vue-method':
        nodeColor = 'lightpink';
        break;
      default:
        nodeColor = 'lightgray';
    }
    
    dot += `  "${nodeId}" [label="${fullLabel}", fillcolor=${nodeColor}];\n`;
  });

  dot += `\n  // Edges\n`;
  // Add edges
  edges.forEach((edge) => {
    const source = escapeDot(edge.source);
    const target = escapeDot(edge.target);
    const edgeType = edge.type || 'unknown';
    
    // Set different edge styles based on edge type
    let edgeStyle = '';
    switch (edgeType) {
      case 'calls':
        edgeStyle = ' [color=blue, label="calls"]';
        break;
      case 'imports':
        edgeStyle = ' [color=green, label="imports", style=dashed]';
        break;
      default:
        edgeStyle = ` [label="${edgeType}"]`;
    }
    
    dot += `  "${source}" -> "${target}"${edgeStyle};\n`;
  });

  dot += `}\n`;

  return dot;
}

// Function to generate Mermaid flowchart content
function generateMermaid(nodes, edges) {
  const escapeMermaid = (str) => {
    return String(str)
      .replace(/[[\]]/g, '')  // Remove square brackets that conflict with Mermaid syntax
      .replace(/[{}]/g, '')   // Remove curly braces that conflict with Mermaid syntax
      .replace(/["']/g, '')   // Remove quotes that might cause issues
      .replace(/[()]/g, '')   // Remove parentheses that might conflict
      .replace(/:/g, '_')     // Replace colons with underscores for node IDs
      .replace(/\./g, '_')    // Replace dots with underscores
      .replace(/\//g, '_')    // Replace slashes with underscores
      .replace(/\s+/g, '_')   // Replace spaces with underscores
      .replace(/-/g, '_');    // Replace hyphens with underscores for consistency
  };

  const createNodeId = (originalId) => {
    // Create a safe ID for Mermaid while keeping it readable
    return escapeMermaid(originalId).replace(/^_+|_+$/g, ''); // Remove leading/trailing underscores
  };

  const createNodeLabel = (node) => {
    const label = node.label || node.id.split(':').pop() || 'unknown';
    const type = node.type || 'unknown';
    const lines = node.lines || '';
    
    // Create a descriptive label
    let fullLabel = label;
    if (lines) {
      fullLabel += ` ${lines}`;
    }
    fullLabel += ` (${type})`;
    
    return fullLabel.replace(/["']/g, ''); // Remove quotes to avoid syntax issues
  };

  const getNodeShape = (nodeType) => {
    // Return appropriate Mermaid node shape based on type
    switch (nodeType) {
      case 'function':
        return ['[', ']'];     // Rectangle for functions
      case 'method':
        return ['(', ')'];     // Round edges for methods
      case 'class':
        return ['{{', '}}'];   // Hexagon for classes
      case 'vue-method':
        return ['([', '])'];   // Stadium shape for Vue methods
      case 'global':
        return ['>', ']'];     // Asymmetric shape for global scope
      default:
        return ['[', ']'];     // Default rectangle
    }
  };

  // Filter and prioritize nodes for large codebases
  const filteredData = filterForMermaid(nodes, edges);
  const { nodes: filteredNodes, edges: filteredEdges } = filteredData;

  let mermaid = `flowchart TD\n`;
  mermaid += `    %% Code Network Analysis - Generated by code-network-gen\n`;
  mermaid += `    %% Total nodes: ${filteredNodes.length}, Total edges: ${filteredEdges.length}\n\n`;

  // Create a mapping of original IDs to Mermaid-safe IDs
  const idMapping = new Map();
  filteredNodes.forEach((node) => {
    const safeId = createNodeId(node.id);
    idMapping.set(node.id, safeId);
  });

  // Add nodes with appropriate shapes and labels
  filteredNodes.forEach((node) => {
    const nodeId = idMapping.get(node.id);
    const nodeLabel = createNodeLabel(node);
    const [shapeStart, shapeEnd] = getNodeShape(node.type);
    
    mermaid += `    ${nodeId}${shapeStart}"${nodeLabel}"${shapeEnd}\n`;
  });

  if (filteredNodes.length > 0 && filteredEdges.length > 0) {
    mermaid += `\n    %% Connections\n`;
  }

  // Add edges with appropriate arrow styles
  filteredEdges.forEach((edge) => {
    const sourceId = idMapping.get(edge.source);
    const targetId = idMapping.get(edge.target);
    
    if (sourceId && targetId) {
      const edgeType = edge.type || 'unknown';
      let arrowStyle = '-->';
      
      // Use different arrow styles based on edge type
      switch (edgeType) {
        case 'calls':
          arrowStyle = '-->';
          break;
        case 'imports':
          arrowStyle = '-.->'; // Dotted line for imports
          break;
        default:
          arrowStyle = '-->';
      }
      
      mermaid += `    ${sourceId} ${arrowStyle} ${targetId}\n`;
    }
  });

  // Add styling for different node types
  mermaid += `\n    %% Styling\n`;
  mermaid += `    classDef functionClass fill:#e1f5fe,stroke:#01579b,stroke-width:2px\n`;
  mermaid += `    classDef methodClass fill:#f3e5f5,stroke:#4a148c,stroke-width:2px\n`;
  mermaid += `    classDef classClass fill:#fff3e0,stroke:#e65100,stroke-width:2px\n`;
  mermaid += `    classDef vueMethodClass fill:#e8f5e8,stroke:#1b5e20,stroke-width:2px\n`;
  mermaid += `    classDef globalClass fill:#ffebee,stroke:#c62828,stroke-width:2px\n`;
  mermaid += `    classDef dependencyClass fill:#fff8e1,stroke:#ff8f00,stroke-width:2px\n`;

  // Apply classes to nodes
  const nodesByType = {
    function: [],
    method: [],
    class: [],
    'vue-method': [],
    global: [],
    dependency: []
  };

  filteredNodes.forEach((node) => {
    const nodeId = idMapping.get(node.id);
    const nodeType = node.type;
    if (nodesByType[nodeType]) {
      nodesByType[nodeType].push(nodeId);
    }
  });

  if (nodesByType.function.length > 0) {
    mermaid += `    class ${nodesByType.function.join(',')} functionClass\n`;
  }
  if (nodesByType.method.length > 0) {
    mermaid += `    class ${nodesByType.method.join(',')} methodClass\n`;
  }
  if (nodesByType.class.length > 0) {
    mermaid += `    class ${nodesByType.class.join(',')} classClass\n`;
  }
  if (nodesByType['vue-method'].length > 0) {
    mermaid += `    class ${nodesByType['vue-method'].join(',')} vueMethodClass\n`;
  }
  if (nodesByType.global.length > 0) {
    mermaid += `    class ${nodesByType.global.join(',')} globalClass\n`;
  }
  if (nodesByType.dependency.length > 0) {
    mermaid += `    class ${nodesByType.dependency.join(',')} dependencyClass\n`;
  }

  return mermaid;
}

// Function to intelligently filter nodes and edges for Mermaid diagrams to keep them readable
function filterForMermaid(nodes, edges) {
  const MAX_NODES = 50; // Limit for readable diagrams
  const MAX_EDGES = 100;

  // If the dataset is small enough, return as-is
  if (nodes.length <= MAX_NODES && edges.length <= MAX_EDGES) {
    // Add global nodes that are referenced in edges but don't exist as nodes
    const nodeIds = new Set(nodes.map(node => node.id));
    const referencedIds = new Set();
    
    edges.forEach(edge => {
      referencedIds.add(edge.source);
      referencedIds.add(edge.target);
    });
    
    const additionalNodes = [];
    referencedIds.forEach(id => {
      if (!nodeIds.has(id)) {
        // Create a global scope node
        const [fileName, functionName] = id.split(':');
        if (functionName === 'global') {
          additionalNodes.push({
            id,
            label: `${fileName} (global)`,
            type: 'global',
            lines: ''
          });
        }
      }
    });
    
    const allNodes = [...nodes, ...additionalNodes];
    const allNodeIds = new Set(allNodes.map(node => node.id));
    const validEdges = edges.filter(edge => 
      allNodeIds.has(edge.source) && allNodeIds.has(edge.target)
    );
    
    return { nodes: allNodes, edges: validEdges };
  }

  // Create a graph to analyze node importance
  const nodeConnections = new Map();
  const nodeTypes = new Map();
  
  // Initialize connection counts and store types
  nodes.forEach(node => {
    nodeConnections.set(node.id, 0);
    nodeTypes.set(node.id, node.type);
  });

  // Count connections (both incoming and outgoing)
  edges.forEach(edge => {
    const sourceCount = nodeConnections.get(edge.source) || 0;
    const targetCount = nodeConnections.get(edge.target) || 0;
    nodeConnections.set(edge.source, sourceCount + 1);
    nodeConnections.set(edge.target, targetCount + 1);
  });

  // Score nodes based on:
  // 1. Number of connections (highly connected nodes are more important)
  // 2. Node type priority (classes > functions > methods)
  // 3. Name length (shorter names often indicate core functionality)
  const typeScores = {
    'class': 3,
    'function': 2,
    'method': 1,
    'vue-method': 1
  };

  const scoredNodes = nodes.map(node => {
    const connections = nodeConnections.get(node.id) || 0;
    const typeScore = typeScores[node.type] || 0;
    const nameLength = (node.label || node.id).length;
    
    // Prioritize highly connected nodes, important types, and shorter names
    const score = (connections * 5) + (typeScore * 3) + Math.max(0, (50 - nameLength) / 10);
    
    return { ...node, score, connections };
  });

  // Sort by score (descending) and take the top nodes
  const filteredNodes = scoredNodes
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_NODES);

  const filteredNodeIds = new Set(filteredNodes.map(node => node.id));

  // Filter edges to only include those between selected nodes
  const filteredEdges = edges
    .filter(edge => {
      const hasSource = filteredNodeIds.has(edge.source);
      const hasTarget = filteredNodeIds.has(edge.target);
      return hasSource && hasTarget;
    })
    .slice(0, MAX_EDGES); // Additional safety limit

  return { 
    nodes: filteredNodes, 
    edges: filteredEdges 
  };
}

program
  .version('0.0.3')
  .description('A CLI tool for analyzing JavaScript code structure')
  .option('-p, --path <directory>', 'Path to the directory to analyze')
  .option('-o, --output <file>', 'Output filename for the analysis results')
  .option('-f, --format <format>', 'Output format: csv (default), gexf, graphml, dot, or mermaid', 'csv')
  .option('--include-deps', 'Include package.json dependencies in the network analysis')
  .parse(process.argv);

const options = program.opts();

// Validate command line arguments
if (!options.path) {
  console.error('Error: Please provide a directory path using the --path option');
  console.error('Usage: node index.js --path <directory> [--output <filename>]');
  process.exit(1);
}

const inputPath = path.resolve(options.path);
if (!fs.existsSync(inputPath)) {
  console.error(`Directory '${options.path}' does not exist`);
  process.exit(1);
}

// Validate format option
if (!['csv', 'gexf', 'graphml', 'dot', 'mermaid'].includes(options.format)) {
  console.error('Error: Invalid format. Please specify "csv", "gexf", "graphml", "dot", or "mermaid"');
  console.error('Usage: node index.js --path <directory> [--output <filename>] [--format csv|gexf|graphml|dot|mermaid]');
  process.exit(1);
}


console.log(`Analyzing directory: ${inputPath}`);

try {
  // Load package.json dependencies if requested (before scanning)
  if (options.includeDeps) {
    loadPackageDependencies(inputPath);
  }
  
  const scanResults = scanDirectory(inputPath);

  if (nodes.length === 0) {
    console.log('\nNo nodes found. Analysis complete.');
    process.exit(0);
  }

  displayResults(false);

  if (options.output) {
    console.log('\nGenerating output files...');

    try {
      const { nodes: uniqueNodes, edges: uniqueEdges } = deduplicate(
        nodes,
        edges,
      );

      if (uniqueNodes.length === 0 && uniqueEdges.length === 0) {
        console.warn('Warning: No data to export - no nodes or edges found');
      } else {
        if (options.format === 'csv') {
          // Create CSV content using json2csv
          const nodeFields = ['id', 'label', 'type', 'lines'];
          const edgeFields = ['source', 'target', 'type'];

          let nodesCsv, edgesCsv;

          try {
            nodesCsv = uniqueNodes.length > 0 ? parse(uniqueNodes, { fields: nodeFields }) : 'id,label,type,lines\n';
            edgesCsv = uniqueEdges.length > 0 ? parse(uniqueEdges, { fields: edgeFields }) : 'source,target,type\n';
          } catch (error) {
            throw new Error(`Error generating CSV data: ${error.message}`);
          }

          // Write the CSV files
          const nodesFile = `${options.output}_nodes.csv`;
          const edgesFile = `${options.output}_edges.csv`;

          try {
            fs.writeFileSync(nodesFile, nodesCsv);
            fs.writeFileSync(edgesFile, edgesCsv);
          } catch (error) {
            throw new Error(`Error writing output files: ${error.message}`);
          }

          console.log(`Results saved to ${nodesFile} and ${edgesFile}`);
          console.log(`  - Nodes: ${uniqueNodes.length} entries`);
          console.log(`  - Edges: ${uniqueEdges.length} entries`);
        } else if (options.format === 'gexf') {
          // Generate GEXF content
          let gexfContent;
          
          try {
            gexfContent = generateGexf(uniqueNodes, uniqueEdges);
          } catch (error) {
            throw new Error(`Error generating GEXF data: ${error.message}`);
          }

          // Write the GEXF file
          const gexfFile = `${options.output}.gexf`;

          try {
            fs.writeFileSync(gexfFile, gexfContent);
          } catch (error) {
            throw new Error(`Error writing file: ${error.message}`);
          }

          console.log(`Results saved to ${gexfFile}`);
          console.log(`  - Nodes: ${uniqueNodes.length} entries`);
          console.log(`  - Edges: ${uniqueEdges.length} entries`);
          console.log(`  - Format: GEXF (Graph Exchange XML Format) for Gephi`);
        } else if (options.format === 'graphml') {
          // Generate GraphML content
          let graphmlContent;
          
          try {
            graphmlContent = generateGraphml(uniqueNodes, uniqueEdges);
          } catch (error) {
            throw new Error(`Error generating GraphML data: ${error.message}`);
          }

          // Write the GraphML file
          const graphmlFile = `${options.output}.graphml`;

          try {
            fs.writeFileSync(graphmlFile, graphmlContent);
          } catch (error) {
            throw new Error(`Error writing file: ${error.message}`);
          }

          console.log(`Results saved to ${graphmlFile}`);
          console.log(`  - Nodes: ${uniqueNodes.length} entries`);
          console.log(`  - Edges: ${uniqueEdges.length} entries`);
          console.log(`  - Format: GraphML (Graph Markup Language) for yEd, Cytoscape, etc.`);
        } else if (options.format === 'dot') {
          // Generate DOT content
          let dotContent;
          
          try {
            dotContent = generateDot(uniqueNodes, uniqueEdges);
          } catch (error) {
            throw new Error(`Error generating DOT data: ${error.message}`);
          }

          // Write the DOT file
          const dotFile = `${options.output}.dot`;

          try {
            fs.writeFileSync(dotFile, dotContent);
          } catch (error) {
            throw new Error(`Error writing file: ${error.message}`);
          }

          console.log(`Results saved to ${dotFile}`);
          console.log(`  - Nodes: ${uniqueNodes.length} entries`);
          console.log(`  - Edges: ${uniqueEdges.length} entries`);
          console.log(`  - Format: DOT (Graphviz) for dot, neato, fdp, circo, twopi, sfdp`);
        } else if (options.format === 'mermaid') {
          // Generate Mermaid content
          let mermaidContent;
          
          try {
            mermaidContent = generateMermaid(uniqueNodes, uniqueEdges);
          } catch (error) {
            throw new Error(`Error generating Mermaid data: ${error.message}`);
          }

          // Write the Mermaid file
          const mermaidFile = `${options.output}.mmd`;

          try {
            fs.writeFileSync(mermaidFile, mermaidContent);
          } catch (error) {
            throw new Error(`Error writing file: ${error.message}`);
          }

          console.log(`Results saved to ${mermaidFile}`);
          console.log(`  - Nodes: ${uniqueNodes.length} entries (filtered for readability)`);
          console.log(`  - Edges: ${uniqueEdges.length} entries (filtered for readability)`);
          console.log(`  - Format: Mermaid flowchart for GitHub, Notion, Obsidian, etc.`);
        }
      }
    } catch (error) {
      if (error.code && (error.code.startsWith('CSV_') || error.code.startsWith('GEXF_') || error.code.startsWith('GRAPHML_') || error.code.startsWith('DOT_') || error.code.startsWith('MERMAID_') || error.code.startsWith('OUTPUT_'))) {
        console.error(`Error: ${error.message}`);
      } else {
        console.error(`Error generating output: ${error.message}`);
      }
      console.log('\nAnalysis completed, but output generation failed.');
      process.exit(1);
    }
  }

  if (scanResults.errors.length > 0) {
    console.log(`\nAnalysis completed with ${scanResults.errors.length} file parsing errors.`);
    process.exit(2); // Exit with code 2 to indicate warnings/partial success
  } else {
    console.log('\nAnalysis completed successfully.');
  }

} catch (error) {
  if (error.code && (error.code.startsWith('FILE_') || error.code.startsWith('DIRECTORY_') || error.code.startsWith('PATH_'))) {
    console.error(`Error: ${error.message}`);
    if (error.details && error.details.path) {
      console.error(`Path: ${error.details.path}`);
    }
  } else {
    console.error(`Unexpected error during analysis: ${error.message}`);
  }

  // Show partial results if any data was collected
  if (nodes.length > 0 || edges.length > 0) {
    console.log('\nPartial results from processed files:');
    displayResults();
  }

  process.exit(1);
}
