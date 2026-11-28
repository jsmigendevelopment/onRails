// Shared parts of the generators (`pnpm new:*`): names, templates, safe writes and the follow-up
// steps (format, lint fixes, route tree, migration). Templates live in templates/ as .tpl files.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

export const TEMPLATES = join(import.meta.dirname, 'templates')
const KEBAB = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

/** Stops the generator with a message for the person, and nothing written. */
export function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

export function kebab(value: string | undefined, what: string): string {
  if (!value || !KEBAB.test(value))
    fail(`${what} must be kebab-case, like "todo-items" (got "${value ?? ''}").`)
  return value
}

const words = (k: string) => k.split('-')
const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1)
export const pascal = (k: string) => words(k).map(cap).join('')
export const camel = (k: string) => {
  const p = pascal(k)
  return p.charAt(0).toLowerCase() + p.slice(1)
}
export const snake = (k: string) => words(k).join('_')
export const human = (k: string) => words(k).join(' ')

/** `todo-items` → `todo-item`. Pass `--item <singular>` when English disagrees. */
export function singular(plural: string): string {
  if (plural.endsWith('ies')) return `${plural.slice(0, -3)}y`
  if (/(ss|x|ch|sh)es$/.test(plural)) return plural.slice(0, -2)
  if (plural.endsWith('s') && !plural.endsWith('ss')) return plural.slice(0, -1)
  return fail(
    `Can't tell the singular of "${plural}". Name the module in the plural, or pass --item <singular>.`,
  )
}

/** `--dry`: every step below plans instead of acting; `report()` prints the plan. */
export const DRY = process.argv.includes('--dry')
const plan = { create: [] as string[], edit: [] as string[], run: [] as string[] }

/** Notes a file an existing step would edit (under `--dry`, nothing is written). */
export function planEdit(path: string) {
  if (!plan.edit.includes(path)) plan.edit.push(path)
}

/** `--flag value` from the command line. */
export function option(args: string[], flag: string): string | undefined {
  const at = args.indexOf(flag)
  return at === -1 ? undefined : args[at + 1]
}

// Flags that take the next word as their value. Every other `--flag` stands alone, so
// `--dry tasks` and `tasks --dry` both leave `tasks` as the word.
const VALUE_FLAGS = new Set(['--item'])

export function positional(args: string[]): string[] {
  return args.filter((a, i) => !a.startsWith('--') && !VALUE_FLAGS.has(args[i - 1] ?? ''))
}

export type Tokens = Record<string, string>

export function render(text: string, tokens: Tokens): string {
  let out = text
  for (const [token, value] of Object.entries(tokens)) out = out.replaceAll(token, value)
  return out
}

export const template = (path: string) => readFileSync(join(TEMPLATES, path), 'utf8')

/** Every file under a template folder, as [path inside it, text]. */
export function templateTree(folder: string): [string, string][] {
  const root = join(TEMPLATES, folder)
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name)
      return statSync(path).isDirectory() ? walk(path) : [path]
    })
  return walk(root).map((path) => [relative(root, path).replace(/\.tpl$/, ''), readFileSync(path, 'utf8')])
}

/** The module's tokens: names in every case the templates use. */
export function moduleTokens(mod: string, item = singular(mod)): Tokens {
  return {
    __mod__: mod,
    __one__: item,
    __Plural__: pascal(mod),
    __plural__: camel(mod),
    __Single__: pascal(item),
    __single__: camel(item),
    __table__: snake(mod),
    __Words__: cap(human(mod)),
    __words__: human(mod),
    __word__: human(item),
  }
}

/** sqlite (D1, the default) or postgresql (the database-supabase add-on), from drizzle.config.ts. */
export function dialect(): 'sqlite' | 'postgresql' {
  return /dialect:\s*['"]postgresql['"]/.test(readFileSync('drizzle.config.ts', 'utf8'))
    ? 'postgresql'
    : 'sqlite'
}

/** The table template's dialect parts: the import, the table function and epoch-ms time columns. */
export function tableTokens(withIndex: boolean): Tokens {
  const pg = dialect() === 'postgresql'
  const names = pg ? ['bigint', 'pgTable', 'text'] : ['integer', 'sqliteTable', 'text']
  if (withIndex) names.unshift('index')
  return {
    __TABLE_IMPORT__: `import { ${names.sort().join(', ')} } from 'drizzle-orm/${pg ? 'pg' : 'sqlite'}-core'`,
    __TABLE_FN__: pg ? 'pgTable' : 'sqliteTable',
    __TIME__: pg ? 'bigint' : 'integer',
    __TIME_MODE__: pg ? ", { mode: 'number' }" : '',
    // Supabase's Data API exposes the public schema: RLS with no policies keeps it closed.
    __RLS__: pg ? '.enableRLS()' : '',
  }
}

/** Writes every file, or none: refuses if any already exists. Returns the paths. */
export function writeAll(files: [string, string][]): string[] {
  const taken = files.filter(([path]) => existsSync(path)).map(([path]) => path)
  if (taken.length) fail(`Already there, nothing written:\n  ${taken.join('\n  ')}`)
  if (DRY) {
    plan.create.push(...files.map(([path]) => path))
    return files.map(([path]) => path)
  }
  for (const [path, text] of files) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
  }
  return files.map(([path]) => path)
}

/** Edits one file in place; fails loudly when the anchor isn't there. */
export function edit(path: string, change: (text: string) => string) {
  const before = readFileSync(path, 'utf8')
  const after = change(before)
  if (after === before) fail(`Could not update ${path}: its shape changed. Add the lines by hand.`)
  if (DRY) {
    planEdit(path)
    return
  }
  writeFileSync(path, after)
}

const pnpm = (args: string[]) =>
  execFileSync('pnpm', args, { stdio: 'inherit', shell: process.platform === 'win32' })

/** Formats the new files and applies lint's own fixes (import order), so `pnpm check` passes. */
export function tidy(paths: string[]) {
  if (DRY) {
    plan.run.push(`eslint --fix and prettier --write on ${paths.length} file(s)`)
    return
  }
  const code = paths.filter((p) => /\.(ts|tsx)$/.test(p))
  if (code.length) pnpm(['exec', 'eslint', '--fix', ...code])
  pnpm(['exec', 'prettier', '--write', '--log-level=warn', ...paths])
}

/** Writes the SQL migration for changed tables (drizzle-kit), named after what was added. */
export function migrate(name: string) {
  if (DRY) {
    plan.run.push(`drizzle-kit generate --name ${name} (adds a SQL file to migrations/)`)
    return
  }
  pnpm(['exec', 'drizzle-kit', 'generate', '--name', name])
}

export const MODULES = 'src/modules'
export const moduleDir = (mod: string) => join(MODULES, mod)

export function requireModule(mod: string): string {
  const dir = moduleDir(mod)
  if (!existsSync(dir))
    fail(`There is no module "${mod}" in ${MODULES}. Make it first: pnpm new:module ${mod}`)
  return dir
}

/** Prints what was made and what to do next, or under `--dry` what would be. */
export function report(paths: string[], next: string[]) {
  if (DRY) return reportPlan()
  console.log(`\nCreated or changed:\n  ${paths.join('\n  ')}`)
  if (next.length) console.log(`\nNext:\n  ${next.join('\n  ')}`)
}

function reportPlan() {
  const list = (heading: string, items: string[]) =>
    items.length ? `\n${heading}:\n  ${items.join('\n  ')}\n` : ''
  console.log(
    `Dry run: nothing was written.\n${list('Would create', plan.create)}${list('Would edit', plan.edit)}${list('Would run', plan.run)}` +
      '\nRun it again without --dry to make these.',
  )
}
