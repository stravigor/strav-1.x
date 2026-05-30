/**
 * Create a temp dir for `LocalStorage` integration tests. Returns the
 * path and a cleanup function. Tests use this in `beforeAll` so the
 * test suite doesn't litter `storage/` paths in the repo.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface TempStorageRoot {
  path: string
  cleanup(): Promise<void>
}

export async function createTempStorageRoot(): Promise<TempStorageRoot> {
  const path = await mkdtemp(join(tmpdir(), 'strav-storage-'))
  return {
    path,
    async cleanup() {
      await rm(path, { recursive: true, force: true })
    },
  }
}
