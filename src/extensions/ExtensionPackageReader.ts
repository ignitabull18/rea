import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { ZipReader, Uint8ArrayReader } from "@zip.js/zip.js";
import { DirectoryArtifactReader } from "../artifacts/DirectoryArtifactReader.js";
import { readStableArtifact } from "../artifacts/readStableArtifact.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";

// Bounds apply before archive allocation and while decompression streams, including lying ZIP metadata.
const MAX_PACKAGE_BYTES = 128 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 10000;
export interface ExtensionPackage {
  readonly files: ReadonlyMap<string, Buffer>;
  readonly sha256: string;
  readonly format: "directory" | "zip" | "crx2" | "crx3";
}
export const extensionDigest = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

/** Reject archive aliases, traversal and platform-specific alternate path syntax. Never extract or execute. */
const memberPath = (value: string): string => {
  if (
    !value ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/") ||
    /^[a-z]:/iu.test(value) ||
    value
      .split("/")
      .some((part) => part === ".." || part === "." || part === "")
  )
    throw new ArtifactReaderFailure(
      "path",
      `Unsafe extension member path: ${value}`,
    );
  return value;
};

/** Read CRX framing as documented by Chromium; signature bytes are retained only in the input digest, not authenticated. */
const zipPayload = (
  bytes: Buffer,
): { offset: number; format: ExtensionPackage["format"] } => {
  if (bytes.subarray(0, 4).equals(Buffer.from("Cr24"))) {
    if (bytes.length < 12)
      throw new ArtifactReaderFailure("format", "Truncated CRX header");
    const version = bytes.readUInt32LE(4);
    let offset: number;
    if (version === 2) {
      if (bytes.length < 16)
        throw new ArtifactReaderFailure("format", "Truncated CRX2 header");
      offset = 16 + bytes.readUInt32LE(8) + bytes.readUInt32LE(12);
    } else if (version === 3) offset = 12 + bytes.readUInt32LE(8);
    else
      throw new ArtifactReaderFailure(
        "format",
        `Unsupported CRX version: ${version}`,
      );
    if (offset > bytes.length - 4 || bytes.readUInt32LE(offset) !== 0x04034b50)
      throw new ArtifactReaderFailure(
        "format",
        "CRX header does not point to a ZIP payload",
      );
    return { offset, format: version === 2 ? "crx2" : "crx3" };
  }
  if (bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50)
    throw new ArtifactReaderFailure(
      "format",
      "Expected a ZIP, CRX2 or CRX3 package",
    );
  return { offset: 0, format: "zip" };
};

/** Reuse REA's stable directory reads and zip.js's CRC/overlap checks without writing archive members to disk. */
export const readExtensionPackage = async (
  path: string,
  signal?: AbortSignal,
): Promise<ExtensionPackage> => {
  const state = await lstat(path);
  if (state.isSymbolicLink())
    throw new ArtifactReaderFailure(
      "path",
      "Extension input must not be a symlink",
    );
  const files = new Map<string, Buffer>();
  let expanded = 0;
  const consume = async (
    name: string,
    declared: number | null,
    chunks: AsyncIterable<Uint8Array>,
  ): Promise<void> => {
    const key = memberPath(name);
    if (files.has(key))
      throw new ArtifactReaderFailure(
        "path",
        `Duplicate extension member: ${key}`,
      );
    if (
      files.size >= MAX_FILES ||
      (declared !== null && declared > MAX_EXPANDED_BYTES - expanded)
    )
      throw new ArtifactReaderFailure(
        "limit",
        "Extension exceeds the 10,000-file or 64 MiB expanded input budget",
      );
    const buffers: Buffer[] = [];
    for await (const chunk of chunks) {
      signal?.throwIfAborted();
      expanded += chunk.byteLength;
      if (expanded > MAX_EXPANDED_BYTES)
        throw new ArtifactReaderFailure(
          "limit",
          "Extension exceeds the 64 MiB expanded input budget",
        );
      buffers.push(Buffer.from(chunk));
    }
    files.set(key, Buffer.concat(buffers));
  };
  if (state.isDirectory()) {
    const reader = new DirectoryArtifactReader(path);
    let count = 0;
    try {
      for await (const entry of reader.entries(signal)) {
        if (++count > MAX_FILES)
          throw new ArtifactReaderFailure(
            "limit",
            "Extension exceeds the 10,000-entry budget",
          );
        if (entry.kind === "directory") continue;
        if (entry.kind !== "file")
          throw new ArtifactReaderFailure(
            "path",
            `Extension contains a non-regular member: ${entry.path}`,
          );
        await consume(
          entry.path,
          entry.declaredSize,
          await reader.open(entry, signal),
        );
      }
    } finally {
      await reader.close();
    }
    const inventory = [...files]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, bytes]) => [name, extensionDigest(bytes)]);
    return {
      files,
      sha256: extensionDigest(JSON.stringify(inventory)),
      format: "directory",
    };
  }
  const snapshot = await readStableArtifact(path, MAX_PACKAGE_BYTES, signal);
  const payload = zipPayload(snapshot.bytes);
  const reader = new ZipReader(
    new Uint8ArrayReader(snapshot.bytes.subarray(payload.offset)),
    {
      checkSignature: true,
      checkOverlappingEntry: true,
      filenameValidation: "tolerant",
    },
  );
  try {
    let count = 0;
    for await (const entry of reader.getEntriesGenerator()) {
      signal?.throwIfAborted();
      if (++count > MAX_FILES)
        throw new ArtifactReaderFailure(
          "limit",
          "Extension exceeds the 10,000 ZIP-entry budget",
        );
      memberPath(
        entry.directory ? entry.filename.slice(0, -1) : entry.filename,
      );
      if (entry.directory) continue;
      if (
        entry.encrypted ||
        ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000
      )
        throw new ArtifactReaderFailure(
          "format",
          "Encrypted or symlink extension members are unsupported",
        );
      if (entry.uncompressedSize > MAX_EXPANDED_BYTES - expanded)
        throw new ArtifactReaderFailure(
          "limit",
          "Extension exceeds the 64 MiB expanded input budget",
        );
      // A TransformStream retains backpressure and bounds actual bytes before storing them.
      const stream = new TransformStream<Uint8Array, Uint8Array>();
      const reading = consume(
        entry.filename,
        entry.uncompressedSize,
        stream.readable,
      );
      const writing = entry.getData(
        stream.writable,
        signal === undefined ? {} : { signal },
      );
      const results = await Promise.allSettled([reading, writing]);
      for (const result of results)
        if (result.status === "rejected") throw result.reason;
    }
  } finally {
    await reader.close();
  }
  return { files, sha256: snapshot.sha256, format: payload.format };
};
