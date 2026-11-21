import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

type EncryptedBytes = Readonly<{
  nonce: Buffer;
  tag: Buffer;
  ciphertext: Buffer;
}>;

export type SealedWork = Readonly<{
  workId: string;
  deadlineMs: number;
  content: EncryptedBytes;
  wrappedKey: EncryptedBytes;
}>;

function validateTime(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("Expected non-negative integer milliseconds since the Unix epoch");
  }
}

function associatedData(
  purpose: "content" | "work-key",
  workId: string,
  deadlineMs: number,
): Buffer {
  return Buffer.from(JSON.stringify(["encryption-deadline-v1", purpose, workId, deadlineMs]));
}

function encrypt(key: Buffer, plaintext: Buffer, aad: Buffer): EncryptedBytes {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { nonce, tag: cipher.getAuthTag(), ciphertext };
}

function decrypt(key: Buffer, data: EncryptedBytes, aad: Buffer): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, data.nonce, { authTagLength: TAG_BYTES });
  decipher.setAAD(aad);
  decipher.setAuthTag(data.tag);
  return Buffer.concat([decipher.update(data.ciphertext), decipher.final()]);
}

// The process-local wrapping key and the injected clock model a release authority.
export class DeadlineEncryption {
  readonly #wrappingKey = randomBytes(KEY_BYTES);
  readonly #clock: () => number;

  constructor(clock: () => number) {
    this.#clock = clock;
  }

  seal(workId: string, deadlineMs: number, plaintext: Buffer): SealedWork {
    validateTime(deadlineMs);
    const workKey = randomBytes(KEY_BYTES);
    try {
      return {
        workId,
        deadlineMs,
        content: encrypt(workKey, plaintext, associatedData("content", workId, deadlineMs)),
        wrappedKey: encrypt(
          this.#wrappingKey,
          workKey,
          associatedData("work-key", workId, deadlineMs),
        ),
      };
    } finally {
      workKey.fill(0);
    }
  }

  open(work: SealedWork): Buffer {
    const { workId, deadlineMs, content, wrappedKey } = work;
    validateTime(deadlineMs);
    const nowMs = this.#clock();
    validateTime(nowMs);
    if (nowMs < deadlineMs) {
      throw new Error("Deadline has not been reached");
    }

    const workKey = decrypt(
      this.#wrappingKey,
      wrappedKey,
      associatedData("work-key", workId, deadlineMs),
    );
    try {
      return decrypt(workKey, content, associatedData("content", workId, deadlineMs));
    } finally {
      workKey.fill(0);
    }
  }
}
