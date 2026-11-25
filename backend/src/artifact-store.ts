import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm, lstat } from "node:fs/promises";
import path from "node:path";
import type { ArtifactDescriptor } from "./artifact-policy.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const digest = /^[a-f0-9]{64}$/i;
const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/**
 * Minimal content-addressed artifact store.
 * The caller must authenticate/authorize task ownership and validate the manifest first.
 * Disk paths are derived only from a UUID and SHA-256, never from sandbox-supplied paths.
 */
export class LocalArtifactStore {
  private readonly root: string;

  constructor(rootDirectory: string) {
    if (!rootDirectory || !path.isAbsolute(rootDirectory)) {
      throw new Error("Artifact store root must be an absolute path");
    }
    this.root = path.resolve(rootDirectory);
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const info = await lstat(this.root);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("Artifact store root must be a real directory, not a symlink");
    }
  }

  private location(taskId: string, sha256: string): string {
    if (!uuid.test(taskId) || !digest.test(sha256)) throw new Error("Invalid artifact storage key");
    const target = path.join(this.root, taskId.toLowerCase(), sha256.toLowerCase());
    if (!target.startsWith(this.root + path.sep)) throw new Error("Invalid artifact storage path");
    return target;
  }

  async put(taskId: string, descriptor: ArtifactDescriptor, data: Buffer): Promise<void> {
    if (!Buffer.isBuffer(data)) throw new Error("Artifact content must be a Buffer");
    if (data.byteLength !== descriptor.bytes) throw new Error("Artifact byte count mismatch");
    if (hash(data) !== descriptor.sha256.toLowerCase()) throw new Error("Artifact SHA-256 mismatch");
    const target = this.location(taskId, descriptor.sha256);
    await this.ensureRoot();
    const directory = path.dirname(target);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temp = path.join(directory, "." + descriptor.sha256 + "." + createHash("sha256").update(String(process.pid) + String(Date.now())).digest("hex").slice(0, 16) + ".tmp");
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temp, "wx", 0o600);
      await handle.writeFile(data);
      await handle.sync();
      await handle.close();
      handle = undefined;
      try {
        await rename(temp, target);
      } catch (error) {
        // Concurrent identical uploads are idempotent; never overwrite different bytes.
        const existing = await readFile(target).catch(() => undefined);
        if (!existing || existing.byteLength !== descriptor.bytes || hash(existing) !== descriptor.sha256.toLowerCase()) throw error;
      }
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(temp, { force: true }).catch(() => undefined);
    }
  }

  async get(taskId: string, descriptor: Pick<ArtifactDescriptor, "bytes" | "sha256">): Promise<Buffer> {
    const target = this.location(taskId, descriptor.sha256);
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Stored artifact is not a regular file");
    const data = await readFile(target);
    if (data.byteLength !== descriptor.bytes || hash(data) !== descriptor.sha256.toLowerCase()) {
      throw new Error("Stored artifact integrity check failed");
    }
    return data;
  }

  async deleteTask(taskId: string): Promise<void> {
    if (!uuid.test(taskId)) throw new Error("Invalid task ID");
    await rm(path.join(this.root, taskId.toLowerCase()), { recursive: true, force: true });
  }
}
