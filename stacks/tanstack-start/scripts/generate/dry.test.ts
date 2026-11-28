// `--dry` on every `pnpm new:*` generator (#710): it prints the plan and writes nothing. Each
// generator runs in a scratch copy of the app's files, with a fake `pnpm` on PATH that only logs
// its arguments, so ESLint, Prettier and drizzle-kit can never run (or be missed) here.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { positional } from './lib.ts'

const PACK = join(import.meta.dirname, '../..')
const MOD = 'dry-widgets'
let root = ''
let counter = 0

/** Every directory and file under a folder, files with a hash of their bytes. */
function snapshot(dir: string): string[] {
  const walk = (folder: string): string[] =>
    readdirSync(folder).flatMap((name) => {
      const path = join(folder, name)
      const rel = relative(dir, path)
      if (statSync(path).isDirectory()) return [`dir ${rel}`, ...walk(path)]
      return [`file ${rel} ${createHash('sha256').update(readFileSync(path)).digest('hex')}`]
    })
  return walk(dir).sort()
}

type Run = { status: number | null; stdout: string; stderr: string; pnpmCalls: string }

/** Runs one generator script of the pack with the scratch folder as the app's root. */
function generate(cwd: string, script: string, args: string[]): Run {
  const log = join(root, `pnpm-${counter++}.log`)
  const r = spawnSync(process.execPath, [join(PACK, 'scripts/generate', script), ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH ?? ''}`, PNPM_LOG: log },
  })
  const pnpmCalls = existsSync(log) ? readFileSync(log, 'utf8') : ''
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, pnpmCalls }
}

/** A new scratch app: the files the generators touch, and optionally a generated module. */
function scratch(withModule: boolean): string {
  const dir = join(root, `app-${counter++}`)
  cpSync(withModule ? join(root, 'base-with-module') : join(root, 'base'), dir, { recursive: true })
  return dir
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'generate-dry-'))
  mkdirSync(join(root, 'bin'))
  const fake = join(root, 'bin/pnpm')
  writeFileSync(fake, '#!/bin/sh\necho "$@" >> "$PNPM_LOG"\n')
  chmodSync(fake, 0o755)
  // Only the files the generators read and edit, so the app's own modules and routes (which a
  // person renames or deletes) never matter. Made-up `dry-` names can't be taken by an app.
  const base = join(root, 'base')
  for (const file of [
    'src/routes/__root.tsx',
    'src/routes/index.tsx',
    'src/routeTree.gen.ts',
    'src/server/composition.ts',
    'e2e/helpers.ts',
    'drizzle.config.ts',
  ]) {
    mkdirSync(dirname(join(base, file)), { recursive: true })
    cpSync(join(PACK, file), join(base, file))
  }
  cpSync(base, join(root, 'base-with-module'), { recursive: true })
  const withModule = join(root, 'base-with-module')
  const made = generate(withModule, 'new-module.ts', [MOD])
  if (made.status !== 0) throw new Error(`Could not make the scratch module: ${made.stderr}`)
  mkdirSync(join(withModule, 'src/modules/bare/hooks'), { recursive: true })
  writeFileSync(join(withModule, 'src/modules/bare/hooks/use-bare.ts'), '')
}, 60_000)

afterAll(() => {
  if (root.startsWith(tmpdir())) rmSync(root, { recursive: true, force: true })
})

const section = (out: string, heading: string) => {
  const lines = out.split('\n')
  const at = lines.indexOf(`${heading}:`)
  if (at === -1) return []
  const rest = lines.slice(at + 1)
  const end = rest.findIndex((l) => !l.startsWith('  '))
  return (end === -1 ? rest : rest.slice(0, end)).map((l) => l.trim()).sort()
}

const GENERATORS = [
  { name: 'new:module', script: 'new-module.ts', args: [MOD], withModule: false },
  {
    name: 'new:module --no-route',
    script: 'new-module.ts',
    args: [MOD, '--no-route'],
    withModule: false,
  },
  { name: 'new:route', script: 'new-route.ts', args: ['dry-reports/weekly', MOD], withModule: true },
  { name: 'new:section', script: 'new-section.ts', args: [MOD, 'overdue'], withModule: true },
  { name: 'new:component', script: 'new-component.ts', args: [MOD, 'dry-badge'], withModule: true },
  { name: 'new:table', script: 'new-table.ts', args: [MOD, 'dry-labels'], withModule: true },
]

/** What a real run created and changed, from the tree before and after. */
function realChanges(before: string[], after: string[]) {
  const files = (s: string[]) =>
    new Map(s.filter((l) => l.startsWith('file ')).map((l) => [l.split(' ')[1], l]))
  const was = files(before)
  const now = files(after)
  const created = [...now.keys()].filter((p) => !was.has(p ?? ''))
  const edited = [...now.keys()].filter((p) => was.has(p ?? '') && was.get(p ?? '') !== now.get(p ?? ''))
  return { created: created.sort(), edited: edited.sort() }
}

describe.each(GENERATORS)('$name --dry', ({ script, args, withModule }) => {
  it('AC-710-1 AC-710-2: writes nothing, runs no tool, and lists what it would create and edit', () => {
    const dry = scratch(withModule)
    const before = snapshot(dry)
    const run = generate(dry, script, [...args, '--dry'])
    expect(run.stderr).toBe('')
    expect(run.status).toBe(0)
    expect(snapshot(dry)).toEqual(before)
    expect(run.pnpmCalls).toBe('')
    expect(section(run.stdout, 'Would create').length).toBeGreaterThan(0)
  })

  it('AC-710-1 AC-710-2: the plan is what a real run then creates and edits', () => {
    const dry = scratch(withModule)
    const planned = generate(dry, script, [...args, '--dry'])
    const real = scratch(withModule)
    const before = snapshot(real)
    const run = generate(real, script, args)
    expect(run.status).toBe(0)
    const { created, edited } = realChanges(before, snapshot(real))
    expect(section(planned.stdout, 'Would create').filter((p) => !p.endsWith('/'))).toEqual(created)
    expect(section(planned.stdout, 'Would edit')).toEqual(edited)
    // Without --dry the tools run, as before.
    expect(run.pnpmCalls).toMatch(/prettier/)
  })
})

describe('--dry refuses with the same message (AC-710-3)', () => {
  const REFUSALS: { why: string; script: string; args: string[]; says: RegExp }[] = [
    { why: 'a bad name', script: 'new-module.ts', args: ['Bad_Name'], says: /must be kebab-case/ },
    {
      why: 'a bad component name',
      script: 'new-component.ts',
      args: [MOD, 'Task Badge'],
      says: /kebab-case/,
    },
    {
      why: 'a missing module',
      script: 'new-section.ts',
      args: ['nope', 'overdue'],
      says: /no module "nope"/,
    },
    {
      why: 'a missing module for a route',
      script: 'new-route.ts',
      args: ['reports', 'nope'],
      says: /no module/,
    },
    { why: 'a module that exists', script: 'new-module.ts', args: [MOD], says: /already exists/ },
    {
      why: 'a component that exists',
      script: 'new-component.ts',
      args: [MOD, 'dry-widget-item'],
      says: /Already there/,
    },
    { why: 'a table that exists', script: 'new-table.ts', args: [MOD, MOD], says: /Already there/ },
    {
      why: 'a route that exists',
      script: 'new-route.ts',
      args: ['index', MOD],
      says: /index\.tsx already exists/,
    },
    {
      why: 'a section with no list query',
      script: 'new-section.ts',
      args: ['bare', 'overdue'],
      says: /no bareQueries\.list/,
    },
    { why: 'no arguments', script: 'new-table.ts', args: [], says: /Usage: pnpm new:table/ },
  ]

  it.each(REFUSALS)('$why', ({ script, args, says }) => {
    const plain = generate(scratch(true), script, args)
    expect(plain.status).toBe(1)
    expect(plain.stderr).toMatch(says)
    for (const dryArgs of [
      [...args, '--dry'],
      ['--dry', ...args],
    ]) {
      const dry = scratch(true)
      const before = snapshot(dry)
      const run = generate(dry, script, dryArgs)
      expect(run.status).toBe(1)
      expect(run.stderr).toBe(plain.stderr)
      expect(snapshot(dry)).toEqual(before)
    }
  })
})

describe('--dry before or after the words (AC-710-4)', () => {
  it('works either way round, also next to --item', () => {
    const a = generate(scratch(false), 'new-module.ts', [MOD, '--dry'])
    const b = generate(scratch(false), 'new-module.ts', ['--dry', MOD])
    const c = generate(scratch(false), 'new-module.ts', ['--dry', '--item', 'dry-widget', MOD])
    for (const run of [a, b, c]) expect(section(run.stdout, 'Would create').length).toBeGreaterThan(0)
    expect(b.stdout).toBe(a.stdout)
    expect(c.stdout).toBe(a.stdout)
    const section2 = generate(scratch(true), 'new-section.ts', ['--dry', MOD, 'overdue'])
    expect(section(section2.stdout, 'Would create')).toHaveLength(2)
  })

  it('positional() drops only the word a value flag takes', () => {
    expect(positional(['--dry', 'tasks'])).toEqual(['tasks'])
    expect(positional(['tasks', '--dry'])).toEqual(['tasks'])
    expect(positional(['--no-route', 'tasks'])).toEqual(['tasks'])
    expect(positional(['tasks', '--item', 'task'])).toEqual(['tasks'])
    expect(positional(['--item', 'task', 'tasks'])).toEqual(['tasks'])
    expect(positional(['notes', '--dry', 'task-badge'])).toEqual(['notes', 'task-badge'])
  })
})
