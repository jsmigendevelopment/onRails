// `pnpm new:module <name> [--item <singular>] [--no-route]`: a whole feature module in the shape
// docs/architecture.md describes, wired into the composition root, with its table, migration,
// page and tests. Example: `pnpm new:module tasks` → src/modules/tasks, /tasks, tasks_* migration.
//
//   ui/views       the page's static layout          ui/sections  Suspense > error boundary > content
//   ui/components  presentational pieces              hooks        query options and mutations
//   server/        functions → controller → service → repository port (+ drizzle adapter, memory fake)
//   schemas.ts, types.ts, copy.ts, and tests for the service, controller, repository, section, components
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import {
  edit,
  fail,
  kebab,
  migrate,
  moduleDir,
  moduleTokens,
  option,
  positional,
  render,
  report,
  snake,
  tableTokens,
  templateTree,
  tidy,
  writeAll,
} from './lib.ts'
import { addToE2eRoutes, pageFiles } from './page.ts'
import { refreshRouteTree } from './routes.ts'

const COMPOSITION = 'src/server/composition.ts'
const args = process.argv.slice(2)
const [name] = positional(args)
const mod = kebab(name, 'The module name')
const dir = moduleDir(mod)
if (existsSync(dir)) fail(`${dir} already exists. Add to it with new:section, new:component or new:table.`)

const tokens = moduleTokens(mod, option(args, '--item') ? kebab(option(args, '--item'), '--item') : undefined)
const dbTokens = repositoryTestTokens(tokens)
const files = templateTree('module').map(([path, text]): [string, string] => [
  join(dir, render(path, tokens)),
  render(render(text, { ...tableTokens(true), ...dbTokens }), tokens),
])
const withRoute = !args.includes('--no-route')
if (withRoute) files.push(...pageFiles(mod, mod).filter(([path]) => !files.some(([taken]) => taken === path)))

const written = writeAll(files)
wireComposition()
const changed = [...written, COMPOSITION]
if (withRoute) {
  await refreshRouteTree()
  changed.push(addToE2eRoutes(mod))
}
tidy(changed)
migrate(snake(mod))
report(
  [...changed, 'migrations/', ...(withRoute ? ['src/routeTree.gen.ts'] : [])],
  [
    'pnpm check',
    ...(withRoute
      ? ['Make the new page’s screenshots: pnpm test:visual --update, and look at each PNG.']
      : []),
    'Then shape the generated feature to the issue: fields, rules and copy.',
  ],
)

/** The composition root gets one factory: the database adapter, the clock and the id maker. */
function wireComposition() {
  const P = tokens.__Plural__
  const p = tokens.__plural__
  edit(COMPOSITION, (text) => {
    const binding = /createDb\((env\.\w+)\)/.exec(text)?.[1] ?? 'env.DB'
    const imports =
      `import { ${p}Controller } from '@/modules/${mod}/server/${mod}.controller'\n` +
      `import { drizzle${P}Repository } from '@/modules/${mod}/server/${mod}.repository.drizzle'\n` +
      `import { create${P}Service } from '@/modules/${mod}/server/${mod}.service'\n`
    const factory = `
/** The ${tokens.__words__} module's controller, over the database. */
export function ${p}Api() {
  const repo = drizzle${P}Repository(createDb(${binding}))
  const service = create${P}Service({ repo, now: Date.now, newId: () => crypto.randomUUID() })
  return ${p}Controller(service)
}
`
    const firstLocal = text.search(/^import .* from '\.\//m)
    if (firstLocal === -1) return text
    return `${text.slice(0, firstLocal)}${imports}${text.slice(firstLocal).trimEnd()}\n${factory}`
  })
}

/** The repository contract runs against the real database: local D1, or PGlite for Postgres. */
function repositoryTestTokens(t: Record<string, string>) {
  const P = t.__Plural__ ?? ''
  const table = t.__table__ ?? ''
  const apply = (run: string) =>
    `  for (const file of readdirSync('migrations').filter((f) => f.endsWith('.sql')).sort())\n` +
    `    for (const statement of readFileSync(\`migrations/\${file}\`, 'utf8').split('--> statement-breakpoint'))\n` +
    `      if (statement.trim()) await ${run}\n`
  const pg = tableTokens(false).__TABLE_FN__ === 'pgTable'
  return pg
    ? {
        __VITEST__: 'afterAll, beforeAll, describe, expect, it',
        __DB_IMPORTS__:
          "import { readdirSync, readFileSync } from 'node:fs'\nimport { PGlite } from '@electric-sql/pglite'\n" +
          "import { drizzle } from 'drizzle-orm/pglite'\n" +
          `import { drizzle${P}Repository } from './${t.__mod__}.repository.drizzle'\n`,
        __DB_CONTRACT__:
          '\n// The real thing: Postgres (PGlite, in process) with the real migration files applied.\nlet pg: PGlite\n' +
          `beforeAll(async () => {\n  pg = new PGlite()\n${apply('pg.exec(statement)')}}, 30_000)\n` +
          `afterAll(() => pg?.close())\n\ncontract('postgres', async () => {\n  await pg.exec('DELETE FROM ${table}')\n` +
          `  return drizzle${P}Repository(drizzle({ client: pg }))\n})\n`,
      }
    : {
        __VITEST__: 'afterAll, beforeAll, describe, expect, it',
        __DB_IMPORTS__:
          "import { readdirSync, readFileSync } from 'node:fs'\nimport { getPlatformProxy } from 'wrangler'\n" +
          "import { createDb } from '@/db/client'\n" +
          `import { drizzle${P}Repository } from './${t.__mod__}.repository.drizzle'\n`,
        __DB_CONTRACT__:
          '\n// The real thing: local D1 (workerd, through wrangler) with the real migration files applied.\n' +
          'let proxy: Awaited<ReturnType<typeof getPlatformProxy<Env>>>\n' +
          `beforeAll(async () => {\n  proxy = await getPlatformProxy<Env>({ persist: false })\n${apply('proxy.env.DB.prepare(statement).run()')}}, 30_000)\n` +
          `afterAll(() => proxy?.dispose())\n\ncontract('d1', async () => {\n  await proxy.env.DB.prepare('DELETE FROM ${table}').run()\n` +
          `  return drizzle${P}Repository(createDb(proxy.env.DB))\n})\n`,
      }
}
