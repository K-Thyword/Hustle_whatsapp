// Perceptual (difference) hashing for promo screenshots — added as part of
// a 2026-09-11 fraud-mitigation pass. This is NOT proof a screenshot is
// fake; it only answers "have we seen a visually near-identical image
// before, possibly from a different entrant?" — a signal for admin to look
// at two submissions together, never an automatic rejection (two genuine
// entrants can legitimately screenshot the exact same public HustleApp
// post for like_post/share_anniversary, so a match isn't inherently
// fraud — see the caller in promoEntry.ts for how this gets used).
//
// Uses a standard dHash (difference hash): shrink to a small grayscale
// grid, then encode whether each pixel is brighter than its right
// neighbor as a single bit. Robust to resaving/recompression (WhatsApp
// recompresses every image it delivers) and minor scaling, which is
// exactly the noise this needs to survive — unlike a cryptographic hash
// (e.g. SHA-256), which would change completely from recompression alone
// and so would only ever catch a byte-for-byte identical re-upload.

import sharp from "sharp";

const HASH_WIDTH = 9; // 9 columns -> 8 horizontal comparisons per row
const HASH_HEIGHT = 8;
const HASH_BITS = (HASH_WIDTH - 1) * HASH_HEIGHT; // 64

// Two independent, real-world-tuned images typically land 25-35 bits
// apart out of 64; near-duplicates (recompressed, lightly cropped, minor
// UI differences from a slightly different moment) usually land under 10.
// Kept conservative (favors false negatives over false positives) since
// this only ever produces an admin nudge, not an automatic block.
export const DUPLICATE_HASH_THRESHOLD = 8;

export async function computeImageHash(buffer: ArrayBuffer): Promise<string | undefined> {
  try {
    const { data } = await sharp(Buffer.from(buffer))
      .resize(HASH_WIDTH, HASH_HEIGHT, { fit: "fill" })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    let bits = "";
    for (let row = 0; row < HASH_HEIGHT; row++) {
      for (let col = 0; col < HASH_WIDTH - 1; col++) {
        const left = data[row * HASH_WIDTH + col];
        const right = data[row * HASH_WIDTH + col + 1];
        bits += left > right ? "1" : "0";
      }
    }
    // Hex-encode the 64-bit string (16 hex chars) so it's compact to store
    // and compare as plain text — no need for a bit-array type in Postgres.
    let hex = "";
    for (let i = 0; i < bits.length; i += 4) {
      hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
    }
    return hex;
  } catch (err) {
    console.error("[Image fingerprint] Failed to compute hash:", err);
    return undefined;
  }
}

export function hammingDistance(hexA: string, hexB: string): number {
  if (hexA.length !== hexB.length) return HASH_BITS; // treat as maximally different
  let distance = 0;
  for (let i = 0; i < hexA.length; i++) {
    const diff = parseInt(hexA[i], 16) ^ parseInt(hexB[i], 16);
    // Count set bits in this nibble (0-15).
    distance += diff.toString(2).split("1").length - 1;
  }
  return distance;
}
