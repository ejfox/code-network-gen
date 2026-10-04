'use strict';

const fs = require('fs');
const path = require('path');
const { createGraph } = require('./graph');
const { parseSourceFile } = require('./parser');
const { scanDirectory } = require('./scanner');
const { traverse } = require('./traverse');

function formatLines(node, lineOffset = 0) {
  if (!node?.loc) return '';

  const start = node.loc.start.line + lineOffset;
  const end = node.loc.end.line + lineOffset;
  return `[${start}-${end}]`;
}

function getPropertyName(key) {
  if (!key) return null;
  if (key.type === 'Identifier') return key.name;
  if (key.type === 'Literal') return String(key.value);
  if (key.type === 'TemplateLiteral' && key.quasis.length === 1) {
    return key.quasis[0].value.cooked;
  }
  return null;
}

function getPatternName(pattern) {
  if (!pattern) return null;
  if (pattern.type === 'Identifier') return pattern.name;
  if (pattern.type === 'AssignmentPattern') return getPatternName(pattern.left);
  if (pattern.type === 'RestElement') return getPatternName(pattern.argument);
  return null;
}

function isFunctionNode(node) {
  return [
    'ArrowFunctionExpression',
    'FunctionDeclaration',
    'FunctionExpression',
  ].includes(node?.type);
}

function isMethodNode(node) {
  return [
    'MethodDefinition',
    'PropertyDefinition',
    'TSAbstractMethodDefinition',
  ].includes(node?.type);
}

function functionNameFromContext(node, parent, ancestors) {
  if (node.type === 'FunctionDeclaration') {
    return node.id?.name || null;
  }

  if (parent?.type === 'VariableDeclarator' && parent.init === node) {
    return getPatternName(parent.id);
  }

  if (parent?.type === 'AssignmentExpression' && parent.right === node) {
    if (parent.left.type === 'Identifier') return parent.left.name;
    if (parent.left.type === 'MemberExpression') {
      return getPropertyName(parent.left.property);
    }
  }

  if (parent?.type === 'Property' && parent.value === node) {
    return getPropertyName(parent.key);
  }

  if (
    parent?.type === 'ExportDefaultDeclaration' &&
    parent.declaration === node
  ) {
    return 'default';
  }

  const grandParent = ancestors[ancestors.length - 2];
  if (parent?.type === 'ChainExpression') {
    return functionNameFromContext(parent, grandParent, ancestors.slice(0, -1));
  }

  return null;
}

function methodNameFromNode(node) {
  return getPropertyName(node.key);
}

function collectDefinitions(parsedFile, graph) {
  traverse(parsedFile.ast, {
    enter(node, parent, ancestors) {
      if (node.type === 'ClassDeclaration' && node.id?.name) {
        graph.addNode(
          parsedFile.relativePath,
          node.id.name,
          'class',
          formatLines(node, parsedFile.lineOffset),
        );
        return;
      }

      if (isMethodNode(node)) {
        const methodName = methodNameFromNode(node);
        if (methodName) {
          graph.addNode(
            parsedFile.relativePath,
            methodName,
            'method',
            formatLines(node, parsedFile.lineOffset),
          );
        }
        return;
      }

      if (isFunctionNode(node)) {
        const functionName = functionNameFromContext(node, parent, ancestors);
        if (functionName) {
          graph.addNode(
            parsedFile.relativePath,
            functionName,
            'function',
            formatLines(node, parsedFile.lineOffset),
          );
        }
      }
    },
  });
}

function packageNameFromSpecifier(specifier) {
  if (!specifier || specifier.startsWith('.') || specifier.startsWith('/')) {
    return null;
  }

  const parts = specifier.split('/');
  if (specifier.startsWith('@')) {
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier;
  }

  return parts[0];
}

function getCallTarget(callee) {
  if (!callee) return null;
  if (callee.type === 'Identifier') {
    return {
      allowCrossFile: true,
      name: callee.name,
    };
  }
  if (callee.type === 'MemberExpression') {
    return {
      allowCrossFile: false,
      name: getPropertyName(callee.property),
    };
  }
  if (callee.type === 'ChainExpression') {
    return getCallTarget(callee.expression);
  }
  return null;
}

function loadPackageDependencies(directoryPath) {
  const packagePath = path.join(directoryPath, 'package.json');

  if (!fs.existsSync(packagePath)) {
    return new Set();
  }

  try {
    const packageContent = fs.readFileSync(packagePath, 'utf8');
    const packageData = JSON.parse(packageContent);
    const deps = {
      ...(packageData.dependencies || {}),
      ...(packageData.devDependencies || {}),
      ...(packageData.peerDependencies || {}),
      ...(packageData.optionalDependencies || {}),
    };

    return new Set(Object.keys(deps));
  } catch (error) {
    return {
      error: `Could not parse package.json: ${error.message}`,
      values: new Set(),
    };
  }
}

function addDependencyEdge(
  graph,
  parsedFile,
  packageName,
  sourceName,
  edgeType,
) {
  graph.addNode('package.json', packageName, 'dependency', '[-]');
  graph.addEdge(
    parsedFile.relativePath,
    sourceName,
    'package.json',
    packageName,
    edgeType,
  );
}

function collectRelationships(
  parsedFile,
  graph,
  definitionsByName,
  packageDependencies,
) {
  const functionStack = [];

  traverse(parsedFile.ast, {
    enter(node, parent, ancestors) {
      if (isFunctionNode(node)) {
        const functionName = functionNameFromContext(node, parent, ancestors);
        functionStack.push(
          functionName || functionStack[functionStack.length - 1] || 'global',
        );
      } else if (isMethodNode(node)) {
        functionStack.push(
          methodNameFromNode(node) ||
            functionStack[functionStack.length - 1] ||
            'global',
        );
      }

      if (node.type === 'ImportDeclaration') {
        const packageName = packageNameFromSpecifier(node.source?.value);
        if (packageName && packageDependencies.has(packageName)) {
          graph.addGlobalNode(parsedFile.relativePath);
          addDependencyEdge(
            graph,
            parsedFile,
            packageName,
            'global',
            'imports',
          );
        }
        return;
      }

      if (node.type !== 'CallExpression') return;

      const sourceName = functionStack[functionStack.length - 1] || 'global';
      const callTarget = getCallTarget(node.callee);
      if (!callTarget?.name) return;

      if (callTarget.name === 'require') {
        const specifier = node.arguments[0]?.value;
        const packageName = packageNameFromSpecifier(specifier);

        if (packageName && packageDependencies.has(packageName)) {
          if (sourceName === 'global') {
            graph.addGlobalNode(parsedFile.relativePath);
          }
          addDependencyEdge(
            graph,
            parsedFile,
            packageName,
            sourceName,
            'requires',
          );
        }
        return;
      }

      const matches = (definitionsByName.get(callTarget.name) || []).filter(
        (target) =>
          callTarget.allowCrossFile || target.file === parsedFile.relativePath,
      );
      if (matches.length === 0) return;

      if (sourceName === 'global') {
        graph.addGlobalNode(parsedFile.relativePath);
      }

      for (const target of matches) {
        graph.addEdge(
          parsedFile.relativePath,
          sourceName,
          target.file,
          target.label,
          'calls',
        );
      }
    },
    leave(node) {
      if (isFunctionNode(node) || isMethodNode(node)) {
        functionStack.pop();
      }
    },
  });
}

function analyzeDirectory(directoryPath, options = {}) {
  const rootDir = path.resolve(directoryPath);
  const scanResults = scanDirectory(rootDir, options);
  const graph = createGraph();
  const errors = [...scanResults.errors];
  const parsedFiles = [];
  const dependencyResult = options.includeDeps
    ? loadPackageDependencies(rootDir)
    : new Set();
  const packageDependencies =
    dependencyResult instanceof Set
      ? dependencyResult
      : dependencyResult.values;

  if (dependencyResult.error) {
    errors.push({
      file: 'package.json',
      message: dependencyResult.error,
    });
  }

  for (const file of scanResults.files) {
    try {
      const scripts = parseSourceFile(file);
      for (const script of scripts) {
        parsedFiles.push({
          ...script,
          relativePath: file.relativePath,
        });
      }
    } catch (error) {
      errors.push({
        file: file.relativePath,
        message: error.message,
      });
    }
  }

  for (const parsedFile of parsedFiles) {
    collectDefinitions(parsedFile, graph);
  }

  const definitionsByName = graph.buildNameIndex();

  for (const parsedFile of parsedFiles) {
    collectRelationships(
      parsedFile,
      graph,
      definitionsByName,
      packageDependencies,
    );
  }

  const { nodes, edges } = graph.toJSON();

  return {
    edges,
    errors,
    nodes,
    stats: {
      parsedFiles: parsedFiles.length,
      scannedFiles: scanResults.processedFiles,
    },
  };
}

module.exports = {
  analyzeDirectory,
  collectDefinitions,
  collectRelationships,
  formatLines,
  packageNameFromSpecifier,
};
