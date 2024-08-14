# Code Network Generator

This tool analyzes JavaScript and Vue.js codebases to generate a network of functions and method interactions. It outputs the results as CSV files, detailing the relationships between different parts of your code.

## Installation

Clone the repository and navigate to the directory:

```bash
git clone https://github.com/your-repo/code-network-gen.git
cd code-network-gen
```

Install the necessary dependencies:

```bash
yarn install
```

## Usage

Run the tool from the command line:

```bash
yarn start --path <directory> -o <output-filename-base>
```

Or using NPX:

```bash
npx code-network-gen --path <directory> -o <output-filename-base>
```

### Options

- `--path <directory>`: Specify the directory to analyze. This is required.
- `-o <output-filename>`: Specify the base name for the output CSV files. The tool will create two files: `<output-filename>_nodes.csv` and `<output-filename>_edges.csv`.

### Example

Analyze the current directory and save the results as `code_analysis_nodes.csv` and `code_analysis_edges.csv`:

```bash
yarn start --path . -o code_analysis
```

## Output

- `<output-filename>_nodes.csv`: Lists all identified functions/methods.
  - Columns: `id`, `label`, `type`, `lines`
- `<output-filename>_edges.csv`: Lists all function/method calls.
  - Columns: `source`, `target`, `type`

## How NOT to Use It

- **Do not** run on directories with no JavaScript or Vue.js files. It will generate empty outputs.
- **Do not** use non-standard file extensions. The tool expects `.js`, `.jsx`, `.ts`, `.tsx`, and `.vue` files.

## Requirements

- Node.js
- Yarn