import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    // `portal/` is a separate Node application with its own package.json and
    // its own dependency tree — nothing there is bundled into the browser. It
    // runs on Node globals (`process`, `console`, `Buffer`) this config does
    // not define, so linting it here reports six errors about code that is
    // perfectly correct for where it runs.
    // portal/ and platform/ are separate Node and Next applications with their
    // own toolchains. Linting them with the browser's config reports thousands
    // of failures about globals and JSX settings that do not apply to them.
    ignores: ['out/**', 'release/**', 'node_modules/**', 'dist/**', 'portal/**', 'platform/**']
  },
  {
    // Build-time scripts. They run on plain Node — `process`, `console` and
    // `Buffer` are exactly what they are for — and never reach the application
    // bundle, so the browser config's assumption that Node globals are absent
    // does not hold here.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', Buffer: 'readonly' }
    }
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      // The IPC boundary is the security spine: `any` there defeats the zod
      // contracts entirely, so it is an error rather than a warning.
      '@typescript-eslint/no-explicit-any': 'error'
    }
  },
  {
    // Preload scripts run sandboxed. Nothing here may reach for Node builtins.
    files: ['src/preload/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['node:*', 'fs', 'path', 'child_process'], message: 'Preload scripts are sandboxed — Node builtins are unavailable at runtime.' }
          ]
        }
      ]
    }
  }
)
