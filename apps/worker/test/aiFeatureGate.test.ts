import { describe, it, expect } from "vitest";
import {
  AI_FEATURES,
  DEFAULT_AI_FEATURE_SWITCHES,
  FeatureGatedAiModelProvider,
  resolveFeatureSwitches,
  type AiCompletionRequest,
  type AiModelProvider,
} from "@mwmc/providers";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/**
 * The switchboard. Tests the property that matters most: a feature that is
 * off must not merely return nothing — it must never call the model at all,
 * so it cannot spend money or fill the cache.
 */
function spyProvider(): { provider: AiModelProvider; calls: number } {
  const state = { calls: 0 };
  const provider: AiModelProvider = {
    name: "spy",
    async complete() {
      state.calls += 1;
      return { available: true, outputText: "ok", parsedJson: null, modelId: "spy-1", usage: null, error: null };
    },
  };
  return { provider, get calls() { return state.calls; } };
}

const REQUEST: AiCompletionRequest = { tier: "FAST", instructions: "i", input: "x" };

describe("a disabled feature never reaches the model", () => {
  it("returns unavailable WITHOUT calling through", async () => {
    const spy = spyProvider();
    const gated = new FeatureGatedAiModelProvider(spy.provider, "candidateReview", {
      ...DEFAULT_AI_FEATURE_SWITCHES,
      candidateReview: false,
    });

    const result = await gated.complete(REQUEST);
    expect(result.available).toBe(false);
    // The whole point: no call, so no tokens, no cache row, no spend.
    expect(spy.calls).toBe(0);
  });

  it("names the exact switch that is off, so the operator can find it", async () => {
    const gated = new FeatureGatedAiModelProvider(spyProvider().provider, "queryInterpreter", {
      ...DEFAULT_AI_FEATURE_SWITCHES,
      queryInterpreter: false,
    });
    const result = await gated.complete(REQUEST);
    expect(result.error).toContain("ai_settings.features.queryInterpreter");
    expect(result.error).toContain("nothing was spent");
  });

  it("passes through when the feature is on", async () => {
    const spy = spyProvider();
    const gated = new FeatureGatedAiModelProvider(spy.provider, "photoAssessment", DEFAULT_AI_FEATURE_SWITCHES);
    expect((await gated.complete(REQUEST)).available).toBe(true);
    expect(spy.calls).toBe(1);
  });
});

describe("defaults are off, except the one feature that is on demand and advisory", () => {
  it("enables the photo check and nothing else", () => {
    expect(DEFAULT_AI_FEATURE_SWITCHES.photoAssessment).toBe(true);
    for (const feature of AI_FEATURES.filter((f) => f !== "photoAssessment")) {
      expect(DEFAULT_AI_FEATURE_SWITCHES[feature]).toBe(false);
    }
  });

  it("keeps candidate review off — it runs automatically and hides rows", () => {
    // The one feature that changes what the operator sees without being
    // asked. Enabling it must be a deliberate act.
    expect(DEFAULT_AI_FEATURE_SWITCHES.candidateReview).toBe(false);
  });

  it("a malformed or partial stored value can never switch something on", () => {
    expect(resolveFeatureSwitches(undefined)).toEqual(DEFAULT_AI_FEATURE_SWITCHES);
    expect(resolveFeatureSwitches({ candidateReview: "yes" }).candidateReview).toBe(false);
    expect(resolveFeatureSwitches({ candidateReview: 1 }).candidateReview).toBe(false);
    expect(resolveFeatureSwitches(null)).toEqual(DEFAULT_AI_FEATURE_SWITCHES);
  });

  it("honours an explicit true, so the switch works in both directions", () => {
    expect(resolveFeatureSwitches({ listingAdvisory: true }).listingAdvisory).toBe(true);
  });

  it("ignores an unknown key rather than inventing a feature", () => {
    const resolved = resolveFeatureSwitches({ notAFeature: true });
    expect(Object.keys(resolved).sort()).toEqual([...AI_FEATURES].sort());
  });
});

/**
 * THE COVERAGE TEST — the one that stops a future feature slipping the net.
 *
 * A new AI call site that forgets its gate would be invisible: it would work
 * perfectly, cost money, and appear on no switchboard. So rather than trust
 * that, this walks the worker source and asserts that every construction of
 * a model provider is wrapped.
 */
describe("every AI call site in the worker is gated", () => {
  const SRC = fileURLToPath(new URL("../src/", import.meta.url));

  function* walk(dir: string): Generator<string> {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) yield* walk(full);
      else if (entry.name.endsWith(".ts")) yield full;
    }
  }

  it("wraps createAiModelProvider() in FeatureGatedAiModelProvider everywhere it is called", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/createAiModelProvider\(/g)) {
        // Skip mentions inside comments — several files explain the provider
        // chain in prose, and a doc comment is not a call site.
        const lineStart = source.lastIndexOf("\n", match.index!) + 1;
        const line = source.slice(lineStart, source.indexOf("\n", match.index!));
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;

        const before = source.slice(Math.max(0, match.index! - 200), match.index!);
        if (!before.includes("FeatureGatedAiModelProvider(")) {
          offenders.push(`${file.slice(SRC.length)}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("gates one call site per declared feature that the worker actually calls", () => {
    const sources = [...walk(SRC)].map((f) => readFileSync(f, "utf8")).join("\n");
    for (const feature of AI_FEATURES) {
      expect(sources).toContain(`"${feature}"`);
    }
  });
});
