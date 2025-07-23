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

// Enhanced error handling utilities
function createError(message, code, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function validatePath(targetPath, type = 'directory') {
  try {
    const stats = fs.statSync(targetPath);
    if (type === 'directory' && !stats.isDirectory()) {
      throw createError(`Path '${targetPath}' exists but is not a directory`, 'INVALID_DIRECTORY', { path: targetPath });
    }
    if (type === 'file' && !stats.isFile()) {
      throw createError(`Path '${targetPath}' exists but is not a file`, 'INVALID_FILE', { path: targetPath });
    }
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw createError(`Path '${targetPath}' does not exist`, 'PATH_NOT_FOUND', { path: targetPath });
    }
    if (error.code === 'EACCES') {
      throw createError(`Permission denied accessing '${targetPath}'`, 'ACCESS_DENIED', { path: targetPath });
    }
    if (error.code && error.code.startsWith('INVALID_') || error.code === 'PATH_NOT_FOUND') {
      throw error; // Re-throw our custom errors
    }
    throw createError(`Error accessing path '${targetPath}': ${error.message}`, 'PATH_ACCESS_ERROR', { path: targetPath, originalError: error.message });
  }
}

function validateOutputPath(outputPath) {
  try {
    const dir = path.dirname(outputPath);

    // Check if directory exists and is writable
    try {
      fs.accessSync(dir, fs.constants.F_OK | fs.constants.W_OK);
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw createError(`Output directory '${dir}' does not exist`, 'OUTPUT_DIR_NOT_FOUND', { path: dir });
      }
      if (error.code === 'EACCES') {
        throw createError(`No write permission for output directory '${dir}'`, 'OUTPUT_DIR_NO_WRITE', { path: dir });
      }
      throw createError(`Cannot write to output directory '${dir}': ${error.message}`, 'OUTPUT_DIR_ERROR', { path: dir, originalError: error.message });
    }

    // Test write access by creating a temporary file
    const testFile = path.join(dir, `.test-write-${Date.now()}.tmp`);
    try {
      fs.writeFileSync(testFile, 'test');
      fs.unlinkSync(testFile);
    } catch (error) {
      throw createError(`Cannot write to output path '${outputPath}': ${error.message}`, 'OUTPUT_WRITE_TEST_FAILED', { path: outputPath, originalError: error.message });
    }

    return true;
  } catch (error) {
    if (error.code && error.code.startsWith('OUTPUT_')) {
      throw error; // Re-throw our custom errors
    }
    throw createError(`Error validating output path '${outputPath}': ${error.message}`, 'OUTPUT_VALIDATION_ERROR', { path: outputPath, originalError: error.message });
  }
}

// Function to add a node (method/function) to the registry and nodes list
function addNode(file, name, type, lines) {
  const id = `${file}:${name}`;
  if (!methodRegistry.has(id)) {
    methodRegistry.set(id, { file, name, type, lines });
  }
  nodes.push({ id, label: name, type, lines });
}

// Function to add an edge between methods/functions
function addEdge(sourceFile, sourceMethod, targetFile, targetMethod, type) {
  const sourceId = `${sourceFile}:${sourceMethod}`;
  const targetId = `${targetFile}:${targetMethod}`;

  if (methodRegistry.has(targetId)) {
    edges.push({ source: sourceId, target: targetId, type });
  }
}

// Function to parse a single file and extract method/function definitions and calls
const parseFile = (filePath) => {
  const ext = path.extname(filePath).toLowerCase();
  const content = fs.readFileSync(filePath, 'utf8');

  // console.log(`Parsing file: ${filePath}, extension: ${ext}`);

  if (ext === '.vue') {
    const parsed = compiler.parseComponent(content);
    if (parsed.script) {
      parseJavaScript(filePath, parsed.script.content);
    } else if (content.includes('<script setup>')) {
      const scriptContent = content
        .split('<script setup>')[1]
        .split('</script>')[0];
      parseJavaScript(filePath, scriptContent);
    }
  } else {
    parseJavaScript(filePath, content);
  }
};

// Function to get the name of the enclosing function
const getEnclosingFunctionName = (node) => {
  let parent = node;
  while ((parent = parent.parent)) {
    if (parent.type === 'FunctionDeclaration' && parent.id) {
      return parent.id.name;
    }
  }
  return 'global';
};

// Function to parse JavaScript content and identify methods/functions and their interactions
const parseJavaScript = (filePath, content) => {
  let ast;
  const ext = path.extname(filePath).toLowerCase();
  const isTypeScript = ext === '.ts' || ext === '.tsx';
  
  try {
    // Use Babel parser for TypeScript and modern JS features
    ast = babelParse(content, {
      sourceType: 'module',
      allowImportExportEverywhere: true,
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      allowSuperOutsideMethod: true,
      allowUndeclaredExports: true,
      plugins: [
        'jsx',
        'decorators-legacy',
        'classProperties',
        'objectRestSpread',
        'functionBind',
        'exportDefaultFrom',
        'exportNamespaceFrom',
        'dynamicImport',
        'nullishCoalescingOperator',
        'optionalChaining',
        ...(isTypeScript ? ['typescript'] : [])
      ],
    });
  } catch (error) {
    // Fallback to acorn for simple JS files
    try {
      ast = acorn.parse(content, {
        ecmaVersion: 'latest',
        sourceType: 'module',
        locations: true,
        allowHashBang: true,
        allowReserved: true,
        allowReturnOutsideFunction: true,
        allowImportExportEverywhere: true,
      });
    } catch (fallbackError) {
      console.warn(
        `Warning: Could not parse ${filePath}. Error: ${fallbackError.message}`,
      );
      return;
    }
  }

  const fileName = path.basename(filePath);
  const isBabelAST = ast.type === 'File'; // Babel ASTs have a File node at the root

  // Helper functions for handling different node types
  const handleFunctionNode = (node, type, name = null) => {
    const nodeName = name || (node.id ? node.id.name : 'anonymous');
    if (node.loc) {
      const { start, end } = node.loc;
      const lines = `[${start.line}-${end.line}]`;
      addNode(fileName, nodeName, type, lines);
    }
  };

  const handleCallNode = (node) => {
    if (node.callee && node.callee.type === 'Identifier') {
      const calleeName = node.callee.name;
      const parentFunction = getEnclosingFunctionName(node);

      methodRegistry.forEach((info, id) => {
        if (info.name === calleeName) {
          addEdge(fileName, parentFunction, info.file, calleeName, 'calls');
        }
      });
    }
  };

  // Use appropriate traversal method based on AST type
  if (isBabelAST) {
    // Use Babel traverse for Babel ASTs
    traverse(ast, {
      FunctionDeclaration(path) {
        handleFunctionNode(path.node, 'function');
      },
      FunctionExpression(path) {
        handleFunctionNode(path.node, 'function');
      },
      ArrowFunctionExpression(path) {
        handleFunctionNode(path.node, 'function');
      },
      ClassMethod(path) {
        const methodName = path.node.key?.name || 'method';
        handleFunctionNode(path.node, 'method', methodName);
      },
      ObjectMethod(path) {
        const methodName = path.node.key?.name || 'method';
        handleFunctionNode(path.node, 'method', methodName);
      },
      CallExpression(path) {
        handleCallNode(path.node);
      }
    });
  } else {
    // Use acorn-walk for acorn ASTs
    walk.simple(ast, {
    FunctionDeclaration(node) {
      const { name } = node.id;
      const { start, end } = node.loc;
      const lines = `[${start.line}-${end.line}]`;
      addNode(fileName, name, 'function', lines);
    },
    CallExpression(node) {
      if (node.callee.type === 'Identifier') {
        const calleeName = node.callee.name;
        const parentFunction = getEnclosingFunctionName(node);

        // Track the method call, regardless of whether it's within the same file or across files
        methodRegistry.forEach((info, id) => {
          if (info.name === calleeName) {
            addEdge(fileName, parentFunction, info.file, calleeName, 'calls');
          }
        });
      }
    },
    ArrowFunctionExpression(node) {
      const id = `${fileName}:arrow`;
      const { start, end } = node.loc;
      const lines = `[${start.line}-${end.line}]`;
      addNode(fileName, 'arrow function', 'method', lines);
    },
    ClassDeclaration(node) {
      const { name } = node.id;
      const id = `${fileName}:${name}`;
      const { start, end } = node.loc;
      const lines = `[${start.line}-${end.line}]`;
      addNode(fileName, name, 'class', lines);
    },
    MethodDefinition(node) {
      const { name } = node.key;
      const id = `${fileName}:${name}`;
      const { start, end } = node.loc;
      const lines = `[${start.line}-${end.line}]`;
      addNode(fileName, name, 'method', lines);
    },
    VariableDeclarator(node) {
      const { init } = node;
      if (
        init &&
        (init.type === 'FunctionExpression' ||
          init.type === 'ArrowFunctionExpression')
      ) {
        const { name } = node.id;
        const id = `${fileName}:${name}`;
        const { start, end } = node.loc;
        const lines = `[${start.line}-${end.line}]`;
        addNode(fileName, name, 'method', lines);
      }
    },
    ExportDefaultDeclaration(node) {
      const { declaration } = node;
      if (declaration.type === 'ObjectExpression') {
        declaration.properties.forEach((prop) => {
          const { type, value, key, loc } = prop;
          if (
            type === 'Property' &&
            (value.type === 'FunctionExpression' ||
              value.type === 'ArrowFunctionExpression')
          ) {
            const { name } = key;
            const id = `${fileName}:${name}`;
            const { start, end } = loc;
            const lines = `[${start.line}-${end.line}]`;
            addNode(fileName, name, 'vue-method', lines);
          }
        });
      }
    },
    Property(node) {
      const { value, key, loc } = node;
      if (
        value.type === 'FunctionExpression' ||
        value.type === 'ArrowFunctionExpression'
      ) {
        const { name } = key;
        const id = `${fileName}:${name}`;
        const { start, end } = loc;
        const lines = `[${start.line}-${end.line}]`;
        addNode(fileName, name, 'vue-method', lines);
      }
    },
    });
  }
};

// Function to scan a directory for files to process
const scanDirectory = (directory) => {
  const ignoreDirs = ['node_modules', '.git', 'build', 'dist'];
  const allowedExtensions = ['.js', '.jsx', '.ts', '.tsx', '.vue', '.mjs'];
  
  // Function to check if file is likely minified
  const isMinifiedFile = (filename) => {
    const baseName = path.basename(filename, path.extname(filename));
    return baseName.includes('.min') || 
           baseName.includes('.esm.min') ||
           baseName.includes('.umd.min') ||
           baseName.includes('.iife.min') ||
           /^[a-f0-9]{8,}(\.[a-f0-9]{16,})?$/i.test(baseName) || // webpack chunks (case insensitive)
           /^[a-z0-9]{3,4}-[a-z0-9]{4,6}$/i.test(baseName) || // chunks like 2N7-oLCw, 3MKP1joc
           /^[A-Z][a-z0-9]{7}$/i.test(baseName) || // 8-char mixed case like BneFvTpf, CIrwhhrH
           /^[0-9][a-zA-Z0-9]{7}$/i.test(baseName) || // patterns like 8qprKa4M (number + 7 alphanumeric)
           /^[A-Z](-[A-Z])?-[a-zA-Z0-9]{4,6}$/i.test(baseName) || // patterns like C-U-RqCb
           baseName.match(/^\d+\.[a-f0-9]+$/i) || // webpack chunks like 123.abc123def.js
           filename.includes('bundle') ||
           filename.includes('vendor') ||
           filename.includes('polyfill') ||
           filename.includes('chunk') ||
           filename.includes('runtime') ||
           // Common build output patterns
           filename.includes('.nuxt/') ||
           filename.includes('dist/') ||
           filename.includes('build/');
  };
  let processedFiles = 0;
  let totalFiles = 0;
  const errors = [];

  // First pass: count total files to process
  const countFiles = (dir) => {
    let files;
    try {
      files = fs.readdirSync(dir);
    } catch (error) {
      if (error.code === 'EACCES') {
        console.warn(`Warning: Permission denied accessing directory '${dir}'`);
        return;
      }
      if (error.code === 'ENOENT') {
        console.warn(`Warning: Directory '${dir}' not found`);
        return;
      }
      console.warn(`Warning: Error reading directory '${dir}': ${error.message}`);
      return;
    }

    for (const file of files) {
      const filePath = path.join(dir, file);
      let stat;

      try {
        stat = fs.statSync(filePath);
      } catch (error) {
        if (error.code === 'EACCES') {
          console.warn(`Warning: Permission denied accessing '${filePath}'`);
          continue;
        }
        console.warn(`Warning: Error accessing '${filePath}': ${error.message}`);
        continue;
      }

      if (stat.isDirectory()) {
        if (!ignoreDirs.includes(file)) {
          countFiles(filePath);
        }
      } else if (stat.isFile()) {
        const ext = path.extname(file).toLowerCase();
        if (allowedExtensions.includes(ext) && !isMinifiedFile(file)) {
          totalFiles++;
        }
      }
    }
  };

  // Second pass: process files with progress indication
  const scan = (dir) => {
    let files;
    try {
      files = fs.readdirSync(dir);
    } catch (error) {
      if (error.code === 'EACCES') {
        console.warn(`Warning: Permission denied accessing directory '${dir}'`);
        return;
      }
      console.warn(`Warning: Error reading directory '${dir}': ${error.message}`);
      return;
    }

    for (const file of files) {
      const filePath = path.join(dir, file);
      let stat;

      try {
        stat = fs.statSync(filePath);
      } catch (error) {
        if (error.code === 'EACCES') {
          console.warn(`Warning: Permission denied accessing '${filePath}'`);
          continue;
        }
        console.warn(`Warning: Error accessing '${filePath}': ${error.message}`);
        continue;
      }

      if (stat.isDirectory()) {
        if (!ignoreDirs.includes(file)) {
          scan(filePath);
        }
      } else if (stat.isFile()) {
        const ext = path.extname(file).toLowerCase();
        if (allowedExtensions.includes(ext) && !isMinifiedFile(file)) {
          processedFiles++;
          console.log(`Processing ${processedFiles}/${totalFiles}: ${path.basename(filePath)}`);
          try {
            parseFile(filePath);
          } catch (error) {
            const errorMsg = error.code ?
              `${error.message} (${error.code})` :
              error.message;
            console.warn(`Warning: Error parsing '${path.basename(filePath)}': ${errorMsg}`);
            errors.push({ file: filePath, error: errorMsg });
          }
        }
      }
    }
  };

  // Count files first
  console.log('Counting files to process...');
  try {
    countFiles(directory);
  } catch (error) {
    throw createError(`Error counting files in directory '${directory}': ${error.message}`, 'FILE_COUNT_ERROR', { path: directory, originalError: error.message });
  }

  if (totalFiles === 0) {
    console.warn(`Warning: No supported files found in directory '${directory}'. Supported extensions: ${allowedExtensions.join(', ')}`);
    return { processedFiles: 0, totalFiles: 0, errors: [] };
  }

  console.log(`Found ${totalFiles} files to analyze`);

  // Then process with progress
  try {
    scan(directory);
  } catch (error) {
    throw createError(`Error scanning directory '${directory}': ${error.message}`, 'DIRECTORY_SCAN_ERROR', { path: directory, originalError: error.message });
  }

  console.log(`Completed processing ${processedFiles} files`);

  if (errors.length > 0) {
    console.log(`\nEncountered ${errors.length} parsing errors:`);
    errors.forEach(({ file, error }, index) => {
      console.log(`  ${index + 1}. ${path.basename(file)}: ${error}`);
    });
  }

  return { processedFiles, totalFiles, errors };
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

  // Apply classes to nodes
  const nodesByType = {
    function: [],
    method: [],
    class: [],
    'vue-method': [],
    global: []
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
  .version('0.0.2')
  .description('A CLI tool for analyzing JavaScript code structure')
  .option('-p, --path <directory>', 'Path to the directory to analyze')
  .option('-o, --output <file>', 'Output filename for the analysis results')
  .option('-f, --format <format>', 'Output format: csv (default), gexf, graphml, dot, or mermaid', 'csv')
  .parse(process.argv);

const options = program.opts();

// Validate command line arguments
if (!options.path) {
  console.error('Error: Please provide a directory path using the --path option');
  console.error('Usage: node index.js --path <directory> [--output <filename>]');
  process.exit(1);
}

// Resolve and validate the input path
let inputPath;
try {
  inputPath = path.resolve(options.path);
  validatePath(inputPath, 'directory');
} catch (error) {
  console.error(`Error: ${error.message}`);
  if (error.code === 'PATH_NOT_FOUND') {
    console.error(`Please check that the directory '${options.path}' exists and is accessible.`);
  } else if (error.code === 'ACCESS_DENIED') {
    console.error(`Please check the permissions for directory '${options.path}'.`);
  } else if (error.code === 'INVALID_DIRECTORY') {
    console.error(`The path '${options.path}' must be a directory, not a file.`);
  }
  process.exit(1);
}

// Validate format option
if (!['csv', 'gexf', 'graphml', 'dot', 'mermaid'].includes(options.format)) {
  console.error('Error: Invalid format. Please specify "csv", "gexf", "graphml", "dot", or "mermaid"');
  console.error('Usage: node index.js --path <directory> [--output <filename>] [--format csv|gexf|graphml|dot|mermaid]');
  process.exit(1);
}

// Validate output path if provided
if (options.output) {
  try {
    const outputPath = path.resolve(options.output);
    validateOutputPath(outputPath);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    if (error.code === 'OUTPUT_DIR_NOT_FOUND') {
      console.error('Please create the output directory or choose a different path.');
    } else if (error.code === 'OUTPUT_DIR_NO_WRITE') {
      console.error('Please check write permissions for the output directory.');
    }
    process.exit(1);
  }
}

console.log(`Analyzing directory: ${inputPath}`);

try {
  const scanResults = scanDirectory(inputPath);

  if (scanResults.processedFiles === 0) {
    console.log('\nNo files were processed. Analysis complete.');
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
            throw createError(`Error generating CSV data: ${error.message}`, 'CSV_GENERATION_ERROR', { originalError: error.message });
          }

          // Write the CSV files
          const nodesFile = `${options.output}_nodes.csv`;
          const edgesFile = `${options.output}_edges.csv`;

          try {
            fs.writeFileSync(nodesFile, nodesCsv);
            fs.writeFileSync(edgesFile, edgesCsv);
          } catch (error) {
            if (error.code === 'EACCES') {
              throw createError('Permission denied writing output files', 'OUTPUT_WRITE_DENIED', { files: [nodesFile, edgesFile] });
            }
            throw createError(`Error writing output files: ${error.message}`, 'OUTPUT_WRITE_ERROR', { files: [nodesFile, edgesFile], originalError: error.message });
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
            throw createError(`Error generating GEXF data: ${error.message}`, 'GEXF_GENERATION_ERROR', { originalError: error.message });
          }

          // Write the GEXF file
          const gexfFile = `${options.output}.gexf`;

          try {
            fs.writeFileSync(gexfFile, gexfContent);
          } catch (error) {
            if (error.code === 'EACCES') {
              throw createError('Permission denied writing output file', 'OUTPUT_WRITE_DENIED', { files: [gexfFile] });
            }
            throw createError(`Error writing output file: ${error.message}`, 'OUTPUT_WRITE_ERROR', { files: [gexfFile], originalError: error.message });
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
            throw createError(`Error generating GraphML data: ${error.message}`, 'GRAPHML_GENERATION_ERROR', { originalError: error.message });
          }

          // Write the GraphML file
          const graphmlFile = `${options.output}.graphml`;

          try {
            fs.writeFileSync(graphmlFile, graphmlContent);
          } catch (error) {
            if (error.code === 'EACCES') {
              throw createError('Permission denied writing output file', 'OUTPUT_WRITE_DENIED', { files: [graphmlFile] });
            }
            throw createError(`Error writing output file: ${error.message}`, 'OUTPUT_WRITE_ERROR', { files: [graphmlFile], originalError: error.message });
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
            throw createError(`Error generating DOT data: ${error.message}`, 'DOT_GENERATION_ERROR', { originalError: error.message });
          }

          // Write the DOT file
          const dotFile = `${options.output}.dot`;

          try {
            fs.writeFileSync(dotFile, dotContent);
          } catch (error) {
            if (error.code === 'EACCES') {
              throw createError('Permission denied writing output file', 'OUTPUT_WRITE_DENIED', { files: [dotFile] });
            }
            throw createError(`Error writing output file: ${error.message}`, 'OUTPUT_WRITE_ERROR', { files: [dotFile], originalError: error.message });
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
            throw createError(`Error generating Mermaid data: ${error.message}`, 'MERMAID_GENERATION_ERROR', { originalError: error.message });
          }

          // Write the Mermaid file
          const mermaidFile = `${options.output}.mmd`;

          try {
            fs.writeFileSync(mermaidFile, mermaidContent);
          } catch (error) {
            if (error.code === 'EACCES') {
              throw createError('Permission denied writing output file', 'OUTPUT_WRITE_DENIED', { files: [mermaidFile] });
            }
            throw createError(`Error writing output file: ${error.message}`, 'OUTPUT_WRITE_ERROR', { files: [mermaidFile], originalError: error.message });
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
