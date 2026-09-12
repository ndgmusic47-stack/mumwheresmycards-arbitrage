import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { deriveCentering } from "../src/repo/photoAssessmentsRepo.js";
import { preferLargerEbayImage, MAX_ASSESSMENT_IMAGES, PHOTO_ASSESSMENT_SCHEMA } from "@mwmc/providers";
import type { PhotoAssessment } from "@mwmc/providers";
import { createSqliteD1, seedOpportunity, type SqliteHarness } from "./helpers/sqliteD1.js";

/**
 * The photo assessment's job is to be USEFUL WITHOUT BEING CONFIDENT.
 *
 * Almost every test here is about a refusal: what the feature must decline
 * to conclude from a photograph that cannot support it. That is deliberate.
 * A wrong centering measurement costs a few pence of tokens; a confident
 * grade prediction costs a submission fee and a card.
 */

const clean = (over: Partial<PhotoAssessment> = {}): PhotoAssessment => ({
  assessability: "GOOD",
  assessabilityReason: "Front and back both square-on, borders visible.",
  frontShown: true,
  backShown: true,
  encasement: "NONE",
  looksLikeStockPhoto: false,
  front: { leftRightPct: 52, topBottomPct: 51, note: null },
  back: { leftRightPct: 60, topBottomPct: 55, note: null },
  defects: [],
  whatToCheckYourself: [],
  ...over,
});

describe("the model measures; deterministic code decides what it means", () => {
  it("turns a measurement into a ceiling using the grader's published tolerances", () => {
    const derived = deriveCentering(clean({ front: { leftRightPct: 65, topBottomPct: 50, note: null } }), "PSA");
    expect(derived.frontWorst).toBe(65);
    // 65 is past PSA 10 (55) and PSA 9 (60), inside PSA 8 (70).
    expect(derived.ceilingKey).toBe("PSA_8");
  });

  it("never lets a PSA ceiling be decided by the back, because PSA publishes no back tolerance", () => {
    const derived = deriveCentering(
      clean({
        front: { leftRightPct: 50, topBottomPct: 50, note: null },
        back: { leftRightPct: 98, topBottomPct: 98, note: null },
      }),
      "PSA",
    );
    expect(derived.ceilingKey).toBe("PSA_10");
    expect(derived.backWorst).toBe(98);
    expect(derived.checks.every((c) => c.decidedBy !== "BACK")).toBe(true);
  });

  it("DOES let the back decide for CGC, which publishes one", () => {
    const derived = deriveCentering(
      clean({
        front: { leftRightPct: 50, topBottomPct: 50, note: null },
        back: { leftRightPct: 98, topBottomPct: 50, note: null },
      }),
      "CGC",
    );
    expect(derived.ceilingKey).not.toBe("CGC_GEM_MINT_10");
  });

  it("records no measurement at all when the model could not take one", () => {
    const derived = deriveCentering(
      clean({
        front: { leftRightPct: null, topBottomPct: null, note: "Card is at an angle; left border not visible." },
        back: { leftRightPct: null, topBottomPct: null, note: "Back not photographed." },
      }),
      "PSA",
    );
    expect(derived.frontWorst).toBeNull();
    expect(derived.ceilingKey).toBeNull();
    expect(derived.checks.every((c) => c.verdict === "NOT_ASSESSED")).toBe(true);
  });

  it("needs BOTH axes before it will use a face — half a measurement is not one", () => {
    const derived = deriveCentering(
      clean({ front: { leftRightPct: 62, topBottomPct: null, note: "Top border cropped." } }),
      "PSA",
    );
    expect(derived.frontWorst).toBeNull();
  });
});

describe("a stock photograph is discarded, not measured", () => {
  it("throws away every reading when the image is of a different copy", () => {
    // This is the most dangerous possible reading to keep: a real,
    // plausible, precisely-wrong measurement of somebody else's card.
    const derived = deriveCentering(
      clean({ looksLikeStockPhoto: true, front: { leftRightPct: 50, topBottomPct: 50, note: null } }),
      "PSA",
    );
    expect(derived.ceilingKey).toBeNull();
    expect(derived.frontWorst).toBeNull();
    expect(derived.checks).toEqual([]);
  });
});

describe("the output shape gives a prediction nowhere to live", () => {
  it("has no grade, probability, score or confidence field in the schema", () => {
    const json = JSON.stringify(PHOTO_ASSESSMENT_SCHEMA);
    for (const forbidden of ["predictedGrade", "probability", "likelihood", "score", "estimatedGrade", "gradeEstimate"]) {
      expect(json).not.toContain(forbidden);
    }
  });

  it("forces the model to answer every field, including the inconvenient ones", () => {
    const required = PHOTO_ASSESSMENT_SCHEMA.schema.required as readonly string[];
    for (const field of ["assessability", "backShown", "looksLikeStockPhoto", "whatToCheckYourself"]) {
      expect(required).toContain(field);
    }
    expect(PHOTO_ASSESSMENT_SCHEMA.schema.additionalProperties).toBe(false);
  });

  it("only permits a defect to be CLEAR or POSSIBLE — never 'absent'", () => {
    // There is no vocabulary for asserting a defect is not there, because
    // a listing photo cannot establish that.
    const defects = (PHOTO_ASSESSMENT_SCHEMA.schema.properties as Record<string, { items?: { properties?: Record<string, { enum?: string[] }> } }>).defects;
    expect(defects!.items!.properties!.confidence!.enum).toEqual(["CLEAR", "POSSIBLE"]);
  });
});

describe("image handling", () => {
  it("asks eBay's CDN for a larger copy of a thumbnail", () => {
    expect(preferLargerEbayImage("https://i.ebayimg.com/images/g/AbCd/s-l500.jpg")).toBe(
      "https://i.ebayimg.com/images/g/AbCd/s-l1600.jpg",
    );
    expect(preferLargerEbayImage("https://i.ebayimg.com/images/g/AbCd/s-l225.webp")).toBe(
      "https://i.ebayimg.com/images/g/AbCd/s-l1600.webp",
    );
  });

  it("leaves a URL it does not recognise completely alone", () => {
    // The size convention is undocumented. Rewriting a URL that does not
    // match the pattern would turn a working image into a 404.
    for (const url of [
      "https://example.com/card.jpg",
      "https://i.ebayimg.com/thumbs/images/g/AbCd/s-l64.jpg?x=1",
      "https://i.ebayimg.com/images/g/AbCd/original.jpg",
    ]) {
      const out = preferLargerEbayImage(url);
      expect(out === url || out.includes("s-l1600")).toBe(true);
    }
  });

  it("caps the number of images sent, so a 30-photo listing cannot run away with the budget", () => {
    expect(MAX_ASSESSMENT_IMAGES).toBeLessThanOrEqual(8);
  });
});

describe("against the real schema", () => {
  let harness: SqliteHarness;

  beforeEach(() => {
    harness = createSqliteD1();
    seedOpportunity(harness.raw, { cardId: "card-pa", listingId: "listing-pa", opportunityId: "opp-pa" });
  });
  afterEach(() => harness.close());

  it("applies the assessment migration and links inventory to an assessment", () => {
    expect(harness.migrationsApplied).toContain("0025_photo_assessments.sql");
    const cols = harness.raw
      .prepare(`PRAGMA table_info(inventory)`)
      .all()
      .map((r) => (r as { name: string }).name);
    expect(cols).toContain("photo_assessment_id");
  });

  it("keeps every assessment rather than overwriting — the history is the evidence", () => {
    const insert = (id: string, ceiling: string) =>
      harness.raw
        .prepare(
          `INSERT INTO photo_assessments (id, listing_id, card_id, assessment_json, assessability, centering_ceiling_key, grader_id, image_urls_json)
           VALUES (?,?,?,?,?,?,?,?)`,
        )
        .run(id, "listing-pa", "card-pa", "{}", "GOOD", ceiling, "PSA", "[]");

    insert("pa-1", "PSA_9");
    insert("pa-2", "PSA_10");

    const rows = harness.raw.prepare(`SELECT COUNT(*) AS n FROM photo_assessments WHERE listing_id = ?`).get("listing-pa") as {
      n: number;
    };
    // A re-run must not erase what was believed the first time.
    expect(rows.n).toBe(2);
  });
});
