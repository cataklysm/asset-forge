// ESLint holds the mechanical part of docs/code-style.md. Only sources are checked: tests, build output and
// migrations are left out, as the clean-up left them out.
//
// The repository uses TypeScript 7, which ships no JavaScript compiler API, so typescript-eslint's parser
// (which needs `typescript` < 6.1) cannot run. The TypeScript and TSX sources are parsed by Babel's own
// TypeScript grammar through @babel/eslint-parser instead. Nothing here needs type information.
import babelParser from '@babel/eslint-parser';
import { builtinRules } from 'eslint/use-at-your-own-risk';
import jsdoc from 'eslint-plugin-jsdoc';
import reactHooks from 'eslint-plugin-react-hooks';

const SOURCES = ['apps/desktop/src/**/*.{ts,tsx}', 'packages/*/src/**/*.ts', 'docker/mock-provider/**/*.{mjs,mts}'];
const RENDERER = ['apps/desktop/src/renderer/**/*.{ts,tsx}'];

/** Local names the style document asks to write out. `i`, `x`, `y` and `_` stay. */
const ABBREVIATED_NAMES = [
  's',
  'r',
  'req',
  'res',
  'o',
  'opts',
  'ctx',
  'deps',
  'rc',
  'e',
  'err',
  'cb',
  'fn',
  'tx',
  'idx',
  'tmp',
  'val',
  'msg',
  'cfg',
  'args',
];

/** Suffixes of abbreviated type names, such as `JobHostDeps` for `JobHostDependencies`. */
const ABBREVIATED_TYPE_SUFFIX = '/[a-z](Deps|Opts|Ctx)$/';

const TYPE_NAME_SELECTORS = [
  'TSInterfaceDeclaration',
  'TSTypeAliasDeclaration',
  'TSEnumDeclaration',
  'ClassDeclaration',
].map((type) => ({
  selector: `${type} > Identifier.id[name=${ABBREVIATED_TYPE_SUFFIX}]`,
  message: 'Write the type name out (Dependencies, Options, Context).',
}));

/**
 * Reports every declared binding (variable, parameter, function, class, import, catch parameter) whose name is
 * in the list. It works on the scope, so property names, object keys and member writes, which may be stored or
 * boundary names, are never checked.
 */
const noAbbreviatedNames = {
  meta: {
    type: 'suggestion',
    schema: [{ type: 'array', items: { type: 'string' } }],
    messages: { abbreviated: "Write the name '{{name}}' out (see docs/code-style.md, Names)." },
  },
  create(context) {
    const names = new Set(context.options[0] ?? []);
    return {
      'Program:exit'() {
        for (const scope of context.sourceCode.scopeManager.scopes) {
          for (const variable of scope.variables) {
            if (!names.has(variable.name)) continue;
            for (const identifier of variable.identifiers) {
              context.report({ node: identifier, messageId: 'abbreviated', data: { name: variable.name } });
            }
          }
        }
      },
    };
  },
};

const restrictedSyntax = builtinRules.get('no-restricted-syntax');

const local = {
  rules: {
    'no-abbreviated-names': noAbbreviatedNames,
    // The core rule under separate names, so each check has its own severity and count.
    'no-abbreviated-type-names': restrictedSyntax,
    'no-nested-async': restrictedSyntax,
  },
};

/**
 * Babel parser options for one kind of file. Without a Babel config file the parser hands `parserOpts.plugins`
 * straight to @babel/parser, so no Babel plugin package is needed.
 *
 * @param plugins the @babel/parser plugins, such as `typescript` and `jsx`
 * @returns the language options for a config object
 */
function babelLanguage(plugins) {
  return {
    parser: babelParser,
    parserOptions: {
      requireConfigFile: false,
      babelOptions: { babelrc: false, configFile: false, parserOpts: { plugins } },
    },
  };
}

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/out/**',
      '**/dist/**',
      '**/test/**',
      '**/*.test.{ts,tsx,js,mjs}',
      'packages/persistence/migrations/**',
    ],
  },
  { files: ['**/*.ts', '**/*.mts'], languageOptions: babelLanguage(['typescript']) },
  { files: ['**/*.d.ts', '**/*.d.mts'], languageOptions: babelLanguage([['typescript', { dts: true }]]) },
  { files: ['**/*.tsx'], languageOptions: babelLanguage(['typescript', 'jsx']) },
  {
    files: SOURCES,
    plugins: { local, jsdoc },
    settings: { jsdoc: { mode: 'typescript' } },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    // A rule the sources pass completely is an error, so it stays passed; the others warn until the code is there.
    rules: {
      // Names
      'local/no-abbreviated-names': ['error', ABBREVIATED_NAMES],
      'local/no-abbreviated-type-names': ['error', ...TYPE_NAME_SELECTORS],
      'id-length': ['error', { min: 2, exceptions: ['i', 'x', 'y', '_'], properties: 'never' }],

      // Doc comments
      'jsdoc/require-jsdoc': [
        'warn',
        {
          publicOnly: false,
          require: {
            FunctionDeclaration: true,
            ClassDeclaration: true,
            MethodDefinition: true,
            ArrowFunctionExpression: false,
            FunctionExpression: false,
          },
          contexts: [
            'TSInterfaceDeclaration',
            'TSTypeAliasDeclaration',
            'ExportNamedDeclaration > VariableDeclaration',
            'Program > VariableDeclaration > VariableDeclarator > ArrowFunctionExpression',
          ],
        },
      ],
      'jsdoc/require-param': ['warn', { checkDestructured: false }],
      'jsdoc/require-returns': 'warn',
      'jsdoc/check-param-names': ['error', { checkDestructured: false }],
      'jsdoc/no-types': 'error',

      // Promise-returning functions
      'local/no-nested-async': [
        'warn',
        {
          // An async arrow without a block body only hands its arguments on, which the style allows.
          selector:
            ':function :matches(FunctionDeclaration, FunctionExpression, ArrowFunctionExpression[body.type="BlockStatement"])[async=true]',
          message: 'Move this async function to module level (see docs/code-style.md, Functions).',
        },
      ],

      // Guides
      'max-lines-per-function': ['warn', { max: 40, skipBlankLines: true, skipComments: true }],
      'max-lines': ['warn', { max: 300, skipBlankLines: true, skipComments: true }],
      'max-depth': ['error', 4],
      'no-nested-ternary': 'warn',
    },
  },
  {
    files: RENDERER,
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
];
