import type { z } from 'zod'
import { type Result, ok, err } from '@shared/result'

/**
 * Parses an untrusted value against a zod schema, returning a Result rather than
 * throwing. Zod's own error text can echo the offending input back, so only a
 * compact path/code summary crosses the IPC boundary — never the raw value.
 */
export function parseWith<S extends z.ZodType>(
  schema: S,
  value: unknown,
  what: string
): Result<z.infer<S>> {
  const parsed = schema.safeParse(value)
  if (parsed.success) return ok(parsed.data)

  const summary = parsed.error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.') || '<root>'}: ${i.code}`)
    .join('; ')

  return err('VALIDATION', `Invalid ${what}`, summary)
}
