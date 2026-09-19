import { describe, it, expect } from "vitest";
import {
  countriesForRegion,
  EUROPE_COUNTRIES,
  DOMESTIC_COUNTRY,
  hasUnmodelledImportCost,
} from "../src/opportunity/sourceRegion.js";

/**
 * Live distribution on 2026-09-13, all listings:
 *   US 36,508 · GB 9,193 · CA 3,985 · AU 637 · IT 494 · DE 206 · IE 114 ·
 *   FR 81 · NL 39 · SE 35 · DK 35 · JP 28 · SG 25 · CN 24 · NO 15 · …
 *
 * 17% UK. Import duty, VAT and handling are £0 everywhere in this app, so
 * the other 83% understate delivered cost by an unmodelled amount.
 */
describe("which countries a region admits", () => {
  it("gives UK_ONLY exactly the one country with no unmodelled import cost", () => {
    expect(countriesForRegion("UK_ONLY")).toEqual(["GB"]);
  });

  it("puts the UK first in UK_EU and includes the countries actually in the feed", () => {
    const codes = countriesForRegion("UK_EU")!;
    expect(codes[0]).toBe("GB");
    for (const seen of ["IT", "DE", "IE", "FR", "NL", "SE", "DK", "NO", "CZ", "FI", "CH", "ES", "PT", "GR", "RO", "LU", "BE", "SK", "PL", "MT", "AT"]) {
      expect(codes).toContain(seen);
    }
  });

  it("excludes the non-European countries in the feed from UK_EU", () => {
    const codes = countriesForRegion("UK_EU")!;
    for (const outside of ["US", "CA", "AU", "JP", "SG", "CN", "KR", "BR", "CL", "HK", "CR", "AF"]) {
      expect(codes).not.toContain(outside);
    }
  });

  /**
   * Null, not "every country". The caller emits no SQL clause at all for
   * ANY, so the default view is the query it always was — and a country
   * nobody has listed from yet cannot be excluded by an accident of
   * omission from a hardcoded list.
   */
  it("returns null for ANY rather than an all-countries list", () => {
    expect(countriesForRegion("ANY")).toBeNull();
  });

  it("has no duplicates and does not repeat GB inside the Europe set", () => {
    expect(new Set(EUROPE_COUNTRIES).size).toBe(EUROPE_COUNTRIES.length);
    expect(EUROPE_COUNTRIES).not.toContain(DOMESTIC_COUNTRY);
    const uk_eu = countriesForRegion("UK_EU")!;
    expect(new Set(uk_eu).size).toBe(uk_eu.length);
  });
});

describe("which listings carry costs the app does not model", () => {
  it("says only GB is free of them", () => {
    expect(hasUnmodelledImportCost("GB")).toBe(false);
    expect(hasUnmodelledImportCost("US")).toBe(true);
  });

  /**
   * Europe is NOT duty-free for a UK buyer post-Brexit. UK_EU is offered
   * because a European seller is closer and easier to deal with, never
   * because the import cost goes away — and this must not drift into
   * implying otherwise.
   */
  it("still counts European sellers as imports", () => {
    for (const eu of ["IE", "DE", "FR", "IT", "NL"]) {
      expect(hasUnmodelledImportCost(eu)).toBe(true);
    }
  });

  it("treats an unknown country as an import, not as probably local", () => {
    expect(hasUnmodelledImportCost(null)).toBe(true);
    expect(hasUnmodelledImportCost(undefined)).toBe(true);
  });
});
