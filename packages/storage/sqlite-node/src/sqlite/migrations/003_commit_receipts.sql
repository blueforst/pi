-- Crash-consistent commit receipt journal (iris_agent#40 / Feature 2).
-- Generic Pi mechanism: every durable message append that goes through
-- appendEntryWithReceipt also inserts a pending receipt row in the same
-- transaction. The harness acknowledges the receipt after the
-- message_finalized lifecycle event has been published; on restart,
-- unacknowledged rows are replayed. No Iris-specific semantics live here.
CREATE TABLE IF NOT EXISTS session_commit_receipts (
	session_id TEXT NOT NULL,
	entry_id TEXT NOT NULL,
	content_hash TEXT NOT NULL,
	committed_at TEXT NOT NULL,
	acked INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (session_id, entry_id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_session_commit_receipts_pending
	ON session_commit_receipts(session_id, acked, committed_at);
