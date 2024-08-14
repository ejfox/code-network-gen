#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const acorn = require("acorn");
const walk = require("acorn-walk");
const { program } = require("commander");
const compiler = require("vue-template-compiler");
const nodes = [];
const edges = [];
const methodRegistry = new Map(); // To store method definitions by file and name

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
function parseFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const content = fs.readFileSync(filePath, "utf8");

  // console.log(`Parsing file: ${filePath}, extension: ${ext}`);

  if (ext === ".vue") {
    const parsed = compiler.parseComponent(content);
    if (parsed.script) {
      parseJavaScript(filePath, parsed.script.content);
    } else if (content.includes("<script setup>")) {
      const scriptContent = content
        .split("<script setup>")[1]
        .split("</script>")[0];
      parseJavaScript(filePath, scriptContent);
    }
  } else {
    parseJavaScript(filePath, content);
  }
}

// Function to get the name of the enclosing function
function getEnclosingFunctionName(node) {
  let parent = node;
  while ((parent = parent.parent)) {
    if (parent.type === "FunctionDeclaration" && parent.id) {
      return parent.id.name;
    }
  }
  return "global";
}

// Function to parse JavaScript content and identify methods/functions and their interactions
function parseJavaScript(filePath, content) {
  let ast;
  try {
    ast = acorn.parse(content, {
      ecmaVersion: "latest",
      sourceType: "module",
      locations: true,
      allowHashBang: true,
      allowReserved: true,
      allowReturnOutsideFunction: true,
      allowImportExportEverywhere: true,
    });
  } catch (error) {
    console.warn(
      `Warning: Could not parse ${filePath}. Error: ${error.message}`
    );
    return;
  }

  const fileName = path.basename(filePath);

  walk.simple(ast, {
    FunctionDeclaration(node) {
      const name = node.id.name;
      const lines = `[${node.loc.start.line}-${node.loc.end.line}]`;
      addNode(fileName, name, "function", lines);
    },
    CallExpression(node) {
      if (node.callee.type === "Identifier") {
        const calleeName = node.callee.name;
        const parentFunction = getEnclosingFunctionName(node);

        // Track the method call, regardless of whether it's within the same file or across files
        methodRegistry.forEach((info, id) => {
          if (info.name === calleeName) {
            addEdge(fileName, parentFunction, info.file, calleeName, "calls");
          }
        });
      }
    },
    ArrowFunctionExpression(node) {
      const id = `${fileName}:arrow`;
      const lines = `[${node.loc.start.line}-${node.loc.end.line}]`;
      addNode(fileName, "arrow function", "method", lines);
    },
    ClassDeclaration(node) {
      const id = `${fileName}:${node.id.name}`;
      const lines = `[${node.loc.start.line}-${node.loc.end.line}]`;
      addNode(fileName, node.id.name, "class", lines);
    },
    MethodDefinition(node) {
      const id = `${fileName}:${node.key.name}`;
      const lines = `[${node.loc.start.line}-${node.loc.end.line}]`;
      addNode(fileName, node.key.name, "method", lines);
    },
    VariableDeclarator(node) {
      if (
        node.init &&
        (node.init.type === "FunctionExpression" ||
          node.init.type === "ArrowFunctionExpression")
      ) {
        const id = `${fileName}:${node.id.name}`;
        const lines = `[${node.loc.start.line}-${node.loc.end.line}]`;
        addNode(fileName, node.id.name, "method", lines);
      }
    },
    ExportDefaultDeclaration(node) {
      if (node.declaration.type === "ObjectExpression") {
        node.declaration.properties.forEach((prop) => {
          if (
            prop.type === "Property" &&
            (prop.value.type === "FunctionExpression" ||
              prop.value.type === "ArrowFunctionExpression")
          ) {
            const id = `${fileName}:${prop.key.name}`;
            const lines = `[${prop.loc.start.line}-${prop.loc.end.line}]`;
            addNode(fileName, prop.key.name, "vue-method", lines);
          }
        });
      }
    },
    Property(node) {
      if (
        node.value.type === "FunctionExpression" ||
        node.value.type === "ArrowFunctionExpression"
      ) {
        const id = `${fileName}:${node.key.name}`;
        const lines = `[${node.loc.start.line}-${node.loc.end.line}]`;
        addNode(fileName, node.key.name, "vue-method", lines);
      }
    },
  });
}

// Function to scan a directory for files to process
function scanDirectory(directory) {
  const ignoreDirs = ["node_modules", ".git", "build", "dist"];
  const allowedExtensions = [".js", ".jsx", ".ts", ".tsx", ".vue"];

  function scan(dir) {
    const files = fs.readdirSync(dir);

    for (const file of files) {
      const filePath = path.join(dir, file);
      const stat = fs.statSync(filePath);

      if (stat.isDirectory()) {
        if (!ignoreDirs.includes(file)) {
          scan(filePath);
        }
      } else if (stat.isFile()) {
        const ext = path.extname(file).toLowerCase();
        if (allowedExtensions.includes(ext)) {
          // console.log(`Processing file: ${filePath}`);
          try {
            parseFile(filePath);
          } catch (error) {
            console.warn(
              `Warning: Error parsing ${filePath}. ${error.message}`
            );
          }
        }
      }
    }
  }

  scan(directory);
}

// Function to deduplicate nodes and edges
function deduplicate(nodes, edges) {
  const uniqueNodes = new Map();
  const uniqueEdges = new Map();
  const referencedNodes = new Set();

  // Deduplicate nodes
  nodes.forEach((node) => {
    const key = `${node.id}-${node.type}`;
    if (!uniqueNodes.has(key)) {
      uniqueNodes.set(key, node);
    } else {
      const existingNode = uniqueNodes.get(key);
      if (node.lines && existingNode.lines) {
        existingNode.lines += `, ${node.lines}`;
      }
    }
  });

  // Deduplicate edges and track referenced nodes
  edges.forEach((edge) => {
    const key = `${edge.source}-${edge.target}-${edge.type}`;
    if (!uniqueEdges.has(key)) {
      uniqueEdges.set(key, edge);
      referencedNodes.add(edge.source);
      referencedNodes.add(edge.target);
    }
  });

  // Filter nodes to only include those that are referenced
  const filteredNodes = Array.from(uniqueNodes.values()).filter((node) =>
    referencedNodes.has(node.id)
  );

  return {
    nodes: filteredNodes,
    edges: Array.from(uniqueEdges.values()),
  };
}

// Function to display the results, including all method interactions
function displayResults(filterAnonymous = true) {
  const { nodes: uniqueNodes, edges: uniqueEdges } = deduplicate(nodes, edges);

  const filteredNodes = filterAnonymous
    ? uniqueNodes.filter(
        (node) => node.label && !node.label.includes("anonymous")
      )
    : uniqueNodes;

  const filteredEdges = filterAnonymous
    ? uniqueEdges.filter(
        (edge) => edge.label && !edge.label.includes("anonymous")
      )
    : uniqueEdges;

  console.log("Nodes:");
  filteredNodes.forEach((node) => {
    const label = node.label || "";
    console.log(`${node.id} - ${label} (${node.type})`);
  });

  console.log("\nEdges:");
  filteredEdges.forEach((edge) => {
    console.log(`${edge.source} -> ${edge.target} (${edge.type})`);
  });

  console.log(`\nTotal unique nodes: ${filteredNodes.length}`);
  console.log(`Total unique edges: ${filteredEdges.length}`);
}

program
  .version("0.1.0")
  .description("A CLI tool for analyzing JavaScript code structure")
  .option("-p, --path <directory>", "Path to the directory to analyze")
  .option("-o, --output <file>", "Output filename for the analysis results")
  .parse(process.argv);

const options = program.opts();

if (!options.path) {
  console.error("Please provide a directory path using the --path option");
  process.exit(1);
}

console.log(`Analyzing directory: ${options.path}`);

try {
  scanDirectory(options.path);
  displayResults(false);

  if (options.output) {
    const { nodes: uniqueNodes, edges: uniqueEdges } = deduplicate(
      nodes,
      edges
    );

    // No filtering for debugging purposes
    // const filteredNodes = uniqueNodes.filter(
    //   (node) => node.label && !node.label.includes("anonymous")
    // );
    // const filteredEdges = uniqueEdges.filter(
    //   (edge) => edge.label && !edge.label.includes("anonymous")
    // );

    // Manually create CSV content for nodes
    const nodeFields = ["id", "label", "type", "lines"];
    const nodesCsv = [nodeFields.join(",")];
    uniqueNodes.forEach((node) => {
      nodesCsv.push([node.id, node.label, node.type, node.lines].join(","));
    });

    // Manually create CSV content for edges
    const edgeFields = ["source", "target", "type"];
    const edgesCsv = [edgeFields.join(",")];
    uniqueEdges.forEach((edge) => {
      edgesCsv.push([edge.source, edge.target, edge.type].join(","));
    });

    // Write the CSV files
    fs.writeFileSync(`${options.output}_nodes.csv`, nodesCsv.join("\n"));
    fs.writeFileSync(`${options.output}_edges.csv`, edgesCsv.join("\n"));

    console.log(
      `Results saved to ${options.output}_nodes.csv and ${options.output}_edges.csv`
    );
  }
} catch (error) {
  console.error(`Error during analysis: ${error.message}`);
  console.log("Partial results:");
  displayResults();
}
