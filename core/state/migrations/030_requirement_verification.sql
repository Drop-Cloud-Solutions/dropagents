-- Fan-out verification gate (design-verifier agent).
-- ArchitectureApproved no longer fans plans out directly: the verifier
-- audits the sub-brief proposal against the design first. These columns
-- carry the gate state the board renders:
--   verification_status: NULL | 'verifying' | 'passed' | 'failed' | 'overridden'
--   verification_findings: JSON array of {systemId, severity, finding}
--     (plus an optional {error, summary} wrapper written by the fold)
ALTER TABLE requirements ADD COLUMN verification_status TEXT;
ALTER TABLE requirements ADD COLUMN verification_findings TEXT;
