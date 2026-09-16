import { CreateBucketCommand, HeadBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { config } from '../config.js';

let ensured = false;
const client = new S3Client({ endpoint: config.minioEndpoint, region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: config.minioAccessKey, secretAccessKey: config.minioSecretKey } });

async function ensureBucket() {
  if (ensured) return;
  try { await client.send(new HeadBucketCommand({ Bucket: config.minioBucket })); }
  catch { await client.send(new CreateBucketCommand({ Bucket: config.minioBucket })); }
  ensured = true;
}

export async function storeKnowledgeFile({ key, body, mimeType }) {
  await ensureBucket();
  await client.send(new PutObjectCommand({ Bucket: config.minioBucket, Key: key, Body: body, ContentType: mimeType }));
  return { bucket: config.minioBucket, key };
}
