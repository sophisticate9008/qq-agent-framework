import { readdir, readFile } from 'node:fs/promises'

/** Vite's lazy page chunks are part of the built application contract. */
export async function readBuiltBrowserApplication(): Promise<string> {
  const directory = new URL('../dist/admin-web/', import.meta.url)
  const files = (await readdir(directory)).filter(name => name.endsWith('.js'))
  if (!files.includes('app.js')) throw new Error('Built UI is missing; build the browser application first.')
  return (await Promise.all(files.map(name => readFile(new URL(name, directory), 'utf8')))).join('\n')
}
