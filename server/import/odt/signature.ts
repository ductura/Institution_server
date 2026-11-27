// An ODT is known by its content, not by its name (ODF 1.2 part 3 §3.3): the
// first entry of the ZIP is "mimetype", stored, without an extra field, and
// holds exactly the media type of a text document. This only picks the
// reader; readOdt checks the same entry again through the whole ZIP reader.
export const ODT_MIMETYPE = "application/vnd.oasis.opendocument.text";

const LOCAL_SIGNATURE = 0x04034b50;
const NAME = "mimetype";
const DATA_START = 30 + NAME.length;

export function hasOdtSignature(bytes: Uint8Array): boolean {
  if (bytes.length < DATA_START + ODT_MIMETYPE.length) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== LOCAL_SIGNATURE) return false;
  // Stored (method 0), the name is "mimetype" and no extra field follows it.
  if (view.getUint16(8, true) !== 0) return false;
  if (view.getUint16(26, true) !== NAME.length || view.getUint16(28, true) !== 0) return false;
  if (view.getUint32(18, true) !== ODT_MIMETYPE.length) return false;
  for (let i = 0; i < NAME.length; i += 1) {
    if (bytes[30 + i] !== NAME.charCodeAt(i)) return false;
  }
  for (let i = 0; i < ODT_MIMETYPE.length; i += 1) {
    if (bytes[DATA_START + i] !== ODT_MIMETYPE.charCodeAt(i)) return false;
  }
  return true;
}
