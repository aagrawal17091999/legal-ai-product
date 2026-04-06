import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
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
  const bucket = process.env.R2_BUCKET_NAME || "legal-judgments";

  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  });

  return await getSignedUrl(client, command, { expiresIn: 3600 });
}

/**
 * Build the public R2 URL for a PDF.
 * Use this if the R2 bucket has public access enabled.
 */
export function getPublicPdfUrl(key: string): string {
  const endpoint = process.env.R2_ENDPOINT || "";
  const bucket = process.env.R2_BUCKET_NAME || "legal-judgments";
  // Cloudflare R2 public URL pattern
  return `${endpoint}/${bucket}/${key}`;
}
