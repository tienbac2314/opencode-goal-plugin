import { readFile, writeFile } from "node:fs/promises"

type PackageJson = {
  name: string
  version: string
}

function parseVersion(version: string) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-.+)?$/.exec(version)
  if (!match) throw new Error(`Unsupported semver version: ${version}`)
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  }
}

function compareVersions(left: string, right: string) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch
}

function bumpPatch(version: string) {
  const parsed = parseVersion(version)
  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`
}

async function latestPublishedVersion(name: string) {
  const proc = Bun.spawn(["npm", "view", name, "version", "--silent"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const timeout = setTimeout(() => proc.kill(), 30_000)
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]).finally(() => clearTimeout(timeout))
  if (code === null) throw new Error(`npm view timed out for ${name}`)
  if (code === 0) return stdout.trim() || null
  if (stderr.includes("E404") || stderr.includes("404 Not Found")) return null
  throw new Error(stderr.trim() || `npm view failed with exit code ${code}`)
}

const packagePath = new URL("../package.json", import.meta.url)
const pkg = JSON.parse(await readFile(packagePath, "utf8")) as PackageJson
const latest = await latestPublishedVersion(pkg.name)
const next = latest && compareVersions(latest, pkg.version) >= 0 ? bumpPatch(latest) : pkg.version

if (next !== pkg.version) {
  pkg.version = next
  await writeFile(packagePath, `${JSON.stringify(pkg, null, 2)}\n`)
}

console.log(`Publishing ${pkg.name}@${next}${latest ? ` (latest on npm: ${latest})` : " (first publish)"}`)
