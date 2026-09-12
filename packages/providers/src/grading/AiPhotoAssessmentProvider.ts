import type { AiModelProvider, AiCompletionImageInput } from "../ai/AiModelProvider.js";
import { definePromptTemplate, buildAiRequest } from "../ai/promptVersioning.js";

/**
 * PRE-GRADE PHOTO ASSESSMENT — what the seller's own listing photographs
 * can and cannot establish about how a card would grade.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS RETURNS EVIDENCE AND NOT A PREDICTED GRADE
 *
 * The obvious version of this feature outputs "78% chance of PSA 9". That
 * number cannot be honestly produced here, and shipping it would be the
 * single most damaging thing this system could do, because it multiplies
 * straight into every profit figure the deal desk shows.
 *
 * A calibrated probability requires a labelled dataset: photographs paired
 * with the grade the card ACTUALLY came back as, in the hundreds at minimum,
 * from the same photo conditions you are predicting on. This project has
 * none. A model asked for a percentage will nonetheless produce one, fluent
 * and specific and unfounded, and its confidence will bear no relationship
 * to its accuracy.
 *
 * WHAT THE APPS THAT DO THIS HAVE, AND WE DO NOT. Consumer pre-grade apps
 * and machine graders work from controlled captures: known lighting, a
 * fixed distance, both faces, macro focus, often backlighting for centering,
 * and the ability to demand a retake. An eBay listing photograph is none of
 * those. It is whatever the seller uploaded — frequently one front-facing
 * thumbnail, often through a sleeve or toploader, often with holo glare
 * across the area you most need to see, sometimes a stock image of a
 * different copy entirely.
 *
 * So the honest output has three parts, and they are ordered by how much
 * they can be trusted:
 *
 *  1. CENTERING, measured. Geometry, from border widths, checkable against
 *     tolerances the graders themselves publish. This can rule grades OUT
 *     with evidence. It is the only quantitative thing here.
 *
 *  2. VISIBLE DEFECTS, asymmetrically. "I can see whitening on the bottom-
 *     right corner" is informative. "I cannot see whitening" is nearly
 *     worthless at listing-photo resolution, and is reported as
 *     not-assessable rather than as clean. Absence of evidence is recorded
 *     as absence of evidence.
 *
 *  3. ASSESSABILITY. Whether these photographs could support a judgement at
 *     all — is the back shown, is there glare, is it a stock image, is it
 *     in a sleeve, is it square-on. This is the part that protects the
 *     operator, and it is deliberately the first thing the schema asks for.
 *
 * HOW THIS EARNS THE RIGHT TO A PROBABILITY LATER. Every assessment is
 * stored. The pipeline already records what each card actually graded. Once
 * enough assessments have a real returned grade against them, the tool can
 * report its OWN measured hit rate — "of the 40 cards I called centering-
 * clear for a 10, 12 came back 10" — which is a calibration statement
 * earned from this operator's own submissions rather than a number invented
 * on day one. That is a reporting feature over accumulated data, not a
 * model capability, and it cannot be shortcut.
 * ─────────────────────────────────────────────────────────────────────────
 */

export type PhotoAssessability = "GOOD" | "LIMITED" | "UNUSABLE";
export type DefectConfidence = "CLEAR" | "POSSIBLE";

export interface PhotoCenteringReading {
  /** Larger share, 50-100. null when it could not be measured from these photos. */
  leftRightPct: number | null;
  topBottomPct: number | null;
  /** Why it could not be measured, when it could not. */
  note: string | null;
}

export interface VisibleDefect {
  /** corner / edge / surface / centering / print / other */
  area: string;
  description: string;
  confidence: DefectConfidence;
}

export interface PhotoAssessment {
  assessability: PhotoAssessability;
  /** Plain statement of what these photos do and do not permit. */
  assessabilityReason: string;
  frontShown: boolean;
  backShown: boolean;
  /** Sleeve, toploader, or already slabbed — all change what is visible. */
  encasement: "NONE" | "SLEEVE_OR_TOPLOADER" | "GRADED_SLAB" | "UNCLEAR";
  /** True when the image looks like a stock/catalogue photo, not this copy. */
  looksLikeStockPhoto: boolean;
  front: PhotoCenteringReading;
  back: PhotoCenteringReading;
  defects: VisibleDefect[];
  /** What a person should go and look at before bidding. */
  whatToCheckYourself: string[];
}

/**
 * The schema is `strict`, and every field is required, so the model cannot
 * quietly omit the inconvenient ones. Note what is ABSENT from it: there is
 * no grade field, no probability field, no score. The model is not given
 * anywhere to put a prediction, which is a stronger constraint than asking
 * it not to make one.
 */
export const PHOTO_ASSESSMENT_SCHEMA = {
  name: "photo_assessment",
  schema: {
    type: "object",
    additionalProperties: false,
    required: [
      "assessability",
      "assessabilityReason",
      "frontShown",
      "backShown",
      "encasement",
      "looksLikeStockPhoto",
      "front",
      "back",
      "defects",
      "whatToCheckYourself",
    ],
    properties: {
      assessability: { type: "string", enum: ["GOOD", "LIMITED", "UNUSABLE"] },
      assessabilityReason: { type: "string" },
      frontShown: { type: "boolean" },
      backShown: { type: "boolean" },
      encasement: { type: "string", enum: ["NONE", "SLEEVE_OR_TOPLOADER", "GRADED_SLAB", "UNCLEAR"] },
      looksLikeStockPhoto: { type: "boolean" },
      front: {
        type: "object",
        additionalProperties: false,
        required: ["leftRightPct", "topBottomPct", "note"],
        properties: {
          leftRightPct: { type: ["number", "null"], minimum: 50, maximum: 100 },
          topBottomPct: { type: ["number", "null"], minimum: 50, maximum: 100 },
          note: { type: ["string", "null"] },
        },
      },
      back: {
        type: "object",
        additionalProperties: false,
        required: ["leftRightPct", "topBottomPct", "note"],
        properties: {
          leftRightPct: { type: ["number", "null"], minimum: 50, maximum: 100 },
          topBottomPct: { type: ["number", "null"], minimum: 50, maximum: 100 },
          note: { type: ["string", "null"] },
        },
      },
      defects: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["area", "description", "confidence"],
          properties: {
            area: { type: "string" },
            description: { type: "string" },
            confidence: { type: "string", enum: ["CLEAR", "POSSIBLE"] },
          },
        },
      },
      whatToCheckYourself: { type: "array", items: { type: "string" } },
    },
  },
} as const;

export const PHOTO_ASSESSMENT_PROMPT = definePromptTemplate<{
  cardName: string;
  listingTitle: string;
  conditionText: string;
  imageCount: number;
}>({
  id: "photo_assessment",
  version: 1,
  description:
    "Assesses what a listing's own photographs can establish about card condition. Measures centering, reports visible defects, and — first — reports whether the photos support any judgement at all. Never outputs a grade or a probability.",
  render: (vars) => ({
    instructions: [
      "You are examining photographs from an online listing for a trading card, on behalf of someone deciding whether to buy it and send it for professional grading.",
      "",
      "YOUR MOST IMPORTANT JOB IS TO SAY WHAT THESE PHOTOGRAPHS CANNOT SHOW.",
      "Listing photos are uncontrolled: unknown lighting, unknown resolution, often one face only, often through a sleeve, often with glare on the holo. You are not looking at a controlled scan and you must not reason as though you were.",
      "",
      "RULES, in order of importance:",
      "1. NEVER state or imply a grade, a grade range, a score, or a probability of any grade. You are not predicting the outcome. If asked to, refuse in the assessabilityReason field.",
      "2. Report ABSENCE OF EVIDENCE AS ABSENCE OF EVIDENCE. If you cannot see the corners well enough to judge them, that is 'not visible at this resolution' — it is NOT 'corners look sharp'. Only report a defect you can actually see.",
      "3. MEASURE CENTERING ONLY IF YOU HONESTLY CAN. That needs the whole card square-on in frame with the border visible on all four sides. If the photo is angled, cropped, or the border is obscured, return null and say why in the note. A guessed measurement is worse than no measurement, because the next step treats it as geometry.",
      "4. Express centering as the LARGER share on each axis, 50-100. A card whose left border is twice the right is 67. Perfect is 50. Never return a number below 50.",
      "5. If the card is already in a graded slab, say so via encasement — the buyer is then not buying a raw card at all.",
      "6. If the image looks like a stock or catalogue photograph rather than the actual item, say so. This is common and it invalidates everything else you would say.",
      "",
      "Be specific and short. 'Whitening along the bottom edge, left of centre' beats 'some edge wear'.",
    ].join("\n"),
    input: [
      `Card: ${vars.cardName}`,
      `Listing title: ${vars.listingTitle}`,
      `Seller's stated condition: ${vars.conditionText || "(none given)"}`,
      `Photographs attached: ${vars.imageCount}`,
      "",
      "Assess the attached photographs against the rules above.",
    ].join("\n"),
  }),
});

export interface PhotoAssessmentRequest {
  cardName: string;
  listingTitle: string;
  conditionText?: string | null;
  imageUrls: string[];
}

export interface PhotoAssessmentResponse {
  available: boolean;
  assessment: PhotoAssessment | null;
  error: string | null;
  modelId: string | null;
  promptVersionId: string | null;
  /**
   * Token usage, when the model reported it. Cost in USD is NOT returned
   * here: the caching layer already prices every call and records it against
   * the daily spend cap in `api_usage`, and a second cost figure computed
   * here could disagree with the one the budget is enforced against.
   */
  usage: { inputTokens: number; outputTokens: number; totalTokens: number } | null;
  /** The image URLs actually sent, in order — part of the audit trail. */
  imagesUsed: string[];
}

/**
 * How many photographs to send.
 *
 * Each image costs tokens, and the marginal value falls away fast: the first
 * is almost always the front, the second usually the back, and the rest are
 * angles and close-ups. Six covers a thorough seller without paying for a
 * twenty-photo listing.
 */
export const MAX_ASSESSMENT_IMAGES = 6;

/**
 * eBay's image CDN serves the same photograph at several sizes, selected by
 * an `s-l<pixels>` segment in the path. Requesting a larger one usually
 * returns a larger image.
 *
 * THIS IS UNDOCUMENTED. eBay's API reference describes `imageUrl` only as
 * "The URL of the image" and marks `height`/`width` as reserved for future
 * use, so there is no contract here — only a widely-relied-on convention.
 *
 * It is therefore best-effort by construction: the rewrite only fires on a
 * URL that already matches the pattern, and if the CDN ignores it or serves
 * the original size, nothing breaks. The real protection is not this
 * function — it is that the model is required to report assessability, so a
 * photograph that arrives too small to judge is reported as too small to
 * judge rather than judged badly.
 */
export function preferLargerEbayImage(url: string): string {
  return url.replace(/(\/s-l)\d{2,4}(\.(?:jpg|jpeg|png|webp))(?=$|\?)/i, "$11600$2");
}

export class AiPhotoAssessmentProvider {
  readonly name = "ai-photo-assessment";

  constructor(private readonly model: AiModelProvider) {}

  async assess(request: PhotoAssessmentRequest): Promise<PhotoAssessmentResponse> {
    const urls = request.imageUrls
      .filter((url) => typeof url === "string" && /^https:\/\//i.test(url))
      .slice(0, MAX_ASSESSMENT_IMAGES)
      .map(preferLargerEbayImage);

    if (urls.length === 0) {
      // Not an error, and not a call worth paying for. A listing with no
      // photographs has an honest, knowable answer.
      return {
        available: false,
        assessment: null,
        error: "This listing has no usable photographs, so there is nothing to assess.",
        modelId: null,
        promptVersionId: null,
        usage: null,
        imagesUsed: [],
      };
    }

    const images: AiCompletionImageInput[] = urls.map((url) => ({
      // "high" rather than "auto": the whole point is fine detail — border
      // widths, corner whitening, surface lines. Downsampling defeats it.
      url,
      detail: "high",
    }));

    const result = await this.model.complete(
      buildAiRequest(
        PHOTO_ASSESSMENT_PROMPT,
        {
          cardName: request.cardName,
          listingTitle: request.listingTitle,
          conditionText: request.conditionText ?? "",
          imageCount: urls.length,
        },
        {
          tier: "DEEP",
          images,
          responseSchema: PHOTO_ASSESSMENT_SCHEMA as unknown as { name: string; schema: Record<string, unknown> },
          maxOutputTokens: 1200,
        },
      ),
    );

    if (!result.available || !result.parsedJson) {
      return {
        available: false,
        assessment: null,
        error: result.error ?? "The model returned no structured assessment.",
        modelId: result.modelId ?? null,
        promptVersionId: result.promptVersionId ?? null,
        usage: result.usage ?? null,
        imagesUsed: urls,
      };
    }

    const assessment = normaliseAssessment(result.parsedJson as Record<string, unknown>);

    return {
      available: true,
      assessment,
      error: null,
      modelId: result.modelId ?? null,
      promptVersionId: result.promptVersionId ?? null,
      usage: result.usage ?? null,
      imagesUsed: urls,
    };
  }
}

/**
 * Defensive normalisation of the model's output.
 *
 * Structured outputs are schema-constrained, so this should be redundant —
 * but the centering figures feed a geometric check that treats them as
 * measurements, and a value that slipped through out of range would be
 * silently authoritative. Anything that is not a usable number becomes null,
 * which the check reports as not-assessed. Degrading to "unknown" is always
 * safe here; degrading to a wrong number is not.
 */
function normaliseAssessment(raw: Record<string, unknown>): PhotoAssessment {
  const pct = (value: unknown): number | null => {
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    if (value < 50 || value > 100) return null;
    return Math.round(value * 10) / 10;
  };

  const reading = (value: unknown): PhotoCenteringReading => {
    const obj = (value ?? {}) as Record<string, unknown>;
    return {
      leftRightPct: pct(obj.leftRightPct),
      topBottomPct: pct(obj.topBottomPct),
      note: typeof obj.note === "string" && obj.note.trim() ? obj.note.trim() : null,
    };
  };

  const assessability = raw.assessability;
  const encasement = raw.encasement;

  return {
    assessability:
      assessability === "GOOD" || assessability === "LIMITED" || assessability === "UNUSABLE"
        ? assessability
        : "UNUSABLE",
    assessabilityReason: typeof raw.assessabilityReason === "string" ? raw.assessabilityReason : "",
    frontShown: raw.frontShown === true,
    backShown: raw.backShown === true,
    encasement:
      encasement === "NONE" || encasement === "SLEEVE_OR_TOPLOADER" || encasement === "GRADED_SLAB"
        ? encasement
        : "UNCLEAR",
    looksLikeStockPhoto: raw.looksLikeStockPhoto === true,
    front: reading(raw.front),
    back: reading(raw.back),
    defects: Array.isArray(raw.defects)
      ? raw.defects
          .map((d) => (d ?? {}) as Record<string, unknown>)
          .filter((d) => typeof d.description === "string" && d.description.trim().length > 0)
          .map((d) => ({
            area: typeof d.area === "string" ? d.area : "other",
            description: String(d.description).trim(),
            confidence: d.confidence === "CLEAR" ? ("CLEAR" as const) : ("POSSIBLE" as const),
          }))
      : [],
    whatToCheckYourself: Array.isArray(raw.whatToCheckYourself)
      ? raw.whatToCheckYourself.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      : [],
  };
}
