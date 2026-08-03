#!/usr/bin/env -S npx tsx
import { parseGradeLabel } from "../src/services/portfolioiq/gradeParser.js";
const TITLES = [
  "2025 BOWMAN DRAFT CHROME #BDC-1 ELI WILLITS PSA 7",
  "2024 Panini Prizm Victor Wembanyama Rookie PSA 10 GEM MT",
  "Bowman Chrome Prospect Auto Hartman #CPA-EHA PSA 9",
  "1993 Fleer #7 Michael Jordan BGS 9.5",
  "2025 Topps Series 2 #300 SGC 10",
  "2025 Bowman Draft Chrome #BDC-1 Eli Willits Raw",
  "2024 Bowman Chrome Ohtani PSA 10 GEM MINT",
  "2025 Topps Chrome Judge #400 PSA-10",
];
for (const t of TITLES) {
  const r = parseGradeLabel(t);
  console.log(`  "${t.slice(0, 65).padEnd(65)}" → ${r ? `${r.gradeCompany} ${r.gradeValue}${r.qualifier ? " " + r.qualifier : ""}` : "null"}`);
}
