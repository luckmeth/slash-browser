import { z } from 'zod'

/**
 * A saved sign-in, **as the interface is allowed to see it**.
 *
 * There is deliberately no password field on this type. The renderer lists,
 * counts and deletes saved logins without ever receiving one — the secret goes
 * from the vault into the page through Chromium's input pipeline and never
 * through an IPC reply. Making that a property of the *type* means a future
 * handler cannot leak one by accident: there is nowhere to put it.
 */
export const SavedLoginSchema = z.object({
  id: z.number().int(),
  host: z.string(),
  username: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  lastUsedAt: z.number().nullable()
})
export type SavedLogin = z.infer<typeof SavedLoginSchema>

/** What the vault can do on this machine, and why not if it cannot. */
export const VaultStatusSchema = z.object({
  /**
   * Whether the OS has a usable secure store.
   *
   * False means Slash will refuse to save anything — it does not fall back to
   * writing readable passwords beside the browsing history.
   */
  available: z.boolean(),
  count: z.number().int(),
  logins: z.array(SavedLoginSchema)
})
export type VaultStatus = z.infer<typeof VaultStatusSchema>

/**
 * What a page's login form looks like, reported by the content preload.
 *
 * Booleans only — no values, and not even selectors. The preload keeps its own
 * references to the fields it found, so "focus the password field" needs no
 * description of the page to cross the boundary in either direction. The
 * preload's charter is to observe structure, never to read what has been typed
 * into it.
 */
export const LoginFormSchema = z.object({
  hasPasswordField: z.boolean(),
  hasUsernameField: z.boolean()
})
export type LoginForm = z.infer<typeof LoginFormSchema>
