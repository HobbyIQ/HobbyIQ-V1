// Unit tests for detectInsertStatus — schema §5.6 (issue #33 Phase 2b-i).

import { describe, expect, it } from "vitest";
import { detectInsertStatus } from "../../src/services/parallelsReference/ingestion.js";

describe("detectInsertStatus", () => {
  it("treats pure numeric `number` as main set", () => {
    expect(detectInsertStatus({ set: "2024 Bowman Chrome Baseball", number: "31" })).toEqual({
      isInsert: false,
      insertPrefix: null,
    });
    expect(detectInsertStatus({ set: "2024 Bowman Chrome Baseball", number: "1" })).toEqual({
      isInsert: false,
      insertPrefix: null,
    });
  });

  it("captures alphabetic prefix when `number` has letters-hyphen-suffix", () => {
    expect(detectInsertStatus({ number: "BC25-18" })).toEqual({
      isInsert: true,
      insertPrefix: "BC25",
    });
    expect(detectInsertStatus({ number: "GOTD-10" })).toEqual({
      isInsert: true,
      insertPrefix: "GOTD",
    });
    expect(detectInsertStatus({ number: "OOG-5" })).toEqual({
      isInsert: true,
      insertPrefix: "OOG",
    });
    expect(detectInsertStatus({ number: "M1B-36" })).toEqual({
      isInsert: true,
      insertPrefix: "M1B",
    });
  });

  it("uppercases lowercased alphabetic prefixes", () => {
    expect(detectInsertStatus({ number: "bc25-18" })).toEqual({
      isInsert: true,
      insertPrefix: "BC25",
    });
  });

  it("treats pure alphabetic `number` as insert with the whole token as prefix", () => {
    expect(detectInsertStatus({ number: "PS" })).toEqual({
      isInsert: true,
      insertPrefix: "PS",
    });
  });

  it("handles compound prefixes ending with a letter (e.g. GDA-PS)", () => {
    expect(detectInsertStatus({ number: "GDA-PS" })).toEqual({
      isInsert: true,
      insertPrefix: "GDA",
    });
  });

  it("defensively quarantines numbers that start with a digit but contain a hyphen", () => {
    expect(detectInsertStatus({ number: "31-2" })).toEqual({
      isInsert: true,
      insertPrefix: null,
    });
  });

  it("defensively quarantines empty / missing numbers", () => {
    expect(detectInsertStatus({ number: "" })).toEqual({
      isInsert: true,
      insertPrefix: null,
    });
    expect(detectInsertStatus({ number: null })).toEqual({
      isInsert: true,
      insertPrefix: null,
    });
    expect(detectInsertStatus({})).toEqual({
      isInsert: true,
      insertPrefix: null,
    });
  });

  it("honors a CH-supplied insert-namespaced set (` - ` separator) regardless of number", () => {
    expect(
      detectInsertStatus({
        set: "2024 Bowman Chrome Baseball - Bowman Chrome 25th Anniversary",
        number: "18",
      })
    ).toEqual({ isInsert: true, insertPrefix: null });
  });

  it("treats trailing-letter numeric variants (e.g. `31A`) as main-set", () => {
    expect(detectInsertStatus({ number: "31A" })).toEqual({
      isInsert: false,
      insertPrefix: null,
    });
  });
});
