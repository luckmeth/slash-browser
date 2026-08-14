import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['out/**', 'release/**', 'node_modules/**', 'dist/**'] },
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
