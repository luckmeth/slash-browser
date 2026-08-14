import { z } from 'zod'

/**
 * Our permission vocabulary.
 *
 * Deliberately *not* Electron's enum. Electron reports camera and microphone as
 * a single `media` permission disambiguated by a `mediaTypes` array, but users
 * think about "use my camera" and "use my microphone" as separate decisions and
 * expect to grant one without the other. So the manager splits `media` on the
 * way in and recombines on the way out.
 *
 * The honest limitation that follows: when a page asks for camera *and*
 * microphone in one call, Chromium gives us one callback for both. We cannot
 * grant only half — the prompt says so rather than implying finer control than
 * exists.
 */
export const PermissionKindSchema = z.enum([
  'camera',
  'microphone',
  'geolocation',
  'notifications',
  'clipboard-read',
  'display-capture',
  'midi',
  'fullscreen',
  'pointer-lock',
  'idle-detection',
  'window-management',
  'storage-access',
  'file-system',
  'open-external',
  'speaker-selection',
  'unknown'
])
export type PermissionKind = z.infer<typeof PermissionKindSchema>

export const PermissionPolicySchema = z.enum([
  /** This one request. Nothing stored. */
  'allow-once',
  /** While this tab is open. Dies with the tab; never written to disk. */
  'allow-for-tab',
  /** Until the browser quits. Never written to disk. */
  'allow-for-session',
  /** Until a wall-clock time. Persisted with an expiry. */
  'allow-until',
  'always-allow',
  /** Refuse this request. Nothing stored. */
  'block',
  'always-block'
])
export type PermissionPolicy = z.infer<typeof PermissionPolicySchema>

/** Policies that outlive the process and therefore go in the database. */
export const PERSISTED_POLICIES: readonly PermissionPolicy[] = [
  'allow-until',
  'always-allow',
  'always-block'
]

export const PermissionGrantSchema = z.object({
  id: z.number().int(),
  /** Session partition, so an isolated workspace's grants cannot leak. */
  partition: z.string(),
  origin: z.string(),
  kind: PermissionKindSchema,
  policy: PermissionPolicySchema,
  /** Epoch ms; null for grants with no expiry. */
  expiresAt: z.number().nullable(),
  /** Set only for allow-for-tab. */
  tabId: z.string().nullable(),
  createdAt: z.number()
})
export type PermissionGrant = z.infer<typeof PermissionGrantSchema>

export const PermissionEventSchema = z.object({
  id: z.number().int(),
  partition: z.string(),
  origin: z.string(),
  kind: PermissionKindSchema,
  action: z.enum(['requested', 'granted', 'denied', 'expired', 'revoked']),
  policy: PermissionPolicySchema.nullable(),
  at: z.number()
})
export type PermissionEvent = z.infer<typeof PermissionEventSchema>

/** A prompt awaiting the user's answer. */
export const PermissionRequestSchema = z.object({
  requestId: z.string(),
  origin: z.string(),
  /** Several kinds when a page asks for camera and microphone together. */
  kinds: z.array(PermissionKindSchema),
  tabId: z.string().nullable(),
  tabTitle: z.string()
})
export type PermissionRequest = z.infer<typeof PermissionRequestSchema>

/**
 * Plain-language copy for each permission.
 *
 * `consequence` describes *what access enables* — never what the site intends.
 * We cannot know a site's motive, and implying we do would be exactly the kind
 * of false confidence the product principles rule out.
 */
export const PERMISSION_COPY: Record<
  PermissionKind,
  { label: string; consequence: string; sensitive: boolean }
> = {
  camera: {
    label: 'Use your camera',
    consequence: 'The site can see and record whatever your camera points at, while you are on it.',
    sensitive: true
  },
  microphone: {
    label: 'Use your microphone',
    consequence: 'The site can hear and record audio around you, while you are on it.',
    sensitive: true
  },
  geolocation: {
    label: 'Know your location',
    consequence: 'The site can read your approximate position, often to within a street.',
    sensitive: true
  },
  notifications: {
    label: 'Send you notifications',
    consequence: 'The site can show system notifications, including when you are not looking at it.',
    sensitive: false
  },
  'clipboard-read': {
    label: 'Read your clipboard',
    consequence: 'The site can read whatever you last copied, which may include passwords.',
    sensitive: true
  },
  'display-capture': {
    label: 'Capture your screen',
    consequence:
      'The site can see a window or your whole screen, including anything else visible on it.',
    sensitive: true
  },
  midi: {
    label: 'Use MIDI devices',
    consequence: 'The site can send and receive messages from connected music hardware.',
    sensitive: false
  },
  fullscreen: {
    label: 'Go fullscreen',
    consequence: 'The site can fill your screen. Press Escape to leave at any time.',
    sensitive: false
  },
  'pointer-lock': {
    label: 'Capture your mouse pointer',
    consequence: 'The site can hide and take over your cursor. Press Escape to release it.',
    sensitive: false
  },
  'idle-detection': {
    label: 'Detect when you are inactive',
    consequence: 'The site can tell whether you have stopped using this device.',
    sensitive: true
  },
  'window-management': {
    label: 'Manage windows across your screens',
    consequence: 'The site can see how many displays you have and place windows on them.',
    sensitive: false
  },
  'storage-access': {
    label: 'Use its cookies inside this site',
    consequence:
      'An embedded third party can use its own cookies here, which lets it recognise you across sites.',
    sensitive: true
  },
  'file-system': {
    label: 'Read or change files you choose',
    consequence: 'The site can open and save the files and folders you explicitly pick.',
    sensitive: true
  },
  'open-external': {
    label: 'Open another application',
    consequence: 'The site can ask Windows to launch another program.',
    sensitive: true
  },
  'speaker-selection': {
    label: 'Choose an audio output',
    consequence: 'The site can pick which speakers or headphones it plays through.',
    sensitive: false
  },
  unknown: {
    label: 'Use an unrecognised capability',
    consequence:
      'This browser does not recognise what is being requested, so it cannot explain the effect. Denying is the safe answer.',
    sensitive: true
  }
}

export const POLICY_COPY: Record<PermissionPolicy, string> = {
  'allow-once': 'This time only',
  'allow-for-tab': 'While this tab is open',
  'allow-for-session': 'Until I quit the browser',
  'allow-until': 'For one hour',
  'always-allow': 'Always on this site',
  block: 'Not now',
  'always-block': 'Never on this site'
}

/** Default expiry offered by the "for one hour" choice. */
export const ALLOW_UNTIL_DEFAULT_MS = 60 * 60 * 1000
