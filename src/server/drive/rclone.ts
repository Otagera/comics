/**
 * rclone wrapper.
 *
 * Ported from cxsync. The important part is the environment: rclone buffers
 * large transfers to disk, and lumina-1's root filesystem has no headroom, so
 * TMPDIR and the rclone cache are forced onto the volume on every invocation.
 */

import { spawn } from 'node:child_process'
import { createWriteStream, mkdirSync } from 'node:fs'
import { config } from '../config.ts'

export interface DriveEntry {
  /** Path relative to the remote root, e.g. "Marvel/Alias/x.cbr". */
  Path: string
  Name: string
  Size: number
  MimeType: string
  ModTime: string
  IsDir: boolean
  /** Google Drive file id: stable across renames and moves. */
  ID?: string
}

function rcloneEnv(): NodeJS.ProcessEnv {
  mkdirSync(config.tmpDir, { recursive: true })
  return {
    ...process.env,
    TMPDIR: config.tmpDir,
    RCLONE_CACHE_DIR: `${config.tmpDir}/rclone-cache`,
    RCLONE_CONFIG: config.drive.configPath,
  }
}

export interface RcloneResult {
  stdout: string
  stderr: string
}

export function rclone(
  args: string[],
  opts: {
    timeoutMs?: number
    onStderr?: (chunk: string) => void
    /** Stream stdout straight to this path instead of buffering it. */
    outFile?: string
  } = {},
): Promise<RcloneResult> {
  const { timeoutMs = 30 * 60_000, onStderr, outFile } = opts

  return new Promise((resolve, reject) => {
    const child = spawn(config.drive.rcloneBin, args, { env: rcloneEnv() })
    let stdout = ''
    let stderr = ''
    let settled = false
    // Binary output (a slice of a comic archive) must never go through a
    // string buffer -- it would be mangled by UTF-8 decoding.
    const sink = outFile ? createWriteStream(outFile) : null
    if (sink) child.stdout.pipe(sink)

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      reject(new Error(`rclone ${args[0]} timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    if (!sink) {
      child.stdout.on('data', (d) => {
        stdout += d
      })
    }
    child.stderr.on('data', (d) => {
      const s = String(d)
      stderr += s
      onStderr?.(s)
    })

    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`rclone could not start (${config.drive.rcloneBin}): ${err.message}`))
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const done = () => {
        if (code === 0) resolve({ stdout, stderr })
        else reject(new Error(`rclone ${args[0]} exited ${code}: ${stderr.trim().slice(0, 500)}`))
      }
      // Wait for the file to be flushed before the caller reads it.
      if (sink) sink.end(done)
      else done()
    })
  })
}

/** Every comic file in the Drive archive, recursively. */
export async function listDrive(): Promise<DriveEntry[]> {
  const { stdout } = await rclone(
    ['lsjson', config.drive.remote, '-R', '--files-only'],
    { timeoutMs: 10 * 60_000 },
  )
  const all = JSON.parse(stdout) as DriveEntry[]
  const exts = config.comicExts as readonly string[]
  return all
    .filter((e) => !e.IsDir && exts.some((x) => e.Name.toLowerCase().endsWith(x)))
    .sort((a, b) => a.Path.localeCompare(b.Path))
}

/**
 * Copy one file out of the archive to an exact local path.
 *
 * `copyto` (not `copy`) so the destination filename is ours to choose, and the
 * staging name never collides with a partially-written sibling.
 */
export async function copyFromDrive(
  drivePath: string,
  destPath: string,
  onProgress?: (line: string) => void,
): Promise<void> {
  await rclone(
    [
      'copyto',
      `${config.drive.remote}/${drivePath}`,
      destPath,
      '--transfers', '1',
      '--drive-chunk-size', '64M',
      '--retries', '3',
      '--low-level-retries', '10',
      '--stats', '10s',
      '--stats-one-line',
    ],
    { timeoutMs: 60 * 60_000, onStderr: onProgress },
  )
}
