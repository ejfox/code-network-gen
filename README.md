# code-network-gen

parses js/vue codebases and outputs function call networks as csv or gexf files. useful for understanding code structure, dependencies, and architectural patterns.

## quick start

analyze any codebase in one command:

```bash
npx code-network-gen --path . -o my_code_network
```

that's it. creates `my_code_network_nodes.csv` and `my_code_network_edges.csv` in seconds.

## example output

here's what the tool finds when analyzing a simple CLI app with 12 functions across 4 files:

**nodes.csv** (functions and methods):
```csv
"id","label","type","lines"
"data.js:loadBookmarks","loadBookmarks","function","[14-31]"
"data.js:formatTableData","formatTableData","function","[37-54]"
"data.js:reloadBookmarks","reloadBookmarks","function","[56-62]"
"data.js:searchBookmarks","searchBookmarks","function","[64-84]"
"index.mjs:showLoadingScreen","showLoadingScreen","function","[13-85]"
"index.mjs:main","main","function","[88-156]"
"ui.js:viewSummary","viewSummary","function","[21-65]"
"ui.js:updateSummary","updateSummary","function","[67-90]"
```

**edges.csv** (function call relationships):
```csv
"source","target","type"
"data.js:global","data.js:loadBookmarks","calls"
"index.mjs:global","index.mjs:showLoadingScreen","calls"
"index.mjs:global","data.js:loadBookmarks","calls"
"index.mjs:global","index.mjs:main","calls"
"ui.js:global","ui.js:viewSummary","calls"
"ui.js:global","data.js:formatTableData","calls"
"ui.js:global","ui.js:updateDisplay","calls"
"ui.js:global","data.js:reloadBookmarks","calls"
```

shows clear separation between data handling (`data.js`), user interface (`ui.js`), and application entry point (`index.mjs`). perfect for understanding code architecture at a glance.

## usage

```bash
npx code-network-gen --path <directory> [-o output_name] [-f format]
# or locally: node index.js --path <directory> [-o output_name] [-f format]
```

### options

- `--path` - directory to analyze (required)
- `-o` - output file prefix (optional, outputs to console if omitted)
- `-f, --format` - output format: `csv` (default), `gexf` (for Gephi), `graphml` (for yEd, Cytoscape), `dot` (for Graphviz), or `mermaid` (for GitHub, Notion, etc.)

### examples

analyze current directory:

```bash
npx code-network-gen --path .
```

analyze with csv output:

```bash
npx code-network-gen --path ./src -o my_project
# creates: my_project_nodes.csv, my_project_edges.csv
```

analyze with gexf output for gephi:

```bash
npx code-network-gen --path ./src -o my_project --format gexf
# creates: my_project.gexf (ready to open in Gephi)
```

analyze with graphml output for yed/cytoscape:

```bash
npx code-network-gen --path ./src -o my_project --format graphml
# creates: my_project.graphml (ready to open in yEd, Cytoscape, etc.)
```

analyze with dot output for graphviz:

```bash
npx code-network-gen --path ./src -o my_project --format dot
# creates: my_project.dot (ready for Graphviz tools)
```

analyze with mermaid output for documentation:

```bash
npx code-network-gen --path ./src -o my_project --format mermaid
# creates: my_project.mmd (ready to paste into GitHub, Notion, Obsidian, etc.)
```

## what it finds

- function declarations
- arrow functions
- class methods
- vue component methods
- function calls and their relationships

supports: `.js`, `.jsx`, `.ts`, `.tsx`, `.vue`

## output formats

### csv format (default)

**nodes.csv**: functions and methods

```csv
id,label,type,lines
src/utils.js:formatDate,formatDate,function,[15-22]
```

**edges.csv**: function call relationships

```csv
source,target,type
src/app.js:global,src/utils.js:formatDate,calls
```

### gexf format (for gephi)

**output.gexf**: complete network in xml format

- nodes with id, label, type, and lines attributes
- edges with source, target, and type attributes
- ready to import directly into gephi
- includes proper xml schema and metadata

### graphml format (for yed, cytoscape)

**output.graphml**: universal graph format in xml

- nodes with id, label, type, and lines attributes
- edges with source, target, and type attributes
- compatible with yEd, Cytoscape, and other graph tools
- follows GraphML specification with proper key definitions

### dot format (for graphviz)

**output.dot**: graphviz dot format

- nodes with labels, types, and color coding
- edges with different styles based on relationship types
- compatible with dot, neato, fdp, circo, twopi, sfdp
- ready for rendering with Graphviz tools

### mermaid format (for documentation)

**output.mmd**: mermaid flowchart format

- intelligent filtering to keep diagrams readable (max 50 nodes)
- different node shapes for functions, methods, classes, vue-methods
- color-coded styling for different node types
- ready to paste into GitHub markdown, Notion, Obsidian, etc.
- renders natively in many documentation platforms

## development

```bash
git clone <repo>
npm install
npm test  # runs meta-analysis (tool analyzes itself)
npm run lint
```

## import into tools

**gephi**:

- gexf: file → open → select the .gexf file (recommended)
- csv: file → import → choose nodes csv, then edges csv

**yed**: file → open → select the .graphml file (recommended)

**cytoscape**:

- graphml: file → import → network from file → select .graphml file
- csv: file → import → network from table → select both csv files  
  **d3/observable**: `d3.csv()` both csv files, standard network format  
  **python networkx**:
- gexf: `nx.read_gexf('file.gexf')`
- graphml: `nx.read_graphml('file.graphml')`
- csv: `pandas.read_csv()` then `nx.from_pandas_edgelist()`

**r igraph**:

- gexf: `read_graph('file.gexf', format='gexf')`
- graphml: `read_graph('file.graphml', format='graphml')`
- csv: `read.csv()` then `graph_from_data_frame()`

**mermaid/documentation platforms**:

- github: paste `.mmd` content into markdown files with ` ```mermaid ` blocks
- notion: paste as mermaid diagram block
- obsidian: paste with ` ```mermaid ` code block
- gitbook: paste as mermaid diagram
- confluence: use mermaid macro with `.mmd` content

## how it works

1. walks directory tree
2. parses ast with acorn
3. extracts function definitions and calls
4. outputs network graph as csv

that's it.

