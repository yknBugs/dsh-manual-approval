/**
 * Rule persistence.
 *
 * Rules live beside the Harness home so they survive process restarts and are
 * shared by every session in the profile:
 *
 *   <DSH_HOME>/manual-approval/rules.json
 *
 * The file holds the raw editor document — `{ version, masterEnabled, rules }` —
 * exactly as the settings page submitted it, because the plugin never rewrites
 * the user's text. Compilation happens on read, so a rule with a syntax error is
 * preserved on disk and reported to the editor instead of being dropped.
 *
 * Writes are atomic (temp file + rename) so a crash cannot leave a truncated
 * rules file behind.
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Current on-disk shape version. */
export const STORE_VERSION = 1

/** The empty document. */
export function emptyDocument() {
  return { version: STORE_VERSION, masterEnabled: true, rules: [] }
}

/** Resolve `$DSH_HOME`, falling back to `~/.dsh` exactly as the Harness does. */
export function resolveDshHome(env = process.env, home = homedir()) {
  const configured = env?.DSH_HOME
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  return join(home, '.dsh')
}

/** Absolute path of the rules document. */
export function rulesPath(dshHome = resolveDshHome()) {
  return join(dshHome, 'manual-approval', 'rules.json')
}

/** Coerce anything read from disk into a usable document. */
export function normalizeDocument(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return emptyDocument()
  return {
    version: Number.isInteger(value.version) ? value.version : STORE_VERSION,
    masterEnabled: value.masterEnabled !== false,
    rules: Array.isArray(value.rules) ? value.rules.map(entry => (entry === null || typeof entry !== 'object' || Array.isArray(entry) ? {} : entry)) : [],
  }
}

/** Read the document, returning the empty one when absent or unreadable. */
export function readDocument(file = rulesPath(), readFile = readFileSync) {
  let text
  try {
    text = readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { document: emptyDocument(), existed: false }
    return { document: emptyDocument(), existed: false, error: message(error) }
  }
  try {
    return { document: normalizeDocument(JSON.parse(text)), existed: true }
  } catch (error) {
    // A damaged file must not silently become "no rules": report it so the
    // editor can show what happened, and still fail safe by loading nothing.
    return { document: emptyDocument(), existed: true, error: `rules file is not valid JSON: ${message(error)}` }
  }
}

/** Write the document atomically, creating the directory when needed. */
export function writeDocument(document, file = rulesPath()) {
  const normalized = normalizeDocument(document)
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
    renameSync(temporary, file)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {
      // Best effort: the temp file is not load-bearing.
    }
    throw error
  }
  return normalized
}

function message(error) {
  return error instanceof Error ? error.message : String(error)
}
