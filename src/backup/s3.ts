import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import fs from "node:fs";
import fsp from "node:fs/promises";
import type { BackupConfig } from "../config.ts";

/**
 * Uploads to any S3 compatible endpoint, including Cloudflare R2 and MinIO.
 * Objects are uploaded from a finished file on disk so the content length is
 * known up front, which avoids needing multipart for a single archive.
 */
export class S3Uploader {
    private readonly client: S3Client;

    constructor(private readonly config: BackupConfig) {
        this.client = new S3Client({
            region: config.region,
            credentials: {
                accessKeyId: config.accessKeyId,
                secretAccessKey: config.secretAccessKey,
            },
            forcePathStyle: config.forcePathStyle,
            ...(config.endpoint !== null ? { endpoint: config.endpoint } : {}),
        });
    }

    async upload(localFile: string, key: string): Promise<{ key: string; bytes: number }> {
        const st = await fsp.stat(localFile);
        await this.client.send(
            new PutObjectCommand({
                Bucket: this.config.bucket,
                Key: key,
                Body: fs.createReadStream(localFile),
                ContentLength: st.size,
                ContentType: "application/zip",
            }),
        );
        return { key, bytes: st.size };
    }

    objectKey(name: string): string {
        const prefix = this.config.prefix.replace(/^\/+|\/+$/g, "");
        return prefix === "" ? name : `${prefix}/${name}`;
    }

    destroy(): void {
        this.client.destroy();
    }
}
