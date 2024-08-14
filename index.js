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
  nodes.push({ id, label, type, lines });
}

function addEdge(source, target, type) {
  edges.push({ source, target, type });
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
        const callerName = `${fileName}:anonymous[${node.loc.start.line}-${node.loc.end.line}]`;
        const calleeName = node.callee.name;
        addEdge(callerName, calleeName, "calls");
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

function deduplicate(array, keyFn) {
  const seen = new Map();
  return array.filter((item) => {
    const key = keyFn(item);
    if (seen.has(key)) {
      const existing = seen.get(key);
      // Merge line numbers if they exist
      if (item.lines && existing.lines) {
        existing.lines += `, ${item.lines}`;
      }
      return false;
    } else {
      seen.set(key, item);
      return true;
    }
  });
}

function displayResults() {
  const uniqueNodes = deduplicate(nodes, (node) => `${node.id}-${node.type}`);
  const uniqueEdges = deduplicate(
    edges,
    (edge) => `${edge.source}-${edge.target}-${edge.type}`
  );

  console.log("Nodes:");
  uniqueNodes.forEach((node) => {
    console.log(
      `${node.id} ${node.lines || ""} - ${node.label} (${node.type})`
    );
  });

  console.log("\nEdges:");
  uniqueEdges.forEach((edge) => {
    console.log(`${edge.source} -> ${edge.target} (${edge.type})`);
  });

  console.log(`\nTotal unique nodes: ${uniqueNodes.length}`);
  console.log(`Total unique edges: ${uniqueEdges.length}`);
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
  displayResults();
} catch (error) {
  console.error(`Error during analysis: ${error.message}`);
  console.log("Partial results:");
  displayResults();
}
