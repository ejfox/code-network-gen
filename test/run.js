'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  analyzeDirectory,
  packageNameFromSpecifier,
} = require('../lib/analyzer');
const {
  generateDot,
  generateGexf,
  generateGraphml,
  generateMermaid,
} = require('../lib/formatters');
const { writeOutput } = require('../lib/cli');

function withTempProject(files, callback) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-network-gen-'));

  try {
    for (const [fileName, content] of Object.entries(files)) {
      const filePath = path.join(tempDir, fileName);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content);
    }

    return callback(tempDir);
  } finally {
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
}

function hasEdge(edges, source, target, type = 'calls') {
  return edges.some(
    (edge) =>
      edge.source === source && edge.target === target && edge.type === type,
  );
}

function testForwardDeclarationsAndArrowFunctions() {
  withTempProject(
    {
      'src/main.js': `
      function main() {
        later();
        helper();
      }

      const helper = () => later();

      function later() {
        return true;
      }

      main();
    `,
    },
    (projectDir) => {
      const { nodes, edges, errors } = analyzeDirectory(projectDir);
      const nodeIds = new Set(nodes.map((node) => node.id));

      assert.deepStrictEqual(errors, []);
      assert(nodeIds.has('src/main.js:main'));
      assert(nodeIds.has('src/main.js:helper'));
      assert(nodeIds.has('src/main.js:later'));
      assert(hasEdge(edges, 'src/main.js:main', 'src/main.js:later'));
      assert(hasEdge(edges, 'src/main.js:main', 'src/main.js:helper'));
      assert(hasEdge(edges, 'src/main.js:helper', 'src/main.js:later'));
      assert(hasEdge(edges, 'src/main.js:global', 'src/main.js:main'));
    },
  );
}

function testDependencyTracking() {
  withTempProject(
    {
      'package.json': JSON.stringify({
        dependencies: {
          '@scope/pkg': '^1.0.0',
          lodash: '^4.0.0',
        },
      }),
      'src/main.js': `
      import map from 'lodash/map';

      function load() {
        const scoped = require('@scope/pkg/utils');
        return map([scoped], Boolean);
      }

      load();
    `,
    },
    (projectDir) => {
      const { nodes, edges, errors } = analyzeDirectory(projectDir, {
        includeDeps: true,
      });
      const nodeIds = new Set(nodes.map((node) => node.id));

      assert.deepStrictEqual(errors, []);
      assert(nodeIds.has('package.json:lodash'));
      assert(nodeIds.has('package.json:@scope/pkg'));
      assert(
        hasEdge(edges, 'src/main.js:global', 'package.json:lodash', 'imports'),
      );
      assert(
        hasEdge(
          edges,
          'src/main.js:load',
          'package.json:@scope/pkg',
          'requires',
        ),
      );
    },
  );
}

function testStandaloneFunctionsRemainVisible() {
  withTempProject(
    {
      'lonely.js': `
      function unusedButReal() {
        return 42;
      }
    `,
    },
    (projectDir) => {
      const { nodes, edges, errors } = analyzeDirectory(projectDir);
      const nodeIds = new Set(nodes.map((node) => node.id));

      assert.deepStrictEqual(errors, []);
      assert(nodeIds.has('lonely.js:unusedButReal'));
      assert.deepStrictEqual(edges, []);
    },
  );
}

function testMemberCallsDoNotCrossMatchByName() {
  withTempProject(
    {
      'a.js': `
      function run(visitor) {
        visitor.enter();
      }
    `,
      'b.js': `
      function enter() {
        return true;
      }
    `,
    },
    (projectDir) => {
      const { edges, errors } = analyzeDirectory(projectDir);

      assert.deepStrictEqual(errors, []);
      assert(!hasEdge(edges, 'a.js:run', 'b.js:enter'));
    },
  );
}

function testFormattersProduceContent() {
  const nodes = [
    { id: 'src/main.js:global', label: 'global', type: 'global', lines: '' },
    { id: 'src/main.js:main', label: 'main', type: 'function', lines: '[1-3]' },
  ];
  const edges = [
    { source: 'src/main.js:global', target: 'src/main.js:main', type: 'calls' },
  ];

  assert(generateDot(nodes, edges).includes('digraph CodeNetwork'));
  assert(generateGexf(nodes, edges).includes('<gexf'));
  assert(generateGraphml(nodes, edges).includes('<graphml'));
  assert(generateMermaid(nodes, edges).includes('flowchart TD'));
}

function testCsvOutputContractStaysPortable() {
  withTempProject({}, (projectDir) => {
    const outputPrefix = path.join(projectDir, 'output', 'network');
    const originalLog = console.log;
    const nodes = [
      {
        id: 'src/main.js:main',
        label: 'main',
        type: 'function',
        lines: '[1-3]',
      },
    ];
    const edges = [
      {
        source: 'src/main.js:global',
        target: 'src/main.js:main',
        type: 'calls',
      },
    ];

    try {
      console.log = () => {};
      writeOutput(outputPrefix, 'csv', nodes, edges);
    } finally {
      console.log = originalLog;
    }

    assert.strictEqual(
      fs.readFileSync(`${outputPrefix}_nodes.csv`, 'utf8'),
      '"id","label","type","lines"\n"src/main.js:main","main","function","[1-3]"',
    );
    assert.strictEqual(
      fs.readFileSync(`${outputPrefix}_edges.csv`, 'utf8'),
      '"source","target","type"\n"src/main.js:global","src/main.js:main","calls"',
    );
  });
}

function testPackageSpecifierParsing() {
  assert.strictEqual(packageNameFromSpecifier('lodash/map'), 'lodash');
  assert.strictEqual(packageNameFromSpecifier('@scope/pkg/lib'), '@scope/pkg');
  assert.strictEqual(packageNameFromSpecifier('./local'), null);
}

testForwardDeclarationsAndArrowFunctions();
testDependencyTracking();
testStandaloneFunctionsRemainVisible();
testMemberCallsDoNotCrossMatchByName();
testFormattersProduceContent();
testCsvOutputContractStaysPortable();
testPackageSpecifierParsing();

console.log('All tests passed.');
