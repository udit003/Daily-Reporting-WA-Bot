-- Pending-manager invite flow.
--
-- When an employee selects "my manager hasn't joined yet", we now capture the
-- manager's full NAME (for a personalized invite + display) in addition to
-- their phone, send that manager a WhatsApp invite, and let the employee start
-- reporting immediately. When the manager later onboards, reconcile links the
-- mapping via pending_manager_phone (unchanged).
ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_manager_name TEXT;
