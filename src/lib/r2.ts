import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

function getR2Client(): S3Client {
  const endpoint = process.env.R2_ENDPOINT;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error(
      "R2 credentials not configured. Set R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY in .env.local"
    );
  }

  return new S3Client({
    region: "auto",
    endpoint,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });
}

/**
 * Generate a presigned URL for a PDF stored in R2.
 * URL is valid for 1 hour.
 */
export async function getSignedPdfUrl(key: string): Promise<string> {
  const client = getR2Client();

  const command = new GetObjectCommand({
    Bucket: bucketName(),
    Key: key,
  });

  return await getSignedUrl(client, command, { expiresIn: 3600 });
}

/**
 * The single bucket that holds BOTH the judgment corpus (`supreme-court/`,
 * uploaded by the ingestion pipeline, which defaults to the same name in
 * `pipeline/config.py`) and user data (`workspaces/`, `ocr/`, `translations/`).
 * Judgment PDF keys are rebuilt from (year, path) and presigned at click time,
 * so a bucket without the corpus makes every citation link 404 with R2's raw
 * NoSuchKey XML. Keep this default and `pipeline/config.py` in agreement.
 */
function bucketName(): string {
  return process.env.R2_BUCKET_NAME || "legal-judgments";
}

/**
 * Upload a buffer to R2 under `key`. Used for user-uploaded documents (Feature
 * 1 / 2) and generated .docx outputs (Feature 2). Returns the key on success.
 */
export async function uploadToR2(
  key: string,
  body: Buffer | Uint8Array,
  contentType: string
): Promise<string> {
  const client = getR2Client();
  await client.send(
    new PutObjectCommand({
      Bucket: bucketName(),
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  );
  return key;
}

/**
 * Fetch an object's bytes from R2. Used by the ingestion worker to read an
 * uploaded document back for extraction.
 */
export async function getR2Object(key: string): Promise<Buffer> {
  const client = getR2Client();
  const res = await client.send(
    new GetObjectCommand({ Bucket: bucketName(), Key: key })
  );
  // A missing object comes back with an empty Body; surface a clear error rather
  // than the cryptic "Cannot read properties of undefined" the `!` would throw.
  if (!res.Body) throw new Error("File not found in storage");
  const bytes = await res.Body.transformToByteArray();
  return Buffer.from(bytes);
}

/**
 * Best-effort delete of one or more objects from R2. Used when a workspace,
 * document, or translation is removed so we don't orphan stored files. Empty
 * keys are skipped, and failures are swallowed — the DB row is the source of
 * truth, so a stray object is harmless and shouldn't block the delete.
 */
export async function deleteFromR2(keys: Array<string | null | undefined>): Promise<void> {
  const objects = keys.filter((k): k is string => Boolean(k)).map((Key) => ({ Key }));
  if (objects.length === 0) return;
  try {
    const client = getR2Client();
    // DeleteObjects caps at 1000 keys per request; batch to stay safe.
    for (let i = 0; i < objects.length; i += 1000) {
      await client.send(
        new DeleteObjectsCommand({
          Bucket: bucketName(),
          Delete: { Objects: objects.slice(i, i + 1000), Quiet: true },
        })
      );
    }
  } catch {
    // Orphaned objects are non-fatal; intentionally ignore.
  }
}

/**
 * Presigned download URL for any R2 object (not just PDFs). Valid for 1 hour.
 */
export async function getSignedObjectUrl(key: string): Promise<string> {
  const client = getR2Client();
  return getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: bucketName(), Key: key }),
    { expiresIn: 3600 }
  );
}
