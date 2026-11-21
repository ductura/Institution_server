const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d];

export const hasPdfHeader = (bytes: Uint8Array): boolean =>
  PDF_MAGIC.every((byte, index) => bytes[index] === byte);
