# code-network-gen

parses js/vue codebases and outputs function call networks as csv or gexf files. useful for understanding code structure, dependencies, and architectural patterns.

## network examples

here's what different codebases look like as network diagrams:

### simple utility library pattern
```mermaid
flowchart TD
    main["main.js"] --> utils["utils.js"]
    main --> api["api.js"] 
    main --> config["config.js"]
    
    utils --> validate["validate()"]
    utils --> format["format()"]
    utils --> parse["parse()"]
    
    api --> get["get()"]
    api --> post["post()"]
    api --> utils
    
    config --> defaults["defaults"]
    config --> validate
    
    classDef fileNode fill:#e1f5fe,stroke:#01579b,stroke-width:2px
    classDef funcNode fill:#f3e5f5,stroke:#4a148c,stroke-width:2px
    class main,utils,api,config fileNode
    class validate,format,parse,get,post,defaults funcNode
```

### cli tool architecture
```mermaid
flowchart TD
    bin["bin/cli.js"] --> cmd["commands/"]
    bin --> parse["parseArgs()"]
    
    cmd --> build["build.js"]
    cmd --> serve["serve.js"] 
    cmd --> init["init.js"]
    
    build --> bundle["bundle()"]
    build --> minify["minify()"]
    build --> utils["utils/"]
    
    serve --> server["startServer()"]
    serve --> watch["watchFiles()"]
    serve --> utils
    
    init --> scaffold["scaffold()"]
    init --> template["templates/"]
    init --> utils
    
    utils --> log["logger.js"]
    utils --> file["fileUtils.js"]
    
    classDef entryNode fill:#ffebee,stroke:#c62828,stroke-width:2px
    classDef moduleNode fill:#e1f5fe,stroke:#01579b,stroke-width:2px  
    classDef funcNode fill:#f3e5f5,stroke:#4a148c,stroke-width:2px
    class bin entryNode
    class cmd,build,serve,init,utils,log,file,template moduleNode
    class parse,bundle,minify,server,watch,scaffold funcNode
```

### react component tree
```mermaid
flowchart TD
    app["App.jsx"] --> header["Header.jsx"]
    app --> main["Main.jsx"]
    app --> footer["Footer.jsx"]
    
    header --> nav["Navigation.jsx"]
    header --> logo["Logo.jsx"]
    
    main --> list["ItemList.jsx"] 
    main --> form["ItemForm.jsx"]
    
    list --> item["Item.jsx"]
    list --> useItems["useItems()"]
    
    form --> input["Input.jsx"]
    form --> button["Button.jsx"]
    form --> useForm["useForm()"]
    
    item --> button
    
    classDef componentNode fill:#fff3e0,stroke:#e65100,stroke-width:2px
    classDef hookNode fill:#e8f5e8,stroke:#1b5e20,stroke-width:2px
    class app,header,main,footer,nav,logo,list,form,item,input,button componentNode
    class useItems,useForm hookNode
```

## quick start

analyze any codebase in one command:

```bash
npx code-network-gen --path . -o my_code_network
```

that's it. creates `my_code_network_nodes.csv` and `my_code_network_edges.csv` in seconds.

## usage

```bash
code-network-gen --path <directory> [-o output_name] [-f format]
```

### options

- `--path` - directory to analyze (required)
- `-o` - output file prefix (optional, outputs to console if omitted)
- `-f, --format` - output format: `csv` (default), `gexf` (for Gephi), `graphml` (for yEd, Cytoscape), `dot` (for Graphviz), or `mermaid` (for GitHub, Notion, etc.)

### examples

analyze current directory:
```bash
code-network-gen --path .
```

analyze with csv output:
```bash
code-network-gen --path ./src -o my_project
# creates: my_project_nodes.csv, my_project_edges.csv
```

analyze with gexf output for gephi:
```bash
code-network-gen --path ./src -o my_project --format gexf
# creates: my_project.gexf (ready to open in Gephi)
```

analyze with graphml output for yed/cytoscape:
```bash
code-network-gen --path ./src -o my_project --format graphml
# creates: my_project.graphml (ready to open in yEd, Cytoscape, etc.)
```

analyze with dot output for graphviz:
```bash
code-network-gen --path ./src -o my_project --format dot
# creates: my_project.dot (ready for Graphviz tools)
```

analyze with mermaid output for documentation:
```bash
code-network-gen --path ./src -o my_project --format mermaid
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