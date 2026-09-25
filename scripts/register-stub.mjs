/**
 * Test-only dependency shim.
 *
 * The Host half imports `@deepseek-ai/dsh-llm`, which resolves through a DSH
 * profile's `node_modules` at runtime but not from this checkout. This script
 * creates a throwaway `node_modules/@deepseek-ai/dsh-llm` link inside the repo
 * root so the selftest can import the real module, then removes it again.
 *
 * It exists only for tests and is never part of the published package.
 */
import { mkdirSync, rmSync, symlinkSync, existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')
const scopeDir = join(repoRoot, 'node_modules', '@deepseek-ai')
const linkPath = join(scopeDir, 'dsh-llm')
const stubDir = join(repoRoot, '.stubs', 'dsh-llm')

mkdirSync(stubDir, { recursive: true })
writeFileSync(
  join(stubDir, 'package.json'),
  `${JSON.stringify({ name: '@deepseek-ai/dsh-llm', version: '0.0.0-test-stub', type: 'module', main: './index.js' }, null, 2)}\n`,
)
writeFileSync(
  join(stubDir, 'index.js'),
  [
    '/** Test stub: mirrors only the surface the Host half imports. */',
    'export function createUserMessage(input) {',
    "  return { __stub: 'user-message', source: input.source, content: input.content }",
    '}',
    '',
  ].join('\n'),
)

rmSync(linkPath, { recursive: true, force: true })
mkdirSync(scopeDir, { recursive: true })
symlinkSync(stubDir, linkPath, 'junction')

console.log(`[stub] linked ${linkPath} -> ${stubDir}`)

const dispose = () => {
  rmSync(linkPath, { recursive: true, force: true })
  if (existsSync(join(repoRoot, 'node_modules', '@deepseek-ai'))) {
    try {
      rmSync(join(repoRoot, 'node_modules'), { recursive: true, force: true })
    } catch {
      // Leaving an empty node_modules behind is harmless.
    }
  }
}
process.on('exit', dispose)
process.on('SIGINT', () => { dispose(); process.exit(130) })
