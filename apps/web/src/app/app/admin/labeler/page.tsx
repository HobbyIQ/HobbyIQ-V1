"use client";

// CF-ADMIN-LABELER-PAGE (Drew, 2026-07-31). Human-in-the-loop variant
// labeling. Loads all CH catalog variants for a card (with images),
// Drew inputs the canonical parallel + print run + refractor flag,
// save writes the label back onto card_catalog + rewrites matching
// sold_comps rows by title-suffix.

import { useEffect, useMemo, useState } from "react";
import {
  fetchLabelerVariants,
  saveLabelerLabel,
  aiSuggestLabel,
  type VariantView,
  type VariantsResponse,
} from "@/lib/adminApi";

const CANONICAL_PARALLELS = [
  "Base",
  "Refractor",
  "Blue Refractor",
  "Green Refractor",
  "Red Refractor",
  "Gold Refractor",
  "Orange Refractor",
  "Purple Refractor",
  "Yellow Refractor",
  "Black Refractor",
  "Aqua Refractor",
  "Mojo Refractor",
  "Speckle Refractor",
  "Blue Wave Refractor",
  "Green Wave Refractor",
  "Gold Wave Refractor",
  "Red Wave Refractor",
  "Blue Shimmer Refractor",
  "Green Shimmer Refractor",
  "Red Shimmer Refractor",
  "Orange Shimmer Refractor",
  "Blue Lava Refractor",
  "Green Lava Refractor",
  "Red Lava Refractor",
  "Aqua Lava Refractor",
  "X-Fractor",
  "Black X-Fractor",
  "Sparkle Refractor",
  "Mini Diamond",
  "Superfractor",
  "1/1",
];

const PRINT_RUN_PRESETS = ["none", "1", "5", "10", "25", "50", "75", "99", "100", "125", "150", "175", "199", "200", "250", "299", "399", "499", "650", "750", "999", "custom"];

export default function LabelerPage() {
  const [cardNumber, setCardNumber] = useState("CPA-JHA");
  const [cardYear, setCardYear] = useState<number | "">(2025);
  const [data, setData] = useState<VariantsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const yr = cardYear === "" ? null : Number(cardYear);
      const r = await fetchLabelerVariants(cardNumber, yr);
      setData(r);
    } catch (e) {
      setError((e as Error)?.message ?? "Failed to load");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, []);

  const totalMatched = useMemo(
    () => (data?.variants ?? []).reduce((s, v) => s + v.matchedSoldCompsCount, 0),
    [data],
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Variant Labeler</h1>
        <p className="text-sm text-[color:var(--color-text-muted)]">
          Look at each CH variant image, input the canonical parallel + print run. Save rewrites all matching sold_comps rows.
        </p>
      </div>

      <div className="flex items-end gap-3 border-b border-[color:var(--color-border)] pb-4">
        <div>
          <label className="block text-xs text-[color:var(--color-text-muted)] mb-1">Card number</label>
          <input
            className="rounded border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-2 py-1 text-sm w-32"
            value={cardNumber}
            onChange={(e) => setCardNumber(e.target.value.toUpperCase())}
          />
        </div>
        <div>
          <label className="block text-xs text-[color:var(--color-text-muted)] mb-1">Year</label>
          <input
            type="number"
            className="rounded border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-2 py-1 text-sm w-24"
            value={cardYear}
            onChange={(e) => setCardYear(e.target.value === "" ? "" : Number(e.target.value))}
          />
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading || !cardNumber.trim()}
          className="rounded bg-[color:var(--color-accent)] text-[color:var(--color-accent-fg)] px-4 py-1 text-sm font-medium disabled:opacity-50"
        >
          {loading ? "Loading…" : "Load"}
        </button>
      </div>

      {error && <div className="text-sm text-red-500">Error: {error}</div>}

      {data && (
        <div className="space-y-4">
          <div className="text-sm text-[color:var(--color-text-muted)]">
            Player: <strong className="text-[color:var(--color-text)]">{data.player || "—"}</strong>
            {" · "}{data.variants.length} CH variants
            {" · "}{totalMatched} sold_comps rows matched by title
            {" · "}{data.unmatchedSoldCompsCount} rows not matched (marketplace titles)
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {data.variants.map((v) => (
              <VariantCard
                key={v.cardCatalogId}
                variant={v}
                cardNumber={data.cardNumber}
                cardYear={data.cardYear ?? Number(cardYear)}
                playerName={data.player}
                onSaved={() => void load()}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function inferSet(_v: VariantView, dataSet: string | undefined): string {
  return dataSet ?? "";
}

function VariantCard({
  variant,
  cardNumber,
  cardYear,
  playerName,
  onSaved,
}: {
  variant: VariantView;
  cardNumber: string;
  cardYear: number;
  playerName: string;
  onSaved: () => void;
}) {
  const initial = variant.currentLabel;
  const [parallel, setParallel] = useState(initial?.parallel ?? guessParallel(variant.chVariant));
  const [isRefractor, setIsRefractor] = useState(initial?.isRefractor ?? guessIsRefractor(variant.chVariant));
  const [printRunPreset, setPrintRunPreset] = useState<string>(() => {
    if (!initial?.printRun) return "none";
    return PRINT_RUN_PRESETS.includes(String(initial.printRun)) ? String(initial.printRun) : "custom";
  });
  const [customPrintRun, setCustomPrintRun] = useState<string>(
    initial?.printRun && !PRINT_RUN_PRESETS.includes(String(initial.printRun)) ? String(initial.printRun) : "",
  );
  const [customParallel, setCustomParallel] = useState("");
  const [saving, setSaving] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiHint, setAiHint] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const requestAiSuggest = async () => {
    setAiLoading(true);
    setAiHint(null);
    try {
      const s = await aiSuggestLabel({
        chVariant: variant.chVariant,
        set: variant.set,
        cardNumber,
        cardYear,
        playerName,
        imageUrl: variant.imageUrl,
        currentGuess: parallel,
      });
      if (CANONICAL_PARALLELS.includes(s.parallel)) setParallel(s.parallel);
      else setCustomParallel(s.parallel);
      if (s.printRun) {
        setPrintRunPreset(PRINT_RUN_PRESETS.includes(String(s.printRun)) ? String(s.printRun) : "custom");
        if (!PRINT_RUN_PRESETS.includes(String(s.printRun))) setCustomPrintRun(String(s.printRun));
      } else {
        setPrintRunPreset("none");
      }
      setIsRefractor(s.isRefractor);
      setAiHint(`AI (${s.confidence}${s.usedImage ? " · saw image" : ""}): ${s.reasoning.slice(0, 80)}`);
    } catch (e) {
      setAiHint("AI error: " + ((e as Error)?.message ?? "unknown"));
    } finally {
      setAiLoading(false);
    }
  };

  const effectiveParallel = customParallel.trim() || parallel;

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const r = await saveLabelerLabel({
        cardCatalogId: variant.cardCatalogId,
        cardNumber,
        cardYear,
        set: variant.set,
        chVariant: variant.chVariant,
        canonicalParallel: effectiveParallel,
        isRefractor,
        printRun:
          printRunPreset === "none"
            ? null
            : printRunPreset === "custom"
              ? (customPrintRun.trim() ? Number(customPrintRun.trim()) : null)
              : Number(printRunPreset),
        labeledBy: "drew",
        applyToSoldComps: true,
      });
      setMsg(`Saved · ${r.soldCompsRewritten} rows rewritten · ${r.newSlugSample}`);
      onSaved();
    } catch (e) {
      setMsg("Error: " + ((e as Error)?.message ?? "unknown"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl border border-[color:var(--color-border)] bg-[color:var(--color-surface)] p-3 flex flex-col gap-3">
      <div className="flex gap-3">
        <div className="w-24 h-32 shrink-0 rounded overflow-hidden bg-[color:var(--color-surface-2)] flex items-center justify-center text-[10px] text-[color:var(--color-text-muted)]">
          {variant.imageUrl ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img src={variant.imageUrl} alt={variant.chVariant} className="w-full h-full object-contain" />
          ) : (
            "no image"
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-sm">{variant.chVariant || "(no variant)"}</div>
          <div className="text-xs text-[color:var(--color-text-muted)]">{inferSet(variant, variant.set)}</div>
          <div className="text-xs mt-1">
            <span className="inline-block px-1.5 py-0.5 rounded bg-[color:var(--color-surface-2)]">
              {variant.matchedSoldCompsCount} sold_comps match
            </span>
          </div>
          {variant.currentLabel && (
            <div className="text-[11px] mt-1 text-emerald-500">
              labeled: {variant.currentLabel.parallel}
              {variant.currentLabel.printRun ? ` /${variant.currentLabel.printRun}` : ""}
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-[10px] text-[color:var(--color-text-muted)] mb-0.5">Canonical parallel</label>
          <select
            className="w-full rounded border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-2 py-1 text-xs"
            value={parallel}
            onChange={(e) => setParallel(e.target.value)}
          >
            {CANONICAL_PARALLELS.map((p) => (<option key={p} value={p}>{p}</option>))}
          </select>
        </div>
        <div>
          <label className="block text-[10px] text-[color:var(--color-text-muted)] mb-0.5">Print run</label>
          <select
            className="w-full rounded border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-2 py-1 text-xs"
            value={printRunPreset}
            onChange={(e) => setPrintRunPreset(e.target.value)}
          >
            {PRINT_RUN_PRESETS.map((p) => (
              <option key={p} value={p}>
                {p === "none" ? "unnumbered" : p === "custom" ? "custom…" : `/${p}`}
              </option>
            ))}
          </select>
          {printRunPreset === "custom" && (
            <input
              type="number"
              min={1}
              className="mt-1 w-full rounded border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-2 py-1 text-xs"
              placeholder="e.g. 125"
              value={customPrintRun}
              onChange={(e) => setCustomPrintRun(e.target.value)}
            />
          )}
        </div>
      </div>

      <div>
        <label className="block text-[10px] text-[color:var(--color-text-muted)] mb-0.5">Custom parallel (overrides dropdown)</label>
        <input
          className="w-full rounded border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-2 py-1 text-xs"
          placeholder="e.g. Ice Refractor"
          value={customParallel}
          onChange={(e) => setCustomParallel(e.target.value)}
        />
      </div>

      <div className="flex items-center gap-2">
        <label className="flex items-center gap-1 text-xs">
          <input type="checkbox" checked={isRefractor} onChange={(e) => setIsRefractor(e.target.checked)} />
          is refractor
        </label>
        <button
          type="button"
          onClick={() => void requestAiSuggest()}
          disabled={aiLoading}
          className="rounded border border-[color:var(--color-border)] px-2 py-1 text-[11px] disabled:opacity-50"
          title="Ask AI to pre-fill parallel + print run"
        >
          {aiLoading ? "AI…" : "✨ AI suggest"}
        </button>
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || !effectiveParallel.trim()}
          className="ml-auto rounded bg-[color:var(--color-accent)] text-[color:var(--color-accent-fg)] px-3 py-1 text-xs font-medium disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save + rewrite"}
        </button>
      </div>

      {aiHint && <div className="text-[11px] text-[color:var(--color-accent)] break-all">{aiHint}</div>}
      {msg && <div className="text-[11px] text-[color:var(--color-text-muted)] break-all">{msg}</div>}
    </div>
  );
}

function guessParallel(chVariant: string): string {
  const v = chVariant.toLowerCase();
  if (v === "base") return "Base";
  if (v === "refractor") return "Refractor";
  if (v === "superfractor") return "Superfractor";
  if (v.includes("x-fractor") || v === "xfractor") return "X-Fractor";
  const hit = CANONICAL_PARALLELS.find(p => p.toLowerCase() === v);
  if (hit) return hit;
  const colorMatch = CANONICAL_PARALLELS.find(p => p.toLowerCase() === `${v} refractor`);
  if (colorMatch) return colorMatch;
  return "Refractor";
}

function guessIsRefractor(chVariant: string): boolean {
  const v = chVariant.toLowerCase();
  if (v === "base" || v === "sunflower seeds" || v === "pop corn" || v === "peanuts" || v === "gum ball") return false;
  return true;
}
