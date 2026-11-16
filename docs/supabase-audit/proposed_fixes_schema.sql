
-- THE TRAINERS – SAFE ADDITIVE SCHEMA FIX
-- Target: rxkyryaplszuklagvidi
-- Additive only. Review before execution.

-- 1. Add missing read timestamp to messages
ALTER TABLE public.messages
ADD COLUMN IF NOT EXISTS read_at timestamptz;

-- 2. conversation_members
-- No change required.
-- Keep the existing composite primary key:
-- (conversation_id, profile_id)

-- 3. Existing tables:
-- admin_notices
-- audit_logs
-- coach_notebooks
-- notifications
-- student_notes
--
-- These tables already exist in the live database.
-- Do not recreate or alter them through this patch.

-- 4. message_reads
-- NO CHANGE until the actual RPC definitions
-- (unread_counts and mark_conversation_read)
-- have been inspected and reconciled.

-- 5. institutions
-- Existing correct column names:
-- email
-- logo_path
-- No change required.
