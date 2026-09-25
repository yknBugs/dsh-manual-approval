/**
 * A tiny Standard Schema implementation for this plugin's own config.
 *
 * Cordis resolves a plugin's config with
 * `runtime.Config['~standard'].validate(config)`, so `Config` must be a schema
 * object — not a plain defaults object, which fails with
 * `Cannot read properties of undefined (reading 'validate')` and takes the whole
 * plugin tree down.
 *
 * `@deepseek-ai/schemastery` is the usual tool, but this plugin deliberately has
 * no bare package imports, so the one shape Cordis actually reads is implemented
 * here. Validation is synchronous (an async result is rejected by Cordis) and
 * returns `{ value }` or `{ issues }`.
 */

/** Coerce one input into this schema's type, or explain why it cannot. */
function coerce(kind, path, value) {
  if (value === undefined) return { value: undefined }
  if (kind === 'string') {
    if (typeof value === 'string') return { value }
    return { error: `${path} must be a string` }
  }
  if (kind === 'boolean') {
    if (typeof value === 'boolean') return { value }
    return { error: `${path} must be a boolean` }
  }
  if (kind === 'enum') {
    if (typeof value === 'string' && value.length > 0) return { value }
    return { error: `${path} must be a non-empty string` }
  }
  if (kind === 'pattern') {
    if (typeof value === 'string' && value.startsWith('/')) return { value }
    return { error: `${path} must be an absolute route path starting with "/"` }
  }
  return { value }
}

function fail(issues) {
  return { issues: issues.map(message => ({ message, path: [] })) }
}

/**
 * Build a schema from a field table.
 *
 * @param fields - `{ name: { kind, default?, values? } }`
 * @param label - the plugin name used in issue messages
 */
export function objectSchema(fields, label) {
  const defaults = {}
  for (const [name, field] of Object.entries(fields)) {
    if (field.default !== undefined) defaults[name] = field.default
  }

  return {
    /** The defaults, for callers that want them without validating. */
    defaults,
    '~standard': {
      version: 1,
      vendor: 'dsh-manual-approval',
      /** Synchronous validation; Cordis rejects a promise here. */
      validate(input) {
        const source = input === null || typeof input !== 'object' || Array.isArray(input) ? {} : input
        const value = { ...defaults }
        const issues = []
        for (const [name, field] of Object.entries(fields)) {
          const path = `${label}.${name}`
          const candidate = source[name]
          if (candidate === undefined) continue
          if (field.kind === 'enum' && Array.isArray(field.values) && !field.values.includes(candidate)) {
            issues.push({ message: `${path} must be one of ${field.values.join(', ')}`, path: [] })
            continue
          }
          const result = coerce(field.kind, path, candidate)
          if (result.error !== undefined) {
            issues.push({ message: result.error, path: [] })
            continue
          }
          value[name] = result.value
        }
        return issues.length > 0 ? fail(issues.map(issue => issue.message)) : { value }
      },
    },
  }
}
