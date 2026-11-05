-- Clarification parks must survive a board reload. The parked_reason
-- column already re-hydrates the parked STATE, but the question text
-- (TaskParked.payload.question) and the enumerated choices
-- (ClarificationRequested.payload.choices) lived only in board memory —
-- after a refresh the Answer button rendered an empty modal.
ALTER TABLE tasks ADD COLUMN parked_question TEXT;
ALTER TABLE tasks ADD COLUMN parked_choices TEXT;
