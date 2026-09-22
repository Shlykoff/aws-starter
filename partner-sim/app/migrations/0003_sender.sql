-- 0003: the sender's identity. Header/Sender/Name was always in the submission but never parsed
-- or stored; it now carries the requester's e-mail address (PartyName was widened to allow "@"),
-- which is the interesting new piece of information. Recipient/Name is left exactly as it was:
-- it is always the same fixed value now, so it is no longer shown in the UI, but this system
-- keeps faithfully recording what it received.
--
-- SQLite's ALTER TABLE ADD COLUMN always appends the new column at the end of the table; a
-- nullable column with no default backfills every existing row with NULL, which is exactly
-- what a message stored before this migration existed should show: the sender was never read.

ALTER TABLE messages ADD COLUMN sender TEXT;
