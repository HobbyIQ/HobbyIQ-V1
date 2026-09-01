/**
 * collision-triage.cjs -- the PURE rule that classifies one contentHash
 * collision. Extracted so the tests pin the code that actually runs, not a
 * copy of it (the apply-sold-comps-dedup/scoreForCanonical lesson).
 *
 * A "collision" here is exactly what D30's pre-flight counts: two sold_comps
 * rows that hash IDENTICALLY once they sit in the WINNER's cardId partition.
 * The pre-flight can only say how many there are. It cannot say what they ARE,
 * and the eight football shards refused on 278 of them without naming one. A
 * fold cannot be unblocked by a count; it is unblocked by a ruling per group.
 *
 * There are exactly three things a colliding pair can be, and only two of them
 * are provable from the rows themselves:
 *
 *   TRUE-DUPE       the rows share a sourceExternalId -- the eBay item id, and
 *                   half of the doc id `{source}::{sourceExternalId}`. Same
 *                   item id IS the same physical sale, whoever ingested it.
 *                   Exclude the poorer copies; keep the richest.
 *
 *   DISTINCT-CARDS  the external ids differ AND the RAW, pre-normalization
 *                   identity differs on an axis that makes them two cards
 *                   (parallel, cardNumber, grade, isAuto, printRun). The
 *                   retracted trailing-" Refractor" strip is the known cause:
 *                   Topps Finest #197 lists `Uncommon` and `Uncommon Refractor`
 *                   as two checklist cards, and the strip hashed them as one.
 *                   These are RELOCATED to their true slugs (D31), never
 *                   flagged -- deleting or excluding either one loses a sale.
 *
 *   AMBIGUOUS       neither proof holds. The dominant real shape is CardHedge's
 *                   dual ids: `ch-daily::<price_history_id>` and the composed
 *                   `ch-comp::<cardId>::<soldAt>::<cents>` name the same
 *                   listing but share no id, and the composed shape carries no
 *                   listing id to recover -- so no comparison of external ids
 *                   can prove it either way. That case has its OWN lane
 *                   (collapse-ch-dual-ids.cjs, which refuses on parallel/grade
 *                   variance). Here it is reported for a human ruling and
 *                   NEVER auto-acted on.
 *
 * The asymmetry is deliberate. TRUE-DUPE needs POSITIVE proof of sameness
 * (a shared id); DISTINCT-CARDS needs POSITIVE proof of difference (a differing
 * identity axis). Neither is the other's default, so a row we cannot read
 * falls to AMBIGUOUS instead of being collapsed by silence.
 */
"use strict";

/** The identity axes that make two rows two CARDS. Raw fields, read BEFORE any
 *  normalization -- the whole point is to see what normalization collapsed. */
const IDENTITY_AXES = ["parallel", "cardNumber", "gradeCompany", "gradeValue", "isAuto", "printRun"];

const isMissing = (v) => v === null || v === undefined || v === "";
/** Compare raw values the way a human reads them: trimmed, case-insensitively,
 *  and with missing values equal to each other. NOT the hash normalization --
 *  this must see `Uncommon` vs `Uncommon Refractor` as different. */
const rawKey = (v) => (isMissing(v) ? "" : typeof v === "string" ? v.trim().toLowerCase().replace(/\s+/g, " ") : JSON.stringify(v));

/**
 * The external id, trimmed. Returns null when the row has none -- a row with no
 * external id can never PROVE sameness with another, so it can never be a
 * TRUE-DUPE on this rule.
 *
 * Deliberately NOT unwrapped to an inner listing id. CardHedge's two shapes
 * (`ch-daily::<price_history_id>` and `ch-comp::<cardId>::<soldAt>::<cents>`)
 * do not share a listing id to extract -- the composed one has none -- so any
 * "unwrapping" here would be a guess dressed as a proof. Different id = we
 * cannot prove sameness, and the classification says so.
 */
function externalIdOf(row) {
  const raw = row?.sourceExternalId;
  if (isMissing(raw)) return null;
  const s = String(raw).trim();
  return s.length ? s : null;
}

/** Which raw identity axes differ across these rows, with the values, so the
 *  report can NAME the collapsed axis rather than assert one exists. */
function collapsedAxes(rows) {
  const axes = [];
  for (const field of IDENTITY_AXES) {
    const seen = new Map();
    for (const r of rows) {
      const k = rawKey(r?.[field]);
      if (!seen.has(k)) seen.set(k, isMissing(r?.[field]) ? null : r[field]);
    }
    if (seen.size > 1) axes.push({ field, values: [...seen.values()] });
  }
  return axes;
}

/**
 * Richest survivor -- the SAME shape as the pool's own scoreForCanonical, so
 * the triage keeps the row the store would keep. A real external id outranks a
 * synthetic `holding::` stand-in (CF-A-REAL-ID-OUTRANKS-A-SYNTHETIC-ONE); a
 * user-verified row outranks everything; ties fall to the earliest observed,
 * which is the record closest to the sale itself.
 */
const FILL_FIELDS = ["hobbyiqCardId", "playerName", "cardNumber", "parallel", "gradeCompany",
  "gradeValue", "imageUrl", "title", "team", "setName", "cardYear", "sport", "printRun", "normalizedSetKey"];

function richness(row) {
  const prefix = String(row?.sourceExternalId ?? "");
  const prefixScore = prefix.startsWith("holding::") ? 25
    : prefix.startsWith("ch-daily::") ? 50
      : prefix ? 60
        : 0;
  let fill = 0;
  for (const field of FILL_FIELDS) if (!isMissing(row?.[field])) fill++;
  return (row?.verifiedByUser === true ? 100 : 0) + prefixScore + fill;
}

/** The richest row wins; ties break to the EARLIEST observedAt, then to the
 *  lowest id so the choice is deterministic across runs and shards. */
function pickSurvivor(rows) {
  return [...rows].sort((a, b) => {
    const d = richness(b) - richness(a);
    if (d !== 0) return d;
    const ao = a?.observedAt ? Date.parse(a.observedAt) : Number.POSITIVE_INFINITY;
    const bo = b?.observedAt ? Date.parse(b.observedAt) : Number.POSITIVE_INFINITY;
    if (ao !== bo) return ao - bo;
    return String(a?.id ?? "").localeCompare(String(b?.id ?? ""));
  })[0];
}

/**
 * Classify ONE colliding cluster (>= 2 rows that hash identically in the
 * winner's partition).
 *
 * Returns { class, reason, survivor, flag[], relocate[], axes[] }:
 *   TRUE-DUPE       survivor + flag[] (the rows to exclude via flaggedWrong)
 *   DISTINCT-CARDS  relocate[] (rows whose true slug differs) + axes[]
 *   AMBIGUOUS       neither; nothing to act on
 *
 * NOTE the ordering: sameness is tested FIRST and wins. Two rows sharing an
 * external id are one sale even if their parallels disagree -- that is one
 * ingester having mislabelled a parallel, which is a matcher finding, not a
 * licence to keep the sale twice.
 */
function classifyCollision(rows) {
  const list = (rows ?? []).filter(Boolean);
  if (list.length < 2) return { class: "AMBIGUOUS", reason: "fewer-than-two-rows", survivor: null, flag: [], relocate: [], axes: [] };

  // -- proof of SAMENESS: a shared external id -------------------------------
  const byExternal = new Map();
  for (const r of list) {
    const ext = externalIdOf(r);
    if (ext === null) continue;
    const arr = byExternal.get(ext) ?? [];
    arr.push(r);
    byExternal.set(ext, arr);
  }
  const shared = [...byExternal.entries()].filter(([, arr]) => arr.length > 1);
  if (shared.length > 0) {
    // Only the rows that SHARE an id are proven duplicates. A third row in the
    // cluster with its own distinct id is a different sale and is left alone.
    const flag = [];
    let survivor = null;
    for (const [, arr] of shared) {
      const keep = pickSurvivor(arr);
      if (survivor === null) survivor = keep;
      for (const r of arr) if (r !== keep) flag.push(r);
    }
    const sources = [...new Set(shared.flatMap(([, arr]) => arr.map((r) => String(r.source ?? "")))) ];
    return {
      class: "TRUE-DUPE",
      reason: sources.length > 1 ? "shared-sourceExternalId-cross-source" : "shared-sourceExternalId-same-source",
      survivor,
      flag,
      relocate: [],
      axes: [],
      sharedIds: shared.map(([ext]) => ext),
    };
  }

  // -- proof of DIFFERENCE: the raw identity disagrees ------------------------
  // Reached only when NO two rows share an external id.
  const axes = collapsedAxes(list);
  if (axes.length > 0) {
    return {
      class: "DISTINCT-CARDS",
      reason: `distinct-external-ids-and-identity-differs-on-${axes.map((a) => a.field).join("+")}`,
      survivor: null,
      flag: [],
      relocate: list,
      axes,
    };
  }

  // -- neither proof ---------------------------------------------------------
  const missingIds = list.filter((r) => externalIdOf(r) === null).length;
  return {
    class: "AMBIGUOUS",
    reason: missingIds > 0
      ? `no-shared-external-id-and-${missingIds}-row(s)-carry-none`
      : "distinct-external-ids-but-identity-identical",
    survivor: null,
    flag: [],
    relocate: [],
    axes: [],
  };
}

module.exports = { classifyCollision, collapsedAxes, pickSurvivor, richness, externalIdOf, rawKey, IDENTITY_AXES };
