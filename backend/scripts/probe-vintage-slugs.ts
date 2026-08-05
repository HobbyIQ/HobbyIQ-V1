#!/usr/bin/env -S npx tsx
import { computeHobbyIqCardId, normalizeSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service.js";

const cases = [
  { setName: "1997 Skybox Metal Universe", cardNumber: "31", year: 1997, player: "Chipper Jones" },
  { setName: "1997 Fleer", cardNumber: "118", year: 1997, player: "Derek Jeter" },
  { setName: "1996 Fleer Metal Universe", cardNumber: "2", year: 1996, player: "Barry Bonds" },
  { setName: "1992 Studio", cardNumber: "232", year: 1992, player: "Ken Griffey Jr" },
];
for (const c of cases) {
  const setKey = normalizeSetKey(c.setName);
  const slug = computeHobbyIqCardId({
    sport: "baseball",
    year: c.year,
    setKey,
    cardNumber: c.cardNumber,
    parallel: "Base",
    isAuto: false,
  });
  console.log(`${c.setName.padEnd(35)} → setKey=${setKey.padEnd(30)} slug=${slug}`);
}
