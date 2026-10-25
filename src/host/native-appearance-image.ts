import type { FrameworkImageMediaType } from '../contracts/framework-media.ts';
import { NATIVE_APPEARANCE_MAX_DIMENSION, NATIVE_APPEARANCE_MAX_PIXELS } from '../contracts/native-appearance.ts';

/** Parse bounded raster headers. The consuming image service still validates actual decoding. */
export function inspectAppearanceImage(bytes: Buffer): { readonly mediaType: FrameworkImageMediaType; readonly width: number; readonly height: number } | null {
  let mediaType: FrameworkImageMediaType; let width = 0; let height = 0;
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR') {
    mediaType = 'image/png'; width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
  } else if (bytes.length >= 13 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) {
    mediaType = 'image/gif'; width = bytes.readUInt16LE(6); height = bytes.readUInt16LE(8);
  } else if (bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' && bytes.readUInt32LE(4) + 8 === bytes.length) {
    mediaType = 'image/webp';
    const kind = bytes.toString('ascii', 12, 16);
    if (kind === 'VP8X' && bytes.length >= 30 && bytes.readUInt32LE(16) >= 10) { width = bytes.readUIntLE(24, 3) + 1; height = bytes.readUIntLE(27, 3) + 1; }
    else if (kind === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) { width = (bytes.readUInt32LE(21) & 0x3fff) + 1; height = ((bytes.readUInt32LE(21) >>> 14) & 0x3fff) + 1; }
    else if (kind === 'VP8 ' && bytes.length >= 30 && bytes.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))) { width = bytes.readUInt16LE(26) & 0x3fff; height = bytes.readUInt16LE(28) & 0x3fff; }
    else return null;
  } else if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9) {
    mediaType = 'image/jpeg'; let position = 2;
    while (position + 4 <= bytes.length) {
      if (bytes[position] !== 0xff) return null;
      while (bytes[position] === 0xff) position++;
      const marker = bytes[position++];
      if (marker === undefined || marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
      if (position + 2 > bytes.length) return null;
      const size = bytes.readUInt16BE(position);
      if (size < 2 || position + size > bytes.length) return null;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (size < 8) return null;
        height = bytes.readUInt16BE(position + 3); width = bytes.readUInt16BE(position + 5); break;
      }
      position += size;
    }
  } else return null;
  return width > 0 && height > 0 && width <= NATIVE_APPEARANCE_MAX_DIMENSION && height <= NATIVE_APPEARANCE_MAX_DIMENSION && width * height <= NATIVE_APPEARANCE_MAX_PIXELS ? { mediaType, width, height } : null;
}
