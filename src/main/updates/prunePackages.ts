/**
 * Which downloaded update packages can go.
 *
 * Every update fetched was kept for ever. Each is about 168 MB, and six
 * updates in one evening left 673 MB of installers in `userData` that nothing
 * would ever read again -- measured, not estimated. An installer that has been
 * run has no further use: the version it installs is now the running one, and
 * a re-download is a checksum-verified fetch away.
 *
 * Pure so the rule is testable without a filesystem, because the failure mode
 * of getting it wrong is deleting the package the browser is about to install.
 * Hence `keep`: the one file the caller still needs, matched exactly.
 *
 * Only files this feature creates are considered. Anything unrecognised in the
 * folder is left alone rather than swept up -- a cleanup routine that deletes
 * things it does not understand is a cleanup routine nobody should ship.
 */
export function packagesToRemove(files: readonly string[], keep: string | null): string[] {
  return files.filter((name) => {
    if (name === keep) return false
    // Slash-<version>-<arch>.exe, and the partial files a failed fetch leaves.
    return /^Slash-.*\.exe$/i.test(name)
  })
}
