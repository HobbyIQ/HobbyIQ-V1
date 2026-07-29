#!/usr/bin/env -S node --experimental-strip-types
// Find the most common tokens in titles where the parser returned "Base"
// but the title suggests a specific parallel. Prioritize what to add.
import { CosmosClient } from "@azure/cosmos";
(async () => {
  const c = new CosmosClient(process.env.COSMOS_CONNECTION_STRING!);
  const q = c.database("hobbyiq").container("verify_queue");
  const { resources } = await q.items.query({
    query: "SELECT TOP 200 c.input.title, c.input.parallel FROM c WHERE c.reason = 'image-mismatch' AND c.status = 'pending' AND c.input.sport = 'baseball'",
  }).fetchAll();
  console.log(`▸ ${resources.length} sampled baseball rows`);
  console.log(`\n▸ Titles where stored parallel = 'base' but title has parallel-hint words:\n`);
  const patterns = new Map<string, number>();
  const KNOWN_HINTS = /\b(wave|geometric|lava|shimmer|reptilian|ink|lazer|gum ball|logo|mojo|prism|speckle|fuchsia|x-?fractor|choice|velocity|pandora|ray wave|raywave|foil|holo|prizm|sepia|neon|hyper|mini diamond|sky blue|light blue|rose gold|gold wave|blue foil|red foil|yellow foil|pulsar|zebra|sunflower|peanuts|popcorn|silver|prism ?refractor)\b/i;
  const missCount = new Map<string, number>();
  for (const r of resources as Array<{ title: string; parallel: string }>) {
    if (String(r.parallel).toLowerCase() !== "base") continue;
    const t = String(r.title ?? "");
    const m = t.match(KNOWN_HINTS);
    if (m) {
      const hit = m[0].toLowerCase();
      missCount.set(hit, (missCount.get(hit) ?? 0) + 1);
    }
  }
  console.log("token pattern → count (top 20):");
  for (const [k, v] of [...missCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    console.log(`  ${k.padEnd(20)} ${v}`);
  }
})();
