import { useEffect, useState } from "react";
import {
  fetchPhotoAssessment,
  runPhotoAssessment,
  type PhotoAssessmentBundle,
  type GradeCenteringCheck,
} from "../api/client";

/**
 * PHOTO CHECK — what the listing's own photographs can and cannot tell you.
 *
 * THE ENTIRE DESIGN OF THIS PANEL IS ABOUT NOT LOOKING LIKE A GRADE
 * PREDICTION. The headline is a CEILING with one named cause; the second
 * thing on screen is what the photos could not show; and there is no
 * percentage anywhere, because there is no data behind one.
 *
 * That restraint is the feature. A confident "PSA 9, 78%" would flow
 * straight into the deal desk's profit figures and turn a guess into a
 * business plan.
 */

const VERDICT_LABEL: Record<GradeCenteringCheck["verdict"], string> = {
  WITHIN: "centering allows",
  EXCEEDS: "centering rules out",
  NOT_ASSESSED: "not assessed",
};

export function GradeCheckPanel({ opportunityId, graderId = "PSA" }: { opportunityId: string; graderId?: string }) {
  const [bundle, setBundle] = useState<PhotoAssessmentBundle | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    fetchPhotoAssessment(opportunityId)
      .then(setBundle)
      .catch((e) => setError(String(e)));
  }, [opportunityId]);

  async function run() {
    setRunning(true);
    setError(null);
    try {
      setBundle(await runPhotoAssessment(opportunityId, graderId));
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  }

  const stored = bundle?.assessment ?? null;
  const a = stored?.assessment ?? null;
  const ceiling = bundle?.centeringChecks.find((c) => c.gradeKey === stored?.centeringCeilingKey) ?? null;

  return (
    <section className="panel grade-check">
      <h2>Photo check</h2>
      <p className="panel-caption">
        Reads the seller&apos;s own photographs. It measures centering and reports what it can actually see — and, first,
        whether these photos can support a judgement at all. It does <strong>not</strong> predict a grade, and there is
        no probability here, because nothing in this system has the data to produce an honest one.
      </p>

      {error && <p className="error-banner">{error}</p>}

      {!stored && (
        <div className="deal-actions">
          <button onClick={run} disabled={running || bundle?.availableImageCount === 0}>
            {running ? "Looking at the photos…" : "Check the photos"}
          </button>
          <span className="panel-caption">
            {bundle?.availableImageCount === 0
              ? "This listing has no stored photographs, so there is nothing to check."
              : `${bundle?.availableImageCount ?? 0} photograph${bundle?.availableImageCount === 1 ? "" : "s"} stored. Costs a model call, so it only runs when you ask.`}
          </span>
        </div>
      )}

      {a && (
        <>
          {/* ASSESSABILITY FIRST, deliberately above any finding. If the
              photos are poor, that is the most important thing on screen. */}
          <div className={`assessability assessability-${a.assessability.toLowerCase()}`}>
            <strong>
              {a.assessability === "GOOD"
                ? "These photos support a reasonable look"
                : a.assessability === "LIMITED"
                  ? "These photos only support a limited look"
                  : "These photos cannot support a judgement"}
            </strong>
            <p>{a.assessabilityReason}</p>
            <ul className="photo-facts">
              <li>{a.frontShown ? "Front shown" : "No usable front shot"}</li>
              <li>{a.backShown ? "Back shown" : "No back shot — back centering and back defects are unknown"}</li>
              {a.encasement === "SLEEVE_OR_TOPLOADER" && <li>Photographed in a sleeve or toploader</li>}
              {a.encasement === "GRADED_SLAB" && <li>Already in a graded slab — this is not a raw card</li>}
              {a.looksLikeStockPhoto && (
                <li className="warn-tag">
                  Looks like a stock photograph of a different copy. Any measurement was discarded.
                </li>
              )}
            </ul>
          </div>

          <h3>Centering</h3>
          {stored?.frontWorstPct === null && stored?.backWorstPct === null ? (
            <p className="panel-caption">
              Not measurable from these photographs. {a.front.note ?? ""} {a.back.note ?? ""}
            </p>
          ) : (
            <>
              <p className="result-count">
                {stored?.frontWorstPct !== null && (
                  <>
                    Front measures about <strong>{stored?.frontWorstPct}/{(100 - (stored?.frontWorstPct ?? 0)).toFixed(0)}</strong> at its worst axis.{" "}
                  </>
                )}
                {stored?.backWorstPct !== null && (
                  <>Back about <strong>{stored?.backWorstPct}/{(100 - (stored?.backWorstPct ?? 0)).toFixed(0)}</strong>.</>
                )}
              </p>
              {ceiling ? (
                <p className="ceiling">
                  On centering alone, the best grade not ruled out is <strong>{ceiling.gradeLabel}</strong>.
                  <span className="panel-caption">
                    {" "}
                    That is a ceiling with one cause. Corners, edges, surface and print are all still unaccounted for and
                    any of them can cap it far lower.
                  </span>
                </p>
              ) : (
                <p className="panel-caption">Centering exceeds every published tolerance on file for this grader.</p>
              )}

              <table className="deal-cost-table">
                <tbody>
                  {bundle?.centeringChecks
                    .filter((c) => c.verdict !== "NOT_ASSESSED")
                    .map((c) => (
                      <tr key={c.gradeKey} className={c.verdict === "EXCEEDS" ? "deal-line-missing" : undefined}>
                        <td>{c.gradeLabel}</td>
                        <td>{VERDICT_LABEL[c.verdict]}</td>
                        <td className="deal-provenance">{c.publishedTolerance}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
              {bundle?.centeringStandard && (
                <p className="panel-caption">
                  Tolerances as published by the grader (
                  <a href={bundle.centeringStandard.sourceUrl} target="_blank" rel="noreferrer noopener">
                    source
                  </a>
                  ).
                  {!bundle.centeringStandard.fromFormalStandard &&
                    " PSA publishes these in its glossary rather than on its grading-standards page, and publishes no back-centering figure at all — so a back measurement is never used against a PSA grade here."}
                </p>
              )}
            </>
          )}

          <h3>What can be seen</h3>
          {a.defects.length === 0 ? (
            <p className="panel-caption">
              No defects visible at this resolution. That is <strong>not</strong> the same as none being there — listing
              photos rarely resolve corner wear or fine surface scratches.
            </p>
          ) : (
            <ul className="reasoning-list">
              {a.defects.map((d, i) => (
                <li key={i}>
                  <strong>{d.area}:</strong> {d.description}{" "}
                  <span className="deal-provenance">{d.confidence === "CLEAR" ? "clearly visible" : "possible"}</span>
                </li>
              ))}
            </ul>
          )}

          {a.whatToCheckYourself.length > 0 && (
            <>
              <h3>Ask the seller / check yourself</h3>
              <ul className="reasoning-list">
                {a.whatToCheckYourself.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </>
          )}

          <div className="deal-actions">
            <button onClick={run} disabled={running}>
              {running ? "Re-checking…" : "Re-check"}
            </button>
            <span className="panel-caption">
              Checked {new Date(stored!.createdAt).toLocaleString("en-GB")}
              {stored!.modelId ? ` · ${stored!.modelId}` : ""}
              {stored!.promptVersionId ? ` · ${stored!.promptVersionId}` : ""} · {stored!.imageUrls.length} photo
              {stored!.imageUrls.length === 1 ? "" : "s"}. Re-checking keeps the previous result on file rather than
              replacing it.
            </span>
          </div>
        </>
      )}
    </section>
  );
}
