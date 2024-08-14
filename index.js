#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const acorn = require("acorn");
const walk = require("acorn-walk");
const { program } = require("commander");

const compiler = require("vue-template-compiler");

const nodes = [];
const edges = [];

function addNode(id, label, type, lines) {
  if (type === "unknown") {
    if (id.includes(":")) {
      type = "function";
    } else if (id.includes("/")) {
      type = "imported-method";
    } else {
      type = "variable";
    }
  }
  nodes.push({ id, label, type, lines });
}
function addEdge(source, target, type) {
  ensureNodeExists(source, source.split(":")[1] || source, "unknown");
  ensureNodeExists(target, target.split(":")[1] || target, "unknown");
  edges.push({ source, target, type });
}

function ensureNodeExists(id, label, type) {
  if (!nodes.some((node) => node.id === id)) {
    addNode(id, label || id.split(":")[1] || id, type || "unknown");
  }
}

function parseFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const content = fs.readFileSync(filePath, "utf8");

  console.log(`Parsing file: ${filePath}, extension: ${ext}`);

  if (ext === ".vue") {
    const parsed = compiler.parseComponent(content);
    if (parsed.script) {
      console.log(`Vue file detected, parsing script content`);
      parseJavaScript(filePath, parsed.script.content);
    } else if (content.includes("<script setup>")) {
      console.log(`Vue file detected with <script setup>, parsing content`);
      const scriptContent = content
        .split("<script setup>")[1]
        .split("</script>")[0];
      parseJavaScript(filePath, scriptContent);
    } else {
      console.log(`Vue file has no script content`);
    }
  } else {
    parseJavaScript(filePath, content);
  }
}

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
      const id = `${fileName}:${node.id.name}`;
      const lines = `[${node.loc.start.line}-${node.loc.end.line}]`;
      addNode(id, node.id.name, "method", lines);
    },
    VariableDeclarator(node) {
      const id = `${fileName}:${node.id.name}`;
      addNode(
        id,
        node.id.name,
        "variable",
        `[${node.loc.start.line}-${node.loc.end.line}]`
      );
    },
    ImportDeclaration(node) {
      const libraryName = node.source.value;
      addNode(libraryName, libraryName, "library", null);

      node.specifiers.forEach((specifier) => {
        if (specifier.type === "ImportSpecifier") {
          const methodName = `${libraryName}/${specifier.imported.name}`;
          addNode(methodName, specifier.imported.name, "imported-method", null);
          addEdge(fileName, methodName, "imports");
        }
      });
    },
    CallExpression(node) {
      if (node.callee.type === "Identifier") {
        let callerName = `${fileName}:anonymous[${node.loc.start.line}]`;
        // Try to find the containing function name
        let parent = node;
        while ((parent = parent.parent)) {
          if (parent.type === "FunctionDeclaration" && parent.id) {
            callerName = `${fileName}:${parent.id.name}`;
            break;
          } else if (parent.type === "MethodDefinition" && parent.key) {
            callerName = `${fileName}:${parent.key.name}`;
            break;
          }
        }
        const calleeName = node.callee.name;

        // Extract argument information
        const args = node.arguments
          .map((arg) => {
            if (arg.type === "Identifier") {
              return arg.name;
            } else if (arg.type === "Literal") {
              return JSON.stringify(arg.value);
            } else if (arg.type === "MemberExpression") {
              return `${arg.object.name}.${arg.property.name}`;
            } else {
              return arg.type;
            }
          })
          .join(", ");

        addEdge(callerName, calleeName, `calls(${args})`);
      }
    },
    ArrowFunctionExpression(node) {
      const id = `${fileName}:arrow`;
      const lines = `[${node.loc.start.line}-${node.loc.end.line}]`;
      addNode(id, "arrow function", "method", lines);
    },
    ClassDeclaration(node) {
      const id = `${fileName}:${node.id.name}`;
      const lines = `[${node.loc.start.line}-${node.loc.end.line}]`;
      addNode(id, node.id.name, "class", lines);
    },
    MethodDefinition(node) {
      const id = `${fileName}:${node.key.name}`;
      const lines = `[${node.loc.start.line}-${node.loc.end.line}]`;
      addNode(id, node.key.name, "method", lines);
    },
    VariableDeclarator(node) {
      if (
        node.init &&
        (node.init.type === "FunctionExpression" ||
          node.init.type === "ArrowFunctionExpression")
      ) {
        const id = `${fileName}:${node.id.name}`;
        const lines = `[${node.loc.start.line}-${node.loc.end.line}]`;
        addNode(id, node.id.name, "method", lines);
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
            addNode(id, prop.key.name, "vue-method", lines);
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
        addNode(id, node.key.name, "vue-method", lines);
      }
    },
  });
}
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
          console.log(`Processing file: ${filePath}`); // Add this line
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
    const label = edge.label || "";
    console.log(`${edge.source} -> ${edge.target} (${label})`);
  });

  console.log(`\nTotal unique nodes: ${filteredNodes.length}`);
  console.log(`Total unique edges: ${filteredEdges.length}`);
}

program
  .version("0.1.0")
  .description("A CLI tool for analyzing JavaScript code structure")
  .option("-p, --path <directory>", "Path to the directory to analyze")
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
} catch (error) {
  console.error(`Error during analysis: ${error.message}`);
  console.log("Partial results:");
  displayResults();
}
