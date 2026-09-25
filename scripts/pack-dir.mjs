/**
 * Pack a directory into an npm-style tarball.
 *
 * Generic and self-contained: no test depends on it and it references no path on
 * any particular machine. It stays because packing a plugin checkout into a
 * tarball is the one operation an install from a directory needs.
 *
 * Usage: node scripts/pack-dir.mjs <source-dir> <target-tgz>
 * Entries are emitted as `package/<relative path>` with POSIX separators, which
 * is what npm tarballs look like on the wire.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { dirname, join, relative, sep } from 'node:path'

const [sourceDir, targetFile] = process.argv.slice(2)
if (!sourceDir || !targetFile) {
  console.error('usage: node scripts/pack-dir.mjs <source-dir> <target-tgz>')
  process.exit(2)
}

/** Paths never shipped in the tarball. */
const SKIP = new Set(['.git', 'node_modules', '.github'])

function walk(dir, root, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue
    const full = join(dir, entry)
    const stats = statSync(full)
    if (stats.isDirectory()) {
      walk(full, root, out)
      continue
    }
    out.push(relative(root, full).split(sep).join('/'))
  }
  return out
}

function tarHeader(name, size) {
  const header = Buffer.alloc(512, 0)
  header.write(name, 0, 100, 'utf8')
  header.write('000644 \0', 100, 8, 'utf8')
  header.write('0000000 \0', 108, 8, 'utf8')
  header.write('0000000 \0', 116, 8, 'utf8')
  header.write(`${size.toString(8).padStart(11, '0')} `, 124, 12, 'utf8')
  header.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, '0')} `, 136, 12, 'utf8')
  header.write('        ', 148, 8, 'utf8')
  header.write('0', 156, 1, 'utf8')
  header.write('ustar\0', 257, 6, 'utf8')
  header.write('00', 263, 2, 'utf8')
  let sum = 0
  for (let index = 0; index < 512; index += 1) sum += header[index]
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf8')
  return header
}

const files = walk(sourceDir, sourceDir).sort()
const chunks = []
for (const file of files) {
  const body = readFileSync(join(sourceDir, file))
  chunks.push(tarHeader(`package/${file}`, body.length), body)
  const pad = (512 - (body.length % 512)) % 512
  if (pad > 0) chunks.push(Buffer.alloc(pad, 0))
}
chunks.push(Buffer.alloc(1024, 0))

mkdirSync(dirname(targetFile), { recursive: true })
writeFileSync(targetFile, gzipSync(Buffer.concat(chunks), { level: 9 }))
console.log(`packed ${files.length} files -> ${targetFile}`)
for (const file of files) console.log(`  ${file}`)
