/**
 * M3 + M7 + M8 — Card-level deterministic modifiers (TypeScript mirror of
 * compiq-functions/shared/card_modifiers.py).
 *
 * These modifiers are computed from the card's static attributes and
 * surfaced in the MCP pricing prompt so the model sees them explicitly
 * alongside live signals. They are NOT applied automatically to the
 * predicted price — the model uses them as guidance against the ±15-50%
 * card-level pricing weight bands documented in copilot-instructions.md.
 */

// M8 — Grade premium / spread
const GRADE_MULTIPLIERS: Record<string, number> = {
  "BGS 10": 1.95,
  "PSA 10": 1.45,
  "BGS 9.5": 1.40,
  "SGC 10": 1.35,
  "PSA 9": 1.18,
  "BGS 9": 1.15,
  "PSA 8": 1.05,
  raw: 1.0,
};

// M7 — Iconic jersey-number premium
const ICONIC_NUMBERS: Record<number, { name: string; mult: number }> = {
  2: { name: "Jeter", mult: 1.04 },
  7: { name: "Mantle", mult: 1.05 },
  17: { name: "Ohtani", mult: 1.04 },
  23: { name: "Jordan", mult: 1.05 },
  27: { name: "Trout", mult: 1.04 },
  42: { name: "Robinson", mult: 1.05 },
  44: { name: "Aaron", mult: 1.04 },
};

export function rookieYearModifier(
  cardYear: number,
  isRookie: boolean,
  now: Date = new Date()
): number {
  if (!isRookie) return 1.0;
  const age = now.getFullYear() - cardYear;
  if (age <= 0) return 1.18;
  if (age === 1) return 1.10;
  if (age === 2) return 1.04;
  return 1.0;
}

export function gradeSpreadModifier(grade?: string): number {
  if (!grade) return 1.0;
  return GRADE_MULTIPLIERS[grade.trim()] ?? 1.0;
}

export function jerseyNumberModifier(num?: number): {
  multiplier: number;
  iconName: string | null;
} {
  if (!num) return { multiplier: 1.0, iconName: null };
  const hit = ICONIC_NUMBERS[num];
  if (!hit) return { multiplier: 1.0, iconName: null };
  return { multiplier: hit.mult, iconName: hit.name };
}

export function printRunModifier(printRun?: number): number {
  if (!printRun) return 1.0;
  if (printRun <= 25) return 1.50;
  if (printRun <= 100) return 1.25;
  if (printRun <= 250) return 1.12;
  return 1.0;
}

export interface CardModifierBreakdown {
  rookie_year: number;
  grade: number;
  jersey: number;
  jersey_icon: string | null;
  print_run: number;
  combined: number; // clamped 0.70–1.50
}

export function combinedCardModifiers(args: {
  cardYear: number;
  isRookie: boolean;
  grade?: string;
  jerseyNumber?: number;
  printRun?: number;
  now?: Date;
}): CardModifierBreakdown {
  const rookie = rookieYearModifier(args.cardYear, args.isRookie, args.now);
  const gradeM = gradeSpreadModifier(args.grade);
  const jersey = jerseyNumberModifier(args.jerseyNumber);
  const print = printRunModifier(args.printRun);
  const raw = rookie * gradeM * jersey.multiplier * print;
  const combined = Math.max(0.70, Math.min(1.50, raw));
  return {
    rookie_year: rookie,
    grade: gradeM,
    jersey: jersey.multiplier,
    jersey_icon: jersey.iconName,
    print_run: print,
    combined: Math.round(combined * 1000) / 1000,
  };
}
