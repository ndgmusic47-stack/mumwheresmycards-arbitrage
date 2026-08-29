import { Hono } from "hono";
import { Db, type GradingSubmissionRow, type GradingResultRow } from "@mwmc/db";
import type { Env } from "../env.js";

export const gradingRoute = new Hono<{ Bindings: Env }>();

gradingRoute.get("/submissions", async (c) => {
  const db = new Db(c.env.DB);
  const rows = await db.queryAll<GradingSubmissionRow>(`SELECT * FROM grading_submissions ORDER BY submitted_at DESC`);
  return c.json({ submissions: rows });
});

interface CreateSubmissionBody {
  inventoryId: string;
  service?: string;
  submissionLevel?: string;
  trackingNumber?: string;
  actualGradingFee?: number;
  actualPostageOut?: number;
  actualInsurance?: number;
  actualPackaging?: number;
  expectedReturnDate?: string;
}

gradingRoute.post("/submissions", async (c) => {
  const db = new Db(c.env.DB);
  const body = await c.req.json<CreateSubmissionBody>();
  const id = crypto.randomUUID();

  await db.exec(
    `INSERT INTO grading_submissions (
       id, inventory_id, service, submission_level, tracking_number,
       actual_grading_fee, actual_postage_out, actual_insurance, actual_packaging, expected_return_date, status
     ) VALUES (?,?,?,?,?,?,?,?,?,?, 'SUBMITTED')`,
    id,
    body.inventoryId,
    body.service ?? "PSA",
    body.submissionLevel ?? null,
    body.trackingNumber ?? null,
    body.actualGradingFee ?? 0,
    body.actualPostageOut ?? 0,
    body.actualInsurance ?? 0,
    body.actualPackaging ?? 0,
    body.expectedReturnDate ?? null,
  );

  await db.exec(`UPDATE inventory SET status = 'AWAITING_GRADING', updated_at = datetime('now') WHERE id = ?`, body.inventoryId);

  const row = await db.queryFirst<GradingSubmissionRow>(`SELECT * FROM grading_submissions WHERE id = ?`, id);
  return c.json({ submission: row }, 201);
});

interface CreateResultBody {
  submissionId: string;
  gradeLabel: string;
  gradeNumeric: number;
  certNumber?: string;
  actualReturnPostage?: number;
  notes?: string;
}

gradingRoute.post("/results", async (c) => {
  const db = new Db(c.env.DB);
  const body = await c.req.json<CreateResultBody>();
  const id = crypto.randomUUID();

  await db.exec(
    `INSERT INTO grading_results (id, submission_id, grade_label, grade_numeric, cert_number, actual_return_postage, notes)
     VALUES (?,?,?,?,?,?,?)`,
    id,
    body.submissionId,
    body.gradeLabel,
    body.gradeNumeric,
    body.certNumber ?? null,
    body.actualReturnPostage ?? 0,
    body.notes ?? null,
  );

  const submission = await db.queryFirst<GradingSubmissionRow>(
    `SELECT * FROM grading_submissions WHERE id = ?`,
    body.submissionId,
  );
  await db.exec(`UPDATE grading_submissions SET status = 'RETURNED', updated_at = datetime('now') WHERE id = ?`, body.submissionId);
  if (submission) {
    await db.exec(`UPDATE inventory SET status = 'GRADED', updated_at = datetime('now') WHERE id = ?`, submission.inventory_id);
  }

  const row = await db.queryFirst<GradingResultRow>(`SELECT * FROM grading_results WHERE id = ?`, id);
  return c.json({ result: row }, 201);
});
