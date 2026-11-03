'use strict';

const tsParser = require('@typescript-eslint/parser');
const { parse: parseVueComponent } = require('@vue/compiler-sfc');

function parseScript(content, filePath, lineOffset = 0) {
  const parserOptions = {
    comment: false,
    ecmaFeatures: {
      jsx: true,
    },
    ecmaVersion: 'latest',
    loc: true,
    range: false,
    tokens: false,
  };

  const sources = ['module', 'script'];
  let lastError;

  for (const sourceType of sources) {
    try {
      const ast = tsParser.parse(content, {
        ...parserOptions,
        sourceType,
      });

      return {
        ast,
        lineOffset,
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`Could not parse ${filePath}: ${lastError.message}`);
}

function getBlockLineOffset(block) {
  return Math.max(0, (block?.loc?.start?.line || 1) - 1);
}

function parseSourceFile(file) {
  if (file.ext !== '.vue') {
    return [parseScript(file.content, file.relativePath)];
  }

  const { descriptor, errors } = parseVueComponent(file.content, {
    filename: file.absolutePath,
  });

  if (errors.length > 0) {
    throw new Error(errors.map((error) => error.message || error).join('; '));
  }

  const scripts = [];

  if (descriptor.script?.content) {
    scripts.push(
      parseScript(
        descriptor.script.content,
        file.relativePath,
        getBlockLineOffset(descriptor.script),
      ),
    );
  }

  if (descriptor.scriptSetup?.content) {
    scripts.push(
      parseScript(
        descriptor.scriptSetup.content,
        file.relativePath,
        getBlockLineOffset(descriptor.scriptSetup),
      ),
    );
  }

  return scripts;
}

/** every element tag a .vue template uses (for Nuxt component auto-imports) */
function templateTags(file) {
  const { descriptor } = parseVueComponent(file.content, {
    filename: file.absolutePath,
  });
  const tags = new Set();
  const walk = (node) => {
    if (node.type === 1) tags.add(node.tag); // ELEMENT
    for (const child of node.children || []) walk(child);
    for (const branch of node.branches || []) walk(branch);
  };
  if (descriptor.template?.ast) walk(descriptor.template.ast);
  return tags;
}

module.exports = {
  parseSourceFile,
  templateTags,
};
