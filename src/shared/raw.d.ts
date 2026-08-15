/**
 * `?raw` imports.
 *
 * Vite inlines the file's source as a string at build time. Used to inject
 * Readability into a page on demand rather than shipping it in the content
 * preload, which runs in every page the user visits.
 */
declare module '*?raw' {
  const content: string
  export default content
}
