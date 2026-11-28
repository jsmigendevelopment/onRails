// `pnpm new:route <path> <module>`: a page at /<path> that renders a view of <module>.
// Example: `pnpm new:route settings/profile accounts` → src/routes/settings/profile.tsx and, when
// it doesn't exist yet, src/modules/accounts/ui/views/profile-view.tsx.
import { kebab, positional, report, requireModule, tidy, writeAll } from './lib.ts'
import { addToE2eRoutes, pageFiles } from './page.ts'
import { refreshRouteTree } from './routes.ts'

const [path, mod] = positional(process.argv.slice(2))
if (!path || !mod) {
  console.error('Usage: pnpm new:route <path> <module>   e.g. pnpm new:route settings/profile accounts')
  process.exit(1)
}
requireModule(kebab(mod, 'The module'))
const written = writeAll(pageFiles(path, mod))
await refreshRouteTree()
const routes = addToE2eRoutes(path)
tidy([...written, routes])
report(
  [...written, routes, 'src/routeTree.gen.ts'],
  [
    'Put the page’s sections in the view (pnpm new:section).',
    'Make its screenshots: pnpm test:visual --update, then look at each new PNG.',
  ],
)
