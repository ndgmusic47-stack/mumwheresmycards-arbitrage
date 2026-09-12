-- Pre-grade photo assessments, and the ground truth needed to calibrate them.
--
-- THE POINT OF STORING THESE IS NOT THE CACHE. It is that an assessment made
-- BEFORE a purchase can later be compared against the grade the card
-- ACTUALLY came back as. Without that pairing there is no way to ever know
-- whether the assessments are any good, and the tool would be permanently
-- stuck asserting things it cannot check.
--
-- The comparison is only honest if the assessment is frozen at the moment it
-- was made — before the outcome was known, on the images that existed then,
-- from a named prompt version and model. Every one of those is a column
-- here. An assessment that could be silently re-run after the grade came
-- back would make the calibration meaningless.

CREATE TABLE photo_assessments (
  id                    TEXT PRIMARY KEY,
  listing_id            TEXT NOT NULL REFERENCES ebay_listings(id),
  opportunity_id        TEXT REFERENCES opportunities(id),
  card_id               TEXT NOT NULL REFERENCES cards(id),

  -- The verdict, as returned. Stored whole so a later change to the output
  -- shape can never retro-fit a meaning onto an older assessment.
  assessment_json       TEXT NOT NULL,

  -- Pulled out of the JSON for querying, because these are what a
  -- calibration report groups by.
  assessability         TEXT NOT NULL,   -- GOOD | LIMITED | UNUSABLE
  front_worst_pct       REAL,            -- null when centering was not measurable
  back_worst_pct        REAL,
  centering_ceiling_key TEXT,            -- best grade centering alone permits
  grader_id             TEXT NOT NULL,   -- whose published scale the ceiling used

  -- PROVENANCE OF THE ASSESSMENT ITSELF. Which model, which prompt version,
  -- which exact images. A calibration built across two different prompt
  -- versions without knowing which was which is not a calibration.
  model_id              TEXT,
  prompt_version_id     TEXT,
  image_urls_json       TEXT NOT NULL,
  input_tokens          INTEGER,
  output_tokens         INTEGER,

  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_photo_assessments_listing ON photo_assessments(listing_id, created_at DESC);
CREATE INDEX idx_photo_assessments_opportunity ON photo_assessments(opportunity_id);
CREATE INDEX idx_photo_assessments_card ON photo_assessments(card_id);

-- THE OTHER HALF OF THE PAIR: which assessment, if any, informed the
-- decision to buy this card. Nullable, because most inventory will not have
-- one — a card bought before this existed, or bought without running it.
--
-- Deliberately on inventory rather than a join table: a purchase is
-- one-to-one with the assessment it was made against, and the whole value is
-- in that being unambiguous when the grade comes back.
ALTER TABLE inventory ADD COLUMN photo_assessment_id TEXT REFERENCES photo_assessments(id);

CREATE INDEX idx_inventory_photo_assessment ON inventory(photo_assessment_id)
  WHERE photo_assessment_id IS NOT NULL;
