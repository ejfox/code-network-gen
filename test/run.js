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
const { execFileSync } = require('child_process');
const { createProgram, writeOutput } = require('../lib/cli');
const { addGitDates } = require('../lib/gitDates');

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

async function withTempProjectAsync(files, callback) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-network-gen-'));
  try {
    for (const [fileName, content] of Object.entries(files)) {
      const filePath = path.join(tempDir, fileName);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content);
    }
    return await callback(tempDir);
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

function testIgnoredDirectoriesAreSkipped() {
  withTempProject(
    {
      'src/main.js': 'function main() {}\n',
      'vendor/lib.js': 'function vendored() {}\n',
      '.claude/worktrees/agent-1/src/main.js': 'function main() {}\n',
      '.output/server/index.mjs': 'function built() {}\n',
    },
    (tempDir) => {
      const ids = (options) =>
        analyzeDirectory(tempDir, options).nodes.map((node) => node.id);

      // .claude and .output are skipped by default
      assert.deepStrictEqual(ids().sort(), [
        'src/main.js:main',
        'vendor/lib.js:vendored',
      ]);
      assert.deepStrictEqual(ids({ ignoreDirs: ['vendor'] }), [
        'src/main.js:main',
      ]);
    },
  );

  const program = createProgram().parse([
    'node',
    'cli',
    '--path',
    '.',
    '--ignore',
    'vendor, public,,data',
  ]);
  assert.deepStrictEqual(program.opts().ignore, ['vendor', 'public', 'data']);
  assert.deepStrictEqual(
    createProgram().parse(['node', 'cli', '--path', '.']).opts().ignore,
    [],
  );
}

function testLocalBindingsShadowOtherFilesDefinitions() {
  withTempProject(
    {
      'components/Card.vue': `<template><div /></template>
<script setup>
const emit = defineEmits(['save']);
function save() {
  emit('save');
}
</script>`,
      'server/utils/mcp.ts': 'export function emit(event) { return event; }',
    },
    (projectDir) => {
      const { edges, errors } = analyzeDirectory(projectDir);
      assert.deepStrictEqual(errors, []);
      // `emit` is a local in Card.vue, not the server's emit
      assert(!edges.some((e) => e.target === 'server/utils/mcp.ts:emit'));
    },
  );
}

function testImportsResolveToTheImportedFileOnly() {
  withTempProject(
    {
      'src/a.js': `import { format as fmt } from './b';
import def from './c.js';
export function run() { fmt(); def(); }`,
      'src/b.js': 'export function format() {}',
      'src/c.ts': 'export default function () {}',
      'src/other.js': 'export function format() {}',
      'src/cjs.js': `const { format } = require('./b');
function go() { format(); }`,
    },
    (projectDir) => {
      const { edges, errors } = analyzeDirectory(projectDir);
      assert.deepStrictEqual(errors, []);
      assert(hasEdge(edges, 'src/a.js:run', 'src/b.js:format'));
      assert(!hasEdge(edges, 'src/a.js:run', 'src/other.js:format'));
      assert(hasEdge(edges, 'src/a.js:run', 'src/c.ts:default'));
      assert(hasEdge(edges, 'src/cjs.js:go', 'src/b.js:format'));
      assert(!hasEdge(edges, 'src/cjs.js:go', 'src/other.js:format'));
    },
  );
}

function testFreeNamesLinkOnlyWhenUnambiguous() {
  withTempProject(
    {
      'main.js': 'function main() { unique(); twice(); }',
      'one.js': 'function unique() {} function twice() {}',
      'two.js': 'function twice() {}',
    },
    (projectDir) => {
      const { edges } = analyzeDirectory(projectDir);
      assert(hasEdge(edges, 'main.js:main', 'one.js:unique'));
      assert(
        !edges.some(
          (e) => e.source === 'main.js:main' && e.target.endsWith(':twice'),
        ),
      );
    },
  );
}

function testFilesModeAddsFileNodesDefinesAndImports() {
  withTempProject(
    {
      'src/a.js': 'import { b } from \'./b\';\nexport const a = () => b();',
      'src/b.js': 'export function b() {}',
      'src/empty.js': 'export const value = 1;',
    },
    (projectDir) => {
      const { nodes, edges } = analyzeDirectory(projectDir, { files: true });
      const byId = new Map(nodes.map((n) => [n.id, n]));
      assert.strictEqual(byId.get('src/a.js:global').type, 'file');
      assert.strictEqual(byId.get('src/a.js:global').label, 'src/a.js');
      assert(byId.has('src/empty.js:global'));
      assert(hasEdge(edges, 'src/a.js:global', 'src/a.js:a', 'defines'));
      assert(hasEdge(edges, 'src/a.js:global', 'src/b.js:global', 'imports'));
      assert(hasEdge(edges, 'src/a.js:a', 'src/b.js:b'));
    },
  );
}

function testNuxtAutoImportsComponentsAndRoutes() {
  withTempProject(
    {
      'pages/index.vue': `<template>
  <div><NetworkCard /><welcome-scrub-film /><UiButton /><LazyNetworkCard /></div>
</template>
<script setup>
const { add } = useEditor();
async function load(id) {
  await $fetch(\`/api/networks/\${id}/batch\`, { method: 'POST' });
  return $fetch('/api/networks');
}
</script>`,
      'components/NetworkCard.vue': '<template><div /></template>',
      'components/welcome/ScrubFilm.vue': '<template><div /></template>',
      'components/ui/UiButton.vue': '<template><button /></template>',
      'composables/useEditor.ts': 'export function useEditor() { return { add() {} }; }',
      'composables/nested/deep.ts': 'export function useEditor() {}',
      'server/api/networks/[id]/batch.post.ts': 'export default defineEventHandler(() => getDb());',
      'server/api/networks/index.get.ts': 'export default defineEventHandler(() => getDb());',
      'server/utils/db.ts': 'export function getDb() {}',
      'utils/db.ts': 'export function getDb() {}',
    },
    (projectDir) => {
      const { edges, errors } = analyzeDirectory(projectDir, {
        files: true,
        nuxt: true,
      });
      assert.deepStrictEqual(errors, []);
      const page = 'pages/index.vue:global';
      assert(
        hasEdge(edges, page, 'components/NetworkCard.vue:global', 'renders'),
      );
      assert(
        hasEdge(
          edges,
          page,
          'components/welcome/ScrubFilm.vue:global',
          'renders',
        ),
      );
      assert(
        hasEdge(edges, page, 'components/ui/UiButton.vue:global', 'renders'),
      );
      // auto-imported from top-level composables/ only, so nested/deep.ts doesn't make it ambiguous
      assert(hasEdge(edges, page, 'composables/useEditor.ts:useEditor'));
      assert(
        hasEdge(edges, page, 'composables/useEditor.ts:global', 'imports'),
      );
      assert(
        hasEdge(
          edges,
          'pages/index.vue:load',
          'server/api/networks/[id]/batch.post.ts:global',
          'fetches',
        ),
      );
      assert(
        hasEdge(
          edges,
          'pages/index.vue:load',
          'server/api/networks/index.get.ts:global',
          'fetches',
        ),
      );
      // server code auto-imports server/utils, never the client's utils/
      const route = 'server/api/networks/index.get.ts:default';
      const fromRoute = edges.filter((e) =>
        e.source.startsWith('server/api/networks/index.get.ts'),
      );
      assert(
        fromRoute.some((e) => e.target === 'server/utils/db.ts:getDb'),
        JSON.stringify(fromRoute),
      );
      assert(!fromRoute.some((e) => e.target === 'utils/db.ts:getDb'));
      void route;
    },
  );
}

function testIgnoreMatchesFileNames() {
  withTempProject(
    {
      'src/main.js': 'function main() {}\n',
      'anime.esm.js': 'function vendoredAnime() {}\n',
    },
    (tempDir) => {
      const ids = analyzeDirectory(tempDir, {
        ignoreDirs: ['anime.esm.js'],
      }).nodes.map((n) => n.id);
      assert.deepStrictEqual(ids, ['src/main.js:main']);
    },
  );
}

async function testGitDates() {
  await withTempProjectAsync(
    {
      'a.js': 'function first() {}\n',
    },
    async (dir) => {
      const git = (...args) =>
        execFileSync('git', args, {
          cwd: dir,
          env: {
            ...process.env,
            GIT_AUTHOR_DATE: '2024-02-26T12:00:00Z',
            GIT_COMMITTER_DATE: '2024-02-26T12:00:00Z',
          },
        });
      git('init', '-q');
      git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.');
      git(
        '-c',
        'user.email=t@t',
        '-c',
        'user.name=t',
        'commit',
        '-q',
        '-m',
        'one',
      );
      fs.appendFileSync(path.join(dir, 'a.js'), 'function second() {}\n');
      execFileSync(
        'git',
        [
          '-c',
          'user.email=t@t',
          '-c',
          'user.name=t',
          'commit',
          '-q',
          '-am',
          'two',
        ],
        {
          cwd: dir,
          env: {
            ...process.env,
            GIT_AUTHOR_DATE: '2025-03-14T12:00:00Z',
            GIT_COMMITTER_DATE: '2025-03-14T12:00:00Z',
          },
        },
      );
      const { nodes } = analyzeDirectory(dir, { files: true });
      await addGitDates(nodes, dir);
      const created = Object.fromEntries(nodes.map((n) => [n.id, n.created]));
      assert.strictEqual(created['a.js:global'], '2024-02-26');
      assert.strictEqual(created['a.js:first'], '2024-02-26');
      assert.strictEqual(created['a.js:second'], '2025-03-14');
    },
  );
}

function testJsonOutputKeepsEveryField() {
  withTempProject({}, (projectDir) => {
    const outputPrefix = path.join(projectDir, 'out', 'net');
    const originalLog = console.log;
    try {
      console.log = () => {};
      writeOutput(
        outputPrefix,
        'json',
        [
          {
            id: 'a.js:f',
            label: 'f',
            type: 'function',
            lines: '[1-1]',
            created: '2024-01-01',
          },
        ],
        [],
      );
    } finally {
      console.log = originalLog;
    }
    const data = JSON.parse(fs.readFileSync(`${outputPrefix}.json`, 'utf8'));
    assert.strictEqual(data.nodes[0].created, '2024-01-01');
    assert.deepStrictEqual(data.edges, []);
  });
}

async function main() {
  testForwardDeclarationsAndArrowFunctions();
  testIgnoredDirectoriesAreSkipped();
  testDependencyTracking();
  testStandaloneFunctionsRemainVisible();
  testMemberCallsDoNotCrossMatchByName();
  testFormattersProduceContent();
  testCsvOutputContractStaysPortable();
  testPackageSpecifierParsing();
  testLocalBindingsShadowOtherFilesDefinitions();
  testImportsResolveToTheImportedFileOnly();
  testFreeNamesLinkOnlyWhenUnambiguous();
  testFilesModeAddsFileNodesDefinesAndImports();
  testNuxtAutoImportsComponentsAndRoutes();
  testIgnoreMatchesFileNames();
  testJsonOutputKeepsEveryField();
  await testGitDates();

  console.log('All tests passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
