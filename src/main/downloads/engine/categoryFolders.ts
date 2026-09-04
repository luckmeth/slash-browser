import { join } from 'node:path'
import type { DownloadCategory } from '@shared/types/downloadEngine'

/**
 * Where each kind of file goes when sorting is on.
 *
 * Names chosen to match what Windows already calls these folders, so a download
 * lands where the user's other files of that kind already are rather than in a
 * parallel set of folders only this browser knows about.
 */
export const CATEGORY_FOLDERS: Record<DownloadCategory, string> = {
  video: 'Video',
  audio: 'Music',
  image: 'Images',
  document: 'Documents',
  archive: 'Archives',
  software: 'Programs',
  other: 'Other'
}

/**
 * The folder a download of this category belongs in.
 *
 * Off by default and returns `base` unchanged when off, because sorting is a
 * preference with a real cost: files stop being where the browser put the last
 * one, and somebody who has not asked for it will go looking in Downloads and
 * find nothing.
 *
 * `other` is deliberately **not** given a folder even when sorting is on.
 * A category that means "we could not tell" should not create a folder called
 * Other that slowly collects everything unrecognised; those files stay at the
 * top level where they are visible.
 */
export function folderForCategory(
  base: string,
  category: DownloadCategory,
  sortByCategory: boolean
): string {
  if (!sortByCategory) return base
  if (category === 'other') return base
  return join(base, CATEGORY_FOLDERS[category])
}
