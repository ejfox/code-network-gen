'use strict';

const fs = require('fs');
const path = require('path');
const { Command } = require('commander');
const { parse: parseCsv } = require('json2csv');
const { analyzeDirectory } = require('./analyzer');
const { addGitDates } = require('./gitDates');
const {
  generateDot,
  generateGexf,
  generateGraphml,
  generateMermaid,
} = require('./formatters');
const { version } = require('../package.json');

const VALID_FORMATS = new Set([
  'csv',
  'json',
  'gexf',
  'graphml',
  'dot',
  'mermaid',
]);

function createProgram() {
  return new Command()
    .version(version)
    .description(
      'Analyze JavaScript and TypeScript code structure as a call network',
    )
    .requiredOption(
      '-p, --path <directory>',
      'Path to the directory to analyze',
    )
    .option('-o, --output <file>', 'Output filename for the analysis results')
    .option(
      '-f, --format <format>',
      'Output format: csv, json, gexf, graphml, dot, or mermaid',
      'csv',
    )
    .option(
      '--include-deps',
      'Include package.json dependencies in the network analysis',
    )
    .option(
      '--files',
      'Add a node per file, `defines` edges to its functions and file-to-file `imports`',
    )
    .option(
      '--nuxt',
      'Nuxt conventions: auto-imports, template components (`renders`), $fetch to server/api routes (`fetches`)',
    )
    .option(
      '--git-dates',
      'Add a `created` date (YYYY-MM-DD) per node from git history',
    )
    .option(
      '--ignore <names>',
      'Comma-separated directory or file names to skip, on top of the defaults',
      (value) =>
        value
          .split(',')
          .map((d) => d.trim())
          .filter(Boolean),
      [],
    );
}

function displayResults(nodes, edges) {
  console.log('Nodes:');
  for (const { id, label, type } of nodes) {
    console.log(`${id} - ${label || ''} (${type})`);
  }

  console.log('\nEdges:');
  for (const { source, target, type } of edges) {
    console.log(`${source} -> ${target} (${type})`);
  }

  console.log(`\nTotal unique nodes: ${nodes.length}`);
  console.log(`Total unique edges: ${edges.length}`);
}

function writeCsvOutput(outputPrefix, nodes, edges) {
  ensureOutputDirectory(outputPrefix);

  const nodeFields = ['id', 'label', 'type', 'lines'];
  if (nodes.some((node) => node.created)) nodeFields.push('created');
  const edgeFields = ['source', 'target', 'type'];
  const nodesCsv =
    nodes.length > 0
      ? parseCsv(nodes, { fields: nodeFields })
      : `${nodeFields.join(',')}\n`;
  const edgesCsv =
    edges.length > 0
      ? parseCsv(edges, { fields: edgeFields })
      : `${edgeFields.join(',')}\n`;
  const nodesFile = `${outputPrefix}_nodes.csv`;
  const edgesFile = `${outputPrefix}_edges.csv`;

  fs.writeFileSync(nodesFile, nodesCsv);
  fs.writeFileSync(edgesFile, edgesCsv);

  console.log(`Results saved to ${nodesFile} and ${edgesFile}`);
  console.log(`  - Nodes: ${nodes.length} entries`);
  console.log(`  - Edges: ${edges.length} entries`);
}

function writeSingleFileOutput(
  outputPrefix,
  extension,
  content,
  label,
  nodes,
  edges,
) {
  ensureOutputDirectory(outputPrefix);

  const outputFile = `${outputPrefix}.${extension}`;
  fs.writeFileSync(outputFile, content);

  console.log(`Results saved to ${outputFile}`);
  console.log(`  - Nodes: ${nodes.length} entries`);
  console.log(`  - Edges: ${edges.length} entries`);
  console.log(`  - Format: ${label}`);
}

function ensureOutputDirectory(outputPrefix) {
  const outputDirectory = path.dirname(path.resolve(outputPrefix));

  fs.mkdirSync(outputDirectory, { recursive: true });
}

function writeOutput(outputPrefix, format, nodes, edges) {
  switch (format) {
    case 'csv':
      writeCsvOutput(outputPrefix, nodes, edges);
      break;
    case 'json':
      writeSingleFileOutput(
        outputPrefix,
        'json',
        `${JSON.stringify({ nodes, edges }, null, 1)}\n`,
        'JSON (node-link)',
        nodes,
        edges,
      );
      break;
    case 'dot':
      writeSingleFileOutput(
        outputPrefix,
        'dot',
        generateDot(nodes, edges),
        'DOT (Graphviz)',
        nodes,
        edges,
      );
      break;
    case 'gexf':
      writeSingleFileOutput(
        outputPrefix,
        'gexf',
        generateGexf(nodes, edges),
        'GEXF (Graph Exchange XML Format)',
        nodes,
        edges,
      );
      break;
    case 'graphml':
      writeSingleFileOutput(
        outputPrefix,
        'graphml',
        generateGraphml(nodes, edges),
        'GraphML (yEd, Cytoscape)',
        nodes,
        edges,
      );
      break;
    case 'mermaid':
      writeSingleFileOutput(
        outputPrefix,
        'mmd',
        generateMermaid(nodes, edges),
        'Mermaid flowchart',
        nodes,
        edges,
      );
      break;
    default:
      throw new Error(`Unsupported format: ${format}`);
  }
}

function validateOptions(options) {
  const inputPath = path.resolve(options.path);

  if (!fs.existsSync(inputPath)) {
    throw new Error(`Directory '${options.path}' does not exist`);
  }

  if (!fs.statSync(inputPath).isDirectory()) {
    throw new Error(`Path '${options.path}' is not a directory`);
  }

  if (!VALID_FORMATS.has(options.format)) {
    throw new Error(
      'Invalid format. Please specify "csv", "json", "gexf", "graphml", "dot", or "mermaid"',
    );
  }

  return inputPath;
}

async function runCli(argv = process.argv) {
  const program = createProgram();

  try {
    program.parse(argv);
    const options = program.opts();
    const inputPath = validateOptions(options);

    console.log(`Analyzing directory: ${inputPath}`);

    const { nodes, edges, errors, stats } = analyzeDirectory(inputPath, {
      files: options.files,
      ignoreDirs: options.ignore,
      includeDeps: options.includeDeps,
      nuxt: options.nuxt,
    });
    if (options.gitDates) await addGitDates(nodes, inputPath);

    if (nodes.length === 0) {
      console.log('\nNo nodes found. Analysis complete.');
      return;
    }

    displayResults(nodes, edges);

    if (options.output) {
      console.log('\nGenerating output files...');
      writeOutput(options.output, options.format, nodes, edges);
    }

    if (errors.length > 0) {
      console.log(
        `\nAnalysis completed with ${errors.length} file parsing errors.`,
      );
      for (const error of errors) {
        console.log(`  - ${error.file}: ${error.message}`);
      }
      process.exitCode = 2;
    } else {
      console.log(
        `\nAnalysis completed successfully. Parsed ${stats.parsedFiles} script(s).`,
      );
    }
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  createProgram,
  displayResults,
  runCli,
  validateOptions,
  writeOutput,
};
