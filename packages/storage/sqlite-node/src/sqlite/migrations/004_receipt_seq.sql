-- iris_agent#50: authoritative monotonic commit sequence for receipt replay.
-- The receipt row is written in the SAME transaction as the entry append and
-- carries the entry's entry_seq (the durable append order). Replay orders by
-- this sequence exclusively; committed_at is diagnostics only. The column is
-- backfilled with the entry sequence for pre-existing rows so upgrades keep
-- correct ordering.
ALTER TABLE session_commit_receipts ADD COLUMN receipt_seq INTEGER NOT NULL DEFAULT 0;

UPDATE session_commit_receipts
SET receipt_seq = (
	SELECT e.entry_seq FROM session_entries e
	WHERE e.session_id = session_commit_receipts.session_id
	  AND e.id = session_commit_receipts.entry_id
)
WHERE receipt_seq = 0;

CREATE INDEX IF NOT EXISTS idx_session_commit_receipts_pending_seq
	ON session_commit_receipts(session_id, acked, receipt_seq);
