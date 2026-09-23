/**
 * Standard base64 for the bytes that cross the native boundary as JSON.
 *
 * Terminal input and the polled read path carry bytes inside JSON. serde's default for a byte
 * vector is an array of numbers — three to four characters per byte, parsed one number at a time —
 * and that is what a paste and a 64 KiB read cost before. The broker now speaks base64; these are
 * its counterparts. `atob`/`btoa` work on binary strings, so each is wrapped once here and nowhere
 * else.
 */
export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x8000;
  for (let index = 0; index < bytes.length; index += step) {
    binary += String.fromCharCode(...bytes.subarray(index, index + step));
  }
  return btoa(binary);
}

export function decodeBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
