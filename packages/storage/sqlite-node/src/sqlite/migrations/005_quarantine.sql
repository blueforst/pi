-- iris_agent#50: permanent quarantine of integrity-failed receipts.
-- Recovery validation (session id, entry existence/type/role, recomputed
-- canonical content hash) that fails for a pending receipt permanently
-- quarantines the row: acked = 2 (quarantine) with a typed reason. Quarantined
-- rows are excluded from readPendingCommitReceipts (never emitted, never
-- acked), stay visible via readQuarantinedCommitReceipts for health
-- diagnostics, and are skipped by every later recovery pass (idempotent).
ALTER TABLE session_commit_receipts ADD COLUMN quarantine_reason TEXT;
