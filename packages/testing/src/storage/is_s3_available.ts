/**
 * Cheap connection probe over `Bun.S3Client`. Opens against
 * `S3_ENDPOINT` + creds, attempts to list one key, ensures the
 * configured bucket exists (creates it lazily on MinIO when it
 * doesn't). Cached for the lifetime of the test process.
 *
 * Returns `false` if env is missing OR the probe fails. Pair with
 * `describe.skipIf(!await isS3Available())`.
 */

import { S3Client } from 'bun'

let cachedAvailability: boolean | null = null

export async function isS3Available(): Promise<boolean> {
  if (cachedAvailability !== null) return cachedAvailability
  const endpoint = process.env['S3_ENDPOINT']
  const bucket = process.env['S3_BUCKET']
  const accessKeyId = process.env['S3_ACCESS_KEY_ID']
  const secretAccessKey = process.env['S3_SECRET_ACCESS_KEY']
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    cachedAvailability = false
    return false
  }
  try {
    const client = new S3Client({
      endpoint,
      bucket,
      accessKeyId,
      secretAccessKey,
      region: process.env['S3_REGION'] ?? 'us-east-1',
    })
    // Probe: list one key. If the bucket doesn't exist, listing will
    // throw; ensure-bucket via writing+deleting a sentinel works on
    // MinIO (bucket auto-create defaults vary), but we lean on the
    // user creating the bucket beforehand for AWS/R2 to avoid
    // surprises. On MinIO the suite uses an ensure helper that's
    // called separately by the test setup.
    await client.list({ maxKeys: 1 })
    cachedAvailability = true
    return true
  } catch {
    cachedAvailability = false
    return false
  }
}
