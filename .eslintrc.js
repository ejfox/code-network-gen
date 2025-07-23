module.exports = {
  env: {
    es2020: true,
    node: true,
  },
  extends: [
    'eslint:recommended',
  ],
  parserOptions: {
    ecmaVersion: 2020,
    sourceType: 'module',
  },
  rules: {
    // Code style
    'indent': ['error', 2],
    'quotes': ['error', 'single', { 'avoidEscape': true }],
    'semi': ['error', 'always'],
    'comma-dangle': ['error', 'always-multiline'],
    'no-trailing-spaces': 'error',
    'eol-last': ['error', 'always'],
    
    // Variables
    'no-unused-vars': ['warn', { 
      'argsIgnorePattern': '^_',
      'varsIgnorePattern': '^_',
    }],
    'no-undef': 'error',
    'no-var': 'error',
    'prefer-const': 'warn',
    
    // Best practices
    'no-console': 'off', // CLI tools need console
    'curly': ['error', 'multi-line'],
    'eqeqeq': ['error', 'always', { 'null': 'ignore' }],
    'no-throw-literal': 'error',
    
    // ES6+
    'arrow-spacing': ['error', { 'before': true, 'after': true }],
    'no-duplicate-imports': 'error',
    'prefer-arrow-callback': 'warn',
    'prefer-template': 'warn',
    
    // Node.js specific
    'handle-callback-err': 'warn',
    'no-process-exit': 'off', // CLI tools may need process.exit
  },
};