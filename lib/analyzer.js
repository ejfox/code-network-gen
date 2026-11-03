'use strict';

const fs = require('fs');
const path = require('path');
const { createGraph } = require('./graph');
const { parseSourceFile, templateTags } = require('./parser');
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
  if (node.type === 'FunctionDeclaration' && node.id?.name) {
    return node.id.name;
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

const MODULE_EXTENSIONS = [
  '.ts',
  '.js',
  '.vue',
  '.tsx',
  '.jsx',
  '.mjs',
  '.cjs',
];

/** './b' from src/a.js, or Nuxt's '~/utils/x' -> 'src/b.js' if that file was scanned */
function resolveModule(fromFile, specifier, fileSet) {
  if (typeof specifier !== 'string') return null;
  let base;
  const alias = specifier.match(/^(~~|@@|~|@)\//);
  if (alias) {
    base = specifier.slice(alias[0].length);
  } else if (specifier.startsWith('.')) {
    base = path.posix.normalize(
      path.posix.join(path.posix.dirname(fromFile), specifier),
    );
  } else {
    return null;
  }
  const stem = base.replace(/\.(m|c)?[jt]sx?$/, '');
  const candidates = [base, stem];
  for (const ext of MODULE_EXTENSIONS) {
    candidates.push(stem + ext, `${base}/index${ext}`);
  }
  return candidates.find((candidate) => fileSet.has(candidate)) || null;
}

function patternNames(pattern, out = []) {
  if (!pattern) return out;
  switch (pattern.type) {
    case 'Identifier':
      out.push(pattern.name);
      break;
    case 'ObjectPattern':
      for (const prop of pattern.properties) {
        patternNames(
          prop.type === 'RestElement' ? prop.argument : prop.value,
          out,
        );
      }
      break;
    case 'ArrayPattern':
      for (const element of pattern.elements) patternNames(element, out);
      break;
    case 'AssignmentPattern':
      patternNames(pattern.left, out);
      break;
    case 'RestElement':
      patternNames(pattern.argument, out);
      break;
    case 'TSParameterProperty':
      patternNames(pattern.parameter, out);
      break;
    default:
      break;
  }
  return out;
}

function requireSpecifier(init) {
  if (
    init?.type === 'CallExpression' &&
    init.callee.type === 'Identifier' &&
    init.callee.name === 'require' &&
    init.arguments[0]?.type === 'Literal'
  ) {
    return init.arguments[0].value;
  }
  return null;
}

/**
 * What each name in a file refers to before we guess by name: imports (ES and
 * destructured require) and every other local binding (variables, params,
 * catch params). File-wide, not per scope: good enough to stop
 * `const emit = defineEmits()` from linking to some other file's emit.
 */
function collectScope(parsedFile) {
  const imports = new Map(); // local name -> { specifier, imported }
  const bindings = new Set();
  const specifiers = new Set(); // every module this file loads

  traverse(parsedFile.ast, {
    enter(node) {
      if (node.type === 'ImportDeclaration') {
        specifiers.add(node.source.value);
        for (const spec of node.specifiers) {
          imports.set(spec.local.name, {
            specifier: node.source.value,
            imported:
              spec.type === 'ImportDefaultSpecifier'
                ? 'default'
                : spec.type === 'ImportNamespaceSpecifier'
                  ? '*'
                  : getPropertyName(spec.imported),
          });
        }
        return;
      }
      if (
        (node.type === 'ExportNamedDeclaration' ||
          node.type === 'ExportAllDeclaration') &&
        node.source
      ) {
        specifiers.add(node.source.value);
      }
      if (node.type === 'ImportExpression' && node.source?.type === 'Literal') {
        specifiers.add(node.source.value);
      }
      if (node.type === 'VariableDeclarator') {
        const required = requireSpecifier(node.init);
        if (required) specifiers.add(required);
        if (required && node.id.type === 'ObjectPattern') {
          for (const prop of node.id.properties) {
            if (prop.type !== 'Property') continue;
            for (const local of patternNames(prop.value)) {
              imports.set(local, {
                specifier: required,
                imported: getPropertyName(prop.key),
              });
            }
          }
          return;
        }
        for (const name of patternNames(node.id)) bindings.add(name);
        return;
      }
      if (isFunctionNode(node)) {
        for (const param of node.params) {
          for (const name of patternNames(param)) bindings.add(name);
        }
      }
      if (node.type === 'CatchClause') {
        for (const name of patternNames(node.param)) bindings.add(name);
      }
      if (
        node.type === 'CallExpression' &&
        node.callee.type === 'Identifier' &&
        node.callee.name === 'require' &&
        node.arguments[0]?.type === 'Literal'
      ) {
        specifiers.add(node.arguments[0].value);
      }
    },
  });

  return { bindings, imports, specifiers };
}

/** Nuxt auto-imports top-level files (and dir/index) from these, per side */
function nuxtAutoImportable(file, fromFile) {
  const serverSide = fromFile.startsWith('server/');
  const roots = serverSide ? ['server/utils/'] : ['composables/', 'utils/'];
  return roots.some((root) => {
    if (!file.startsWith(root)) return false;
    const rest = file.slice(root.length).split('/');
    return rest.length === 1 || (rest.length === 2 && /^index\./.test(rest[1]));
  });
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

/**
 * Which definition does `name()` in this file mean? In order: one defined in
 * the same file; the one it was imported from; nothing if the name is a local
 * variable or parameter; otherwise a free name (global or auto-import) links
 * only when exactly one definition could be meant.
 */
function resolveCall(callTarget, parsedFile, context) {
  const file = parsedFile.relativePath;
  const name = callTarget.name;
  const defs = context.definitionsByName.get(name) || [];
  const local = defs.find((def) => def.file === file && def.type !== 'global');
  if (local) return local;
  if (!callTarget.allowCrossFile) return null;

  const { imports, bindings } = context.scope;
  const imported = imports.get(name);
  if (imported) {
    const targetFile = resolveModule(file, imported.specifier, context.fileSet);
    if (!targetFile || imported.imported === '*') return null;
    return (
      (context.definitionsByName.get(imported.imported) || []).find(
        (def) => def.file === targetFile,
      ) || null
    );
  }
  if (bindings.has(name)) return null;

  let candidates = defs.filter(
    (def) => def.type !== 'global' && def.file !== file,
  );
  if (context.nuxt) {
    candidates = candidates.filter((def) => nuxtAutoImportable(def.file, file));
  }
  if (candidates.length !== 1) return null;
  return { ...candidates[0], autoImported: Boolean(context.nuxt) };
}

function isStringish(node) {
  return (
    (node.type === 'Literal' && typeof node.value === 'string') ||
    node.type === 'TemplateLiteral'
  );
}

/** a template literal's dynamic parts become one path segment each */
function stringValue(node) {
  if (node.type === 'Literal') return node.value;
  return node.quasis.map((quasi) => quasi.value.cooked).join('X');
}

/** server/api/networks/[id]/batch.post.ts -> /^\/api\/networks\/[^/]+\/batch$/ */
function routePattern(file) {
  const route = file
    .slice('server'.length)
    .replace(/\.(get|post|put|patch|delete|head|options)?\.?[jt]s$/, '')
    .replace(/\/index$/, '');
  const parts = route.split('/').map((segment) => {
    if (/^\[\.\.\..+\]$/.test(segment)) return '.+';
    if (/^\[.+\]$/.test(segment)) return '[^/]+';
    return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  });
  return new RegExp(`^${parts.join('/')}$`);
}

function buildRoutes(files) {
  return files
    .filter((file) => /^server\/api\/.+\.[jt]s$/.test(file))
    .map((file) => ({
      file,
      pattern: routePattern(file),
      dynamic: (file.match(/\[/g) || []).length,
    }))
    .sort((a, b) => a.dynamic - b.dynamic); // most literal route wins
}

function matchRoute(value, routes) {
  if (typeof value !== 'string' || !value.startsWith('/api/')) return null;
  const url = value.split(/[?#]/)[0].replace(/\/$/, '');
  return routes.find((route) => route.pattern.test(url))?.file || null;
}

/**
 * Nuxt's component names: components/welcome/ScrubFilm.vue -> WelcomeScrubFilm
 * (and welcome-scrub-film); a leaf that already starts with its folder's
 * prefix isn't doubled (components/ui/UiButton.vue -> UiButton).
 */
function nuxtComponentNames(files) {
  const names = new Map();
  for (const file of files) {
    if (!file.startsWith('components/') || !file.endsWith('.vue')) continue;
    const parts = file.slice('components/'.length, -'.vue'.length).split('/');
    const leaf = parts.pop();
    const prefix = parts
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join('');
    const name =
      prefix && !leaf.toLowerCase().startsWith(prefix.toLowerCase())
        ? prefix + leaf
        : leaf;
    names.set(name, file);
    names.set(name.replace(/(?<!^)([A-Z])/g, '-$1').toLowerCase(), file);
  }
  return names;
}

function collectRelationships(
  parsedFile,
  graph,
  definitionsByName,
  packageDependencies,
  context = {},
) {
  const functionStack = [];
  context = {
    autoImports: new Set(),
    fileSet: new Set(),
    ...context,
    definitionsByName,
    scope: context.scope || collectScope(parsedFile),
  };

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

      if (context.routes && isStringish(node)) {
        const route = matchRoute(stringValue(node), context.routes);
        if (route) {
          const fetcher = functionStack[functionStack.length - 1] || 'global';
          if (fetcher === 'global')
          {graph.addGlobalNode(parsedFile.relativePath);}
          graph.addGlobalNode(route);
          graph.addEdge(
            parsedFile.relativePath,
            fetcher,
            route,
            'global',
            'fetches',
          );
        }
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

      const target = resolveCall(callTarget, parsedFile, context);
      if (!target) return;

      if (sourceName === 'global') {
        graph.addGlobalNode(parsedFile.relativePath);
      }
      graph.addEdge(
        parsedFile.relativePath,
        sourceName,
        target.file,
        target.label,
        'calls',
      );
      if (target.autoImported) context.autoImports.add(target.file);
    },
    leave(node) {
      if (isFunctionNode(node) || isMethodNode(node)) {
        functionStack.pop();
      }
    },
  });
}

/**
 * --files: a node per file, `defines` edges to what it defines, and
 * file -> file `imports` (static, dynamic, require, re-export; with --nuxt
 * also auto-imported composables/utils it calls and `renders` for components
 * its template uses).
 */
function addFileLayer(graph, scannedFiles, fileSet, scopes, options) {
  const { nodes } = graph.toJSON();
  for (const file of fileSet) graph.addGlobalNode(file);
  for (const node of nodes) {
    if (node.type === 'global' || node.file === 'package.json') continue;
    graph.addEdge(node.file, 'global', node.file, node.name, 'defines');
  }

  const components = options.nuxt ? nuxtComponentNames([...fileSet]) : null;
  for (const scanned of scannedFiles) {
    const file = scanned.relativePath;
    const scope = scopes.get(file) || {
      autoImports: new Set(),
      specifiers: new Set(),
    };
    const targets = new Set(scope.autoImports);
    for (const spec of scope.specifiers) {
      const target = resolveModule(file, spec, fileSet);
      if (target) targets.add(target);
    }
    for (const target of targets) {
      if (target !== file)
      {graph.addEdge(file, 'global', target, 'global', 'imports');}
    }
    if (components && scanned.ext === '.vue') {
      for (const tag of templateTags(scanned)) {
        const target =
          components.get(tag) ||
          components.get(tag.replace(/^Lazy/, '')) ||
          components.get(tag.replace(/^lazy-/, ''));
        if (target && target !== file)
        {graph.addEdge(file, 'global', target, 'global', 'renders');}
      }
    }
  }
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

  const fileList = [
    ...new Set(scanResults.files.map((file) => file.relativePath)),
  ];
  const fileSet = new Set(fileList);
  const routes = options.nuxt ? buildRoutes(fileList) : null;
  const scopes = new Map(); // file -> merged scope, for the files layer

  for (const parsedFile of parsedFiles) {
    const scope = collectScope(parsedFile);
    const context = {
      autoImports: new Set(),
      fileSet,
      nuxt: options.nuxt,
      routes,
      scope,
    };
    collectRelationships(
      parsedFile,
      graph,
      definitionsByName,
      packageDependencies,
      context,
    );
    const merged = scopes.get(parsedFile.relativePath) || {
      autoImports: new Set(),
      specifiers: new Set(),
    };
    for (const spec of scope.specifiers) merged.specifiers.add(spec);
    for (const file of context.autoImports) merged.autoImports.add(file);
    scopes.set(parsedFile.relativePath, merged);
  }

  if (options.files) {
    addFileLayer(graph, scanResults.files, fileSet, scopes, options);
  }

  const built = graph.toJSON();
  const { edges } = built;
  let { nodes } = built;
  if (options.files) {
    nodes = nodes.map((node) =>
      node.label === 'global' && node.type === 'global'
        ? { ...node, label: node.file, type: 'file' }
        : node,
    );
  }

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
  resolveModule,
  collectDefinitions,
  collectRelationships,
  formatLines,
  packageNameFromSpecifier,
};
