// `pnpm routes:generate`: rewrites src/routeTree.gen.ts from src/routes, the same way `pnpm dev`
// and `pnpm build` do, so `pnpm typecheck` sees a new route at once. The generators call it.
import { readFileSync } from 'node:fs'

import { Generator, getConfig } from '@tanstack/router-generator'

import { DRY, planEdit } from './lib.ts'

const TREE = './src/routeTree.gen.ts'

/** The block Start's Vite plugin appends (its Register types), kept as it is in the file. */
function startFooter(): string[] {
  const text = readFileSync(TREE, 'utf8')
  const end = text.indexOf('._addFileTypes<FileRouteTypes>()')
  return end === -1 ? [] : [text.slice(text.indexOf('\n', end) + 1).trim()]
}

/** Regenerates the route tree. Exported for the other generators. */
export async function generateRoutes(root = process.cwd()) {
  const config = getConfig(
    {
      target: 'react',
      routesDirectory: './src/routes',
      generatedRouteTree: TREE,
      routeTreeFileFooter: startFooter(),
      disableLogging: true,
    },
    root,
  )
  await new Generator({ config, root }).run()
}

/** The generators' step: regenerate the route tree, or under `--dry` note that it would change. */
export async function refreshRouteTree() {
  if (DRY) planEdit(TREE.replace(/^\.\//, ''))
  else await generateRoutes()
}

if (process.argv[1]?.endsWith('routes.ts')) await generateRoutes()
