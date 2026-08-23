// CF-CARD-COLOUR-HUE (Drew, 2026-08-18: "we need to find the color and fix
// that ... let's do the colour hue too").
//
// Infers a card's parallel COLOUR from its image, for the case where no text
// source has it.
//
// WHY THIS HAS TO EXIST. The Marconi German QR04 auto is a GOLD parallel and
// the word "gold" appears NOWHERE that a parser can reach:
//
//   title       "2026 Bowman Chrome Marconi German #QR04"
//   eBay aspect Parallel/Variety: "Chrome"        (seller typed the product)
//   description auto-generated FROM those aspects, so it launders the same error
//   Azure OCR   B / Chrome / BOWMAN / TOPPS CERTIFIED / AUTOGRAPH ISSUE /
//               SHORTSTOP / WASHINGTON NATIONALS / MARCONI GERMAN
//
// OCR reads TEXT. A gold parallel does not print the word "gold" — the colour
// IS the foil border. So text recovery is exhausted by construction, and the
// only remaining signal is the pixels.
//
// HOW. Chrome-stock parallels colour the BORDER while the photo in the middle
// is the player. So this samples a frame around the edge, ignores the centre
// entirely, and asks what hue dominates. Greys and near-blacks are dropped as
// unsaturated so a plain chrome/white border cannot masquerade as a colour.
//
// IT RETURNS A CANDIDATE, NOT A VERDICT. Card images are photographed under
// arbitrary lighting, often in a slab, sometimes at an angle, and gold vs
// yellow vs orange sit within a few degrees of each other. So this reports a
// hue, a confidence, and the runner-up, and callers must treat a low-confidence
// answer as "ask a human" rather than writing it. That is the whole lesson of
// 2026-08-18: a confidently wrong parallel is worse than an absent one.

import sharp from "sharp";

export interface ColourHueResult {
  /** Best-guess colour name, or null when nothing is confidently coloured. */
  colour: string | null;
  /** 0..1 — share of sampled border pixels agreeing with `colour`. */
  confidence: number;
  /** Second place, so a caller can see how close the call was. */
  runnerUp: string | null;
  /** Fraction of border pixels that carried ANY saturated colour. */
  saturatedShare: number;
  /** Populated when the image could not be read. */
  error?: string;
}

/** Hue buckets in degrees, plus the achromatic cases handled separately.
 *  Ranges are deliberately wide — this is a candidate generator. */
const HUE_BUCKETS: ReadonlyArray<{ name: string; from: number; to: number }> = [
  { name: "red", from: 345, to: 360 },
  { name: "red", from: 0, to: 12 },
  { name: "orange", from: 12, to: 38 },
  { name: "gold", from: 38, to: 56 },
  { name: "yellow", from: 56, to: 70 },
  { name: "green", from: 70, to: 165 },
  { name: "aqua", from: 165, to: 195 },
  { name: "blue", from: 195, to: 255 },
  { name: "purple", from: 255, to: 290 },
  { name: "pink", from: 290, to: 345 },
];

function hueName(h: number): string | null {
  for (const b of HUE_BUCKETS) if (h >= b.from && h < b.to) return b.name;
  return null;
}

/** RGB -> HSV hue/sat/val. Hue in degrees, sat/val 0..1. */
function toHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = 60 * (((gn - bn) / d) % 6);
    else if (max === gn) h = 60 * ((bn - rn) / d + 2);
    else h = 60 * ((rn - gn) / d + 4);
  }
  if (h < 0) h += 360;
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

export interface ColourHueOptions {
  /** Border thickness sampled, as a fraction of the shorter side. */
  borderFraction?: number;
  /** Minimum HSV saturation for a pixel to count as coloured at all. */
  minSaturation?: number;
  /** Reject near-black (slab shadow) and blown-out white. */
  minValue?: number;
  maxValue?: number;
}

/**
 * Read the dominant border hue of a card image.
 *
 * Never throws — an unreadable image returns { colour: null, error }.
 */
export async function detectCardColourHue(
  image: Buffer,
  opts: ColourHueOptions = {},
): Promise<ColourHueResult> {
  const borderFraction = opts.borderFraction ?? 0.12;
  const minSaturation = opts.minSaturation ?? 0.35;
  const minValue = opts.minValue ?? 0.20;
  const maxValue = opts.maxValue ?? 0.98;

  try {
    // Downscale first: this is a hue histogram, not a detail task, and a small
    // raster keeps it cheap enough to run per-holding.
    const { data, info } = await sharp(image)
      .resize(200, 280, { fit: "fill" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { width, height, channels } = info;
    const bx = Math.max(1, Math.round(Math.min(width, height) * borderFraction));

    const counts = new Map<string, number>();
    let sampled = 0, saturated = 0;

    for (let y = 0; y < height; y++) {
      const inVerticalBorder = y < bx || y >= height - bx;
      for (let x = 0; x < width; x++) {
        // Only the frame — the middle is the player photo and would swamp
        // the histogram with skin, jersey and crowd.
        if (!inVerticalBorder && x >= bx && x < width - bx) continue;
        const i = (y * width + x) * channels;
        const { h, s, v } = toHsv(data[i], data[i + 1], data[i + 2]);
        sampled++;
        if (s < minSaturation || v < minValue || v > maxValue) continue;
        saturated++;
        const name = hueName(h);
        if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }

    if (saturated === 0 || counts.size === 0) {
      return {
        colour: null,
        confidence: 0,
        runnerUp: null,
        saturatedShare: sampled ? saturated / sampled : 0,
      };
    }

    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const total = ranked.reduce((s, [, n]) => s + n, 0);
    return {
      colour: ranked[0][0],
      confidence: ranked[0][1] / total,
      runnerUp: ranked[1]?.[0] ?? null,
      saturatedShare: sampled ? saturated / sampled : 0,
    };
  } catch (err) {
    return {
      colour: null,
      confidence: 0,
      runnerUp: null,
      saturatedShare: 0,
      error: String((err as Error)?.message ?? err).slice(0, 200),
    };
  }
}

/** Fetch + detect. Separated so tests can drive the pure function with a buffer. */
export async function detectCardColourHueFromUrl(
  url: string,
  opts: ColourHueOptions = {},
): Promise<ColourHueResult> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) {
      return { colour: null, confidence: 0, runnerUp: null, saturatedShare: 0, error: `HTTP ${res.status}` };
    }
    return await detectCardColourHue(Buffer.from(await res.arrayBuffer()), opts);
  } catch (err) {
    return {
      colour: null, confidence: 0, runnerUp: null, saturatedShare: 0,
      error: String((err as Error)?.message ?? err).slice(0, 200),
    };
  }
}
