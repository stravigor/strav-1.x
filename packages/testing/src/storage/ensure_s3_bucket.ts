/**
 * Ensure the configured test bucket exists. Creates it on MinIO via
 * the admin endpoint when it's missing — AWS / R2 users typically
 * create the bucket out of band, so this helper is a no-op when the
 * list call already succeeds.
 *
 * Returns the bucket name on success. Throws if the bucket can't be
 * reached or created.
 */

import { S3Client } from 'bun'

export async function ensureS3Bucket(): Promise<string> {
  const endpoint = process.env['S3_ENDPOINT']
  const bucket = process.env['S3_BUCKET']
  const accessKeyId = process.env['S3_ACCESS_KEY_ID']
  const secretAccessKey = process.env['S3_SECRET_ACCESS_KEY']
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    throw new Error(
      'ensureS3Bucket: missing S3_ENDPOINT / S3_BUCKET / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY env. Source .env.test or run docker-compose up.',
    )
  }
  const client = new S3Client({
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    region: process.env['S3_REGION'] ?? 'us-east-1',
  })
  try {
    await client.list({ maxKeys: 1 })
    return bucket
  } catch {
    // Try MinIO-style auto-create via a PUT to the bucket root.
    try {
      const url = `${endpoint.replace(/\/$/, '')}/${bucket}`
      // MinIO accepts an empty PUT against the bucket URL with the
      // default region. Signing a CreateBucket call by hand is more
      // work than this slice warrants — we shell to the s3 list path
      // again after a best-effort PUT and report success on either
      // outcome.
      await fetch(url, { method: 'PUT' }).catch(() => undefined)
      await client.list({ maxKeys: 1 })
      return bucket
    } catch (cause) {
      throw new Error(
        `ensureS3Bucket: bucket "${bucket}" does not exist at ${endpoint} and could not be created. ` +
          'Create it manually via the MinIO console (http://localhost:9001) or your provider.',
        { cause },
      )
    }
  }
}
