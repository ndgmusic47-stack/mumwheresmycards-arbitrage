import { describe, it, expect } from "vitest";
import { definePromptTemplate, promptVersionId, parsePromptVersionId, buildAiRequest } from "../src/ai/promptVersioning.js";

/**
 * REGRESSION GUARD for AI INTELLIGENCE spec Phase 2, Workstream H (prompt
 * versioning). The core contract: a version bump produces a different id,
 * a malformed id/version is rejected loudly at definition time (not
 * silently at call time), and buildAiRequest() is the one place
 * instructions/input/promptVersionId get assembled together correctly.
 */

interface RoutingVars {
  cardName: string;
}

function makeTemplate(version = 1) {
  return definePromptTemplate<RoutingVars>({
    id: "listing_analyst_routing",
    version,
    description: "test template",
    render: (vars) => ({ instructions: "sys prompt", input: `Analyze ${vars.cardName}` }),
  });
}

describe("definePromptTemplate", () => {
  it("returns the template unchanged when id/version are valid", () => {
    const template = makeTemplate();
    expect(template.id).toBe("listing_analyst_routing");
    expect(template.version).toBe(1);
  });

  it("rejects a non-snake_case id", () => {
    expect(() =>
      definePromptTemplate({ id: "ListingAnalyst", version: 1, description: "x", render: () => ({ instructions: "", input: "" }) }),
    ).toThrow(/Invalid PromptTemplate id/);
  });

  it("rejects an id starting with a digit or underscore", () => {
    expect(() =>
      definePromptTemplate({ id: "1analyst", version: 1, description: "x", render: () => ({ instructions: "", input: "" }) }),
    ).toThrow(/Invalid PromptTemplate id/);
  });

  it("rejects a non-integer version", () => {
    expect(() =>
      definePromptTemplate({ id: "analyst", version: 1.5, description: "x", render: () => ({ instructions: "", input: "" }) }),
    ).toThrow(/Invalid PromptTemplate version/);
  });

  it("rejects version 0 or negative", () => {
    expect(() =>
      definePromptTemplate({ id: "analyst", version: 0, description: "x", render: () => ({ instructions: "", input: "" }) }),
    ).toThrow(/Invalid PromptTemplate version/);
  });

  it("freezes the returned template", () => {
    const template = makeTemplate();
    expect(() => {
      (template as { version: number }).version = 99;
    }).toThrow();
  });
});

describe("promptVersionId / parsePromptVersionId", () => {
  it("round-trips id and version", () => {
    const template = makeTemplate(3);
    const id = promptVersionId(template);
    expect(id).toBe("listing_analyst_routing@v3");
    expect(parsePromptVersionId(id)).toEqual({ templateId: "listing_analyst_routing", version: 3 });
  });

  it("a version bump produces a genuinely different id", () => {
    expect(promptVersionId(makeTemplate(1))).not.toBe(promptVersionId(makeTemplate(2)));
  });

  it("parsePromptVersionId returns null (never throws) for an unparseable string", () => {
    expect(parsePromptVersionId("not-a-valid-id")).toBeNull();
    expect(parsePromptVersionId("")).toBeNull();
    expect(parsePromptVersionId("Analyst@v1")).toBeNull();
  });
});

describe("buildAiRequest", () => {
  it("renders the template and stamps the correct promptVersionId", () => {
    const template = makeTemplate(2);
    const request = buildAiRequest(template, { cardName: "Charizard" }, { tier: "FAST" });

    expect(request.tier).toBe("FAST");
    expect(request.instructions).toBe("sys prompt");
    expect(request.input).toBe("Analyze Charizard");
    expect(request.promptVersionId).toBe("listing_analyst_routing@v2");
  });

  it("a version bump changes the built request's promptVersionId with identical vars", () => {
    const v1Request = buildAiRequest(makeTemplate(1), { cardName: "Pikachu" }, { tier: "DEEP" });
    const v2Request = buildAiRequest(makeTemplate(2), { cardName: "Pikachu" }, { tier: "DEEP" });

    expect(v1Request.promptVersionId).not.toBe(v2Request.promptVersionId);
  });

  it("passes through extra request fields (responseSchema, maxOutputTokens) untouched", () => {
    const template = makeTemplate();
    const request = buildAiRequest(template, { cardName: "Mewtwo" }, {
      tier: "AUDIT",
      responseSchema: { name: "x", schema: { type: "object" } },
      maxOutputTokens: 500,
    });

    expect(request.responseSchema).toEqual({ name: "x", schema: { type: "object" } });
    expect(request.maxOutputTokens).toBe(500);
  });
});
