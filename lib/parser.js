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

module.exports = {
  parseSourceFile,
};
