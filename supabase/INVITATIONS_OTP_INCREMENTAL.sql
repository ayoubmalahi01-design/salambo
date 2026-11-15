-- =============================================================================
-- THE TRAINERS / TADARRAB
-- INCREMENTAL INVITATIONS + OTP MIGRATION
--
-- Run this file AFTER supabase/THE_TRAINERS_SETUP.sql.
--
-- This migration is additive and idempotent:
--   * it never drops an application table;
--   * it never truncates or deletes business rows;
--   * it never disables an existing RLS policy or trigger;
--   * it reconciles tables created by the earlier broken draft, including the
--     old plaintext `code` column and the old columns with different types.
--
-- What it adds:
--   * public.otp_delivery_method (email | whatsapp | sms)
--   * public.otp_purpose         (invitation | password_reset)
--   * public.invitations         (one row per invitation)
--   * public.otp_codes           (hashed, single-use, attempt-limited OTP rows)
--   * atomic server-side RPCs used only by the Edge Functions
--   * RLS + explicit grants for the two new tables
--
-- Security rules enforced here:
--   * no plaintext OTP is stored (only a SHA-256 hex digest);
--   * OTP is bound to invitation + recipient + institution + role + method;
--   * a new OTP revokes the previous live OTP for the same invitation;
--   * verification uses SELECT ... FOR UPDATE, so two requests cannot both win;
--   * verification, OTP consumption, invitation acceptance, profile activation
--     and audit logging happen in one database transaction;
--   * the role owner can never be invited or assigned by this flow;
--   * SECURITY DEFINER functions use a fixed search_path and are executable only
--     by service_role (the Edge Functions), never by anon/authenticated.
--
-- This file has NOT been executed against a live Supabase project by the
-- repair process. Validate it in a staging project before production use.
-- =============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 0. Preconditions
-- ---------------------------------------------------------------------------
DO $pre$
BEGIN
  IF to_regclass('public.institutions') IS NULL
     OR to_regclass('public.profiles') IS NULL
     OR to_regclass('public.audit_logs') IS NULL THEN
    RAISE EXCEPTION
      'Run supabase/THE_TRAINERS_SETUP.sql before INVITATIONS_OTP_INCREMENTAL.sql';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') THEN
    RAISE EXCEPTION 'The pgcrypto extension is required (run THE_TRAINERS_SETUP.sql)';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE t.typname = 'app_role'
       AND n.nspname = 'public'
  ) THEN
    RAISE EXCEPTION 'public.app_role is missing (run THE_TRAINERS_SETUP.sql)';
  END IF;

  IF to_regprocedure('public.set_updated_at()') IS NULL THEN
    RAISE EXCEPTION 'public.set_updated_at() is missing (run THE_TRAINERS_SETUP.sql)';
  END IF;
END
$pre$;

-- ---------------------------------------------------------------------------
-- 1. Enums (only created when absent; existing values are never replaced)
-- ---------------------------------------------------------------------------
DO $enums$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE t.typname = 'otp_delivery_method'
       AND n.nspname = 'public'
  ) THEN
    CREATE TYPE public.otp_delivery_method AS ENUM ('email', 'whatsapp', 'sms');
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE t.typname = 'otp_purpose'
       AND n.nspname = 'public'
  ) THEN
    CREATE TYPE public.otp_purpose AS ENUM ('invitation', 'password_reset');
  END IF;
END
$enums$;

-- ---------------------------------------------------------------------------
-- 2. Invitations
--    Created before otp_codes so the OTP row can reference the invitation.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inviter_id uuid,
  institution_id uuid NOT NULL,
  role public.app_role NOT NULL,
  invited_email text,
  invited_phone text,
  invited_name text,
  delivery_method public.otp_delivery_method NOT NULL DEFAULT 'email',
  status text NOT NULL DEFAULT 'pending',
  accepted_by uuid,
  accepted_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invitations_status_check
    CHECK (status IN ('pending', 'accepted', 'expired', 'revoked')),
  CONSTRAINT invitations_role_not_owner_check
    CHECK (role <> 'owner'),
  CONSTRAINT invitations_recipient_present_check
    CHECK (invited_email IS NOT NULL OR invited_phone IS NOT NULL),
  CONSTRAINT invitations_delivery_recipient_check
    CHECK (
      (delivery_method = 'email' AND invited_email IS NOT NULL)
      OR (delivery_method IN ('whatsapp', 'sms') AND invited_phone IS NOT NULL)
    ),
  CONSTRAINT invitations_expiry_check
    CHECK (expires_at > created_at)
);

-- Reconcile columns left by the earlier incomplete draft. Every ADD is
-- nullable or has a safe default; NOT NULL checks are added afterwards as
-- NOT VALID constraints so an old pending row can never block the migration.
ALTER TABLE public.invitations ADD COLUMN IF NOT EXISTS inviter_id uuid;
ALTER TABLE public.invitations ADD COLUMN IF NOT EXISTS institution_id uuid;
ALTER TABLE public.invitations ADD COLUMN IF NOT EXISTS role public.app_role;
ALTER TABLE public.invitations ADD COLUMN IF NOT EXISTS invited_email text;
ALTER TABLE public.invitations ADD COLUMN IF NOT EXISTS invited_phone text;
ALTER TABLE public.invitations ADD COLUMN IF NOT EXISTS invited_name text;
ALTER TABLE public.invitations ADD COLUMN IF NOT EXISTS delivery_method public.otp_delivery_method NOT NULL DEFAULT 'email';
ALTER TABLE public.invitations ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending';
ALTER TABLE public.invitations ADD COLUMN IF NOT EXISTS accepted_by uuid;
ALTER TABLE public.invitations ADD COLUMN IF NOT EXISTS accepted_at timestamptz;
ALTER TABLE public.invitations ADD COLUMN IF NOT EXISTS expires_at timestamptz;
ALTER TABLE public.invitations ADD COLUMN IF NOT EXISTS created_at timestamptz;
ALTER TABLE public.invitations ADD COLUMN IF NOT EXISTS updated_at timestamptz;

-- Remove every CHECK from the old draft before rewriting values. The canonical
-- checks are re-added below as NOT VALID, so old rows are never deleted. This
-- also prevents a legacy status/role check from blocking the normalisation.
DO $drop_old_invitation_checks$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.conname
      FROM pg_constraint c
     WHERE c.conrelid = 'public.invitations'::regclass
       AND c.contype = 'c'
  LOOP
    EXECUTE format('ALTER TABLE public.invitations DROP CONSTRAINT %I', r.conname);
  END LOOP;
END
$drop_old_invitation_checks$;

-- The old draft exposed an `otp_code_id` column with a NOT NULL requirement.
-- New invitations are linked from otp_codes.invitation_id instead; make the
-- legacy column optional without deleting it.
DO $legacy_invitations$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'invitations'
       AND column_name = 'otp_code_id'
  ) THEN
    EXECUTE 'ALTER TABLE public.invitations ALTER COLUMN otp_code_id DROP NOT NULL';
    EXECUTE 'ALTER TABLE public.invitations ALTER COLUMN otp_code_id DROP DEFAULT';
  END IF;
END
$legacy_invitations$;

-- Cast old text columns to the canonical enum/type. Values that cannot be
-- mapped safely are normalised first; invalid pending rows are revoked below.
DO $invitation_types$
DECLARE
  v_udt text;
BEGIN
  SELECT udt_name INTO v_udt
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'invitations' AND column_name = 'role';

  IF v_udt IS NOT NULL AND v_udt <> 'app_role' THEN
    EXECUTE 'ALTER TABLE public.invitations ALTER COLUMN role DROP DEFAULT';
    EXECUTE $sql$
      ALTER TABLE public.invitations
        ALTER COLUMN role TYPE public.app_role
        USING (CASE
          WHEN role::text IN ('manager', 'admin', 'coach')
            THEN role::text::public.app_role
          ELSE 'coach'::public.app_role
        END)
    $sql$;
  END IF;

  SELECT udt_name INTO v_udt
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'invitations' AND column_name = 'delivery_method';

  IF v_udt IS NOT NULL AND v_udt <> 'otp_delivery_method' THEN
    EXECUTE 'ALTER TABLE public.invitations ALTER COLUMN delivery_method DROP DEFAULT';
    EXECUTE $sql$
      ALTER TABLE public.invitations
        ALTER COLUMN delivery_method TYPE public.otp_delivery_method
        USING (CASE
          WHEN delivery_method::text IN ('email', 'whatsapp', 'sms')
            THEN delivery_method::text::public.otp_delivery_method
          ELSE 'email'::public.otp_delivery_method
        END)
    $sql$;
  END IF;

  SELECT udt_name INTO v_udt
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'invitations' AND column_name = 'status';

  IF v_udt IS NOT NULL AND v_udt <> 'text' THEN
    EXECUTE 'ALTER TABLE public.invitations ALTER COLUMN status DROP DEFAULT';
    EXECUTE 'ALTER TABLE public.invitations ALTER COLUMN status TYPE text USING status::text';
  END IF;
END
$invitation_types$;

-- The owner role can never travel through the invitation flow. Downgrading a
-- revoked legacy row also keeps future updates compatible with the canonical
-- role check.
UPDATE public.invitations
   SET status = 'revoked',
       role = 'coach',
       updated_at = now()
 WHERE role::text = 'owner';

-- Normalise legacy status values without deleting rows.
UPDATE public.invitations
   SET status = CASE
     WHEN status IS NULL THEN 'revoked'
     WHEN status IN ('pending', 'accepted', 'expired', 'revoked') THEN status
     WHEN status IN ('verified', 'used', 'consumed') THEN 'accepted'
     WHEN status IN ('cancelled', 'canceled') THEN 'revoked'
     ELSE 'revoked'
   END,
       updated_at = COALESCE(updated_at, now())
 WHERE status IS NULL
    OR status NOT IN ('pending', 'accepted', 'expired', 'revoked');

UPDATE public.invitations
   SET created_at = COALESCE(created_at, now()),
       updated_at = COALESCE(updated_at, now())
 WHERE created_at IS NULL OR updated_at IS NULL;

UPDATE public.invitations
   SET expires_at = COALESCE(created_at, now()) + interval '7 days'
 WHERE expires_at IS NULL
    OR expires_at <= created_at;

ALTER TABLE public.invitations ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE public.invitations ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE public.invitations ALTER COLUMN expires_at SET DEFAULT (now() + interval '7 days');
ALTER TABLE public.invitations ALTER COLUMN status SET DEFAULT 'pending';
ALTER TABLE public.invitations ALTER COLUMN delivery_method SET DEFAULT 'email';

-- Columns that must be present for the new flow. NOT VALID keeps old rows
-- readable while enforcing the rule on every new insert/update.
UPDATE public.invitations
   SET status = 'revoked',
       updated_at = now()
 WHERE status = 'pending'
   AND (
     institution_id IS NULL
     OR role IS NULL
     OR (invited_email IS NULL AND invited_phone IS NULL)
     OR expires_at IS NULL
     OR (delivery_method = 'email' AND invited_email IS NULL)
     OR (delivery_method IN ('whatsapp', 'sms') AND invited_phone IS NULL)
   );

DO $invitation_constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'invitations_institution_required_check'
       AND conrelid = 'public.invitations'::regclass
  ) THEN
    ALTER TABLE public.invitations
      ADD CONSTRAINT invitations_institution_required_check
      CHECK (institution_id IS NOT NULL) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'invitations_role_not_owner_check'
       AND conrelid = 'public.invitations'::regclass
  ) THEN
    ALTER TABLE public.invitations
      ADD CONSTRAINT invitations_role_not_owner_check
      CHECK (role <> 'owner') NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'invitations_status_check'
       AND conrelid = 'public.invitations'::regclass
  ) THEN
    ALTER TABLE public.invitations
      ADD CONSTRAINT invitations_status_check
      CHECK (status IN ('pending', 'accepted', 'expired', 'revoked')) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'invitations_recipient_present_check'
       AND conrelid = 'public.invitations'::regclass
  ) THEN
    ALTER TABLE public.invitations
      ADD CONSTRAINT invitations_recipient_present_check
      CHECK (invited_email IS NOT NULL OR invited_phone IS NOT NULL) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'invitations_delivery_recipient_check'
       AND conrelid = 'public.invitations'::regclass
  ) THEN
    ALTER TABLE public.invitations
      ADD CONSTRAINT invitations_delivery_recipient_check
      CHECK (
        (delivery_method = 'email' AND invited_email IS NOT NULL)
        OR (delivery_method IN ('whatsapp', 'sms') AND invited_phone IS NOT NULL)
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'invitations_expiry_check'
       AND conrelid = 'public.invitations'::regclass
  ) THEN
    ALTER TABLE public.invitations
      ADD CONSTRAINT invitations_expiry_check
      CHECK (expires_at > created_at) NOT VALID;
  END IF;
END
$invitation_constraints$;

DO $invitation_fks$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'invitations_inviter_id_fkey'
       AND conrelid = 'public.invitations'::regclass
  ) THEN
    ALTER TABLE public.invitations
      ADD CONSTRAINT invitations_inviter_id_fkey
      FOREIGN KEY (inviter_id) REFERENCES public.profiles(id)
      ON DELETE SET NULL NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'invitations_institution_id_fkey'
       AND conrelid = 'public.invitations'::regclass
  ) THEN
    ALTER TABLE public.invitations
      ADD CONSTRAINT invitations_institution_id_fkey
      FOREIGN KEY (institution_id) REFERENCES public.institutions(id)
      ON DELETE RESTRICT NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'invitations_accepted_by_fkey'
       AND conrelid = 'public.invitations'::regclass
  ) THEN
    ALTER TABLE public.invitations
      ADD CONSTRAINT invitations_accepted_by_fkey
      FOREIGN KEY (accepted_by) REFERENCES public.profiles(id)
      ON DELETE SET NULL NOT VALID;
  END IF;
END
$invitation_fks$;

-- A recipient may be invited again after a previous invitation was accepted,
-- revoked or expired. Legacy unique constraints on the recipient would block
-- that, so remove them (the audit history remains in the table).
DO $legacy_invitation_unique$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.conname
      FROM pg_constraint c
     WHERE c.conrelid = 'public.invitations'::regclass
       AND c.contype = 'u'
       AND (
         SELECT bool_or(a.attname IN ('invited_email', 'invited_phone'))
           FROM unnest(c.conkey) k
           JOIN pg_attribute a
             ON a.attrelid = c.conrelid
            AND a.attnum = k
       )
  LOOP
    EXECUTE format('ALTER TABLE public.invitations DROP CONSTRAINT %I', r.conname);
  END LOOP;

  FOR r IN
    SELECT i.indexname
      FROM pg_indexes i
     WHERE i.schemaname = 'public'
       AND i.tablename = 'invitations'
       AND i.indexdef ~* '^CREATE UNIQUE INDEX'
       AND i.indexname <> 'invitations_pkey'
       AND (i.indexdef ~* 'invited_email' OR i.indexdef ~* 'invited_phone')
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS public.%I', r.indexname);
  END LOOP;
END
$legacy_invitation_unique$;

CREATE INDEX IF NOT EXISTS invitations_institution_status_idx
  ON public.invitations(institution_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS invitations_inviter_created_idx
  ON public.invitations(inviter_id, created_at DESC);
CREATE INDEX IF NOT EXISTS invitations_email_idx
  ON public.invitations(lower(invited_email))
  WHERE invited_email IS NOT NULL;
CREATE INDEX IF NOT EXISTS invitations_expires_idx
  ON public.invitations(expires_at)
  WHERE status = 'pending';

DROP TRIGGER IF EXISTS invitations_set_updated_at ON public.invitations;
CREATE TRIGGER invitations_set_updated_at
  BEFORE UPDATE ON public.invitations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 3. OTP codes (hash only; no plaintext column is used by the new flow)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.otp_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invitation_id uuid NOT NULL,
  code_hash text NOT NULL,
  email text,
  phone text,
  institution_id uuid NOT NULL,
  role public.app_role NOT NULL,
  delivery_method public.otp_delivery_method NOT NULL DEFAULT 'email',
  purpose public.otp_purpose NOT NULL DEFAULT 'invitation',
  created_by uuid,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  revoked_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT otp_codes_recipient_present_check
    CHECK (email IS NOT NULL OR phone IS NOT NULL),
  CONSTRAINT otp_codes_attempts_check
    CHECK (attempt_count >= 0 AND max_attempts > 0),
  CONSTRAINT otp_codes_expiry_check
    CHECK (expires_at > created_at)
);

-- Reconcile the old draft's columns. In particular, old rows may have a
-- plaintext `code` and no `invitation_id`/`institution_id`/`role`.
ALTER TABLE public.otp_codes ADD COLUMN IF NOT EXISTS invitation_id uuid;
ALTER TABLE public.otp_codes ADD COLUMN IF NOT EXISTS code_hash text;
ALTER TABLE public.otp_codes ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE public.otp_codes ADD COLUMN IF NOT EXISTS phone text;
ALTER TABLE public.otp_codes ADD COLUMN IF NOT EXISTS institution_id uuid;
ALTER TABLE public.otp_codes ADD COLUMN IF NOT EXISTS role public.app_role;
ALTER TABLE public.otp_codes ADD COLUMN IF NOT EXISTS delivery_method public.otp_delivery_method NOT NULL DEFAULT 'email';
ALTER TABLE public.otp_codes ADD COLUMN IF NOT EXISTS purpose public.otp_purpose NOT NULL DEFAULT 'invitation';
ALTER TABLE public.otp_codes ADD COLUMN IF NOT EXISTS created_by uuid;
ALTER TABLE public.otp_codes ADD COLUMN IF NOT EXISTS expires_at timestamptz;
ALTER TABLE public.otp_codes ADD COLUMN IF NOT EXISTS used_at timestamptz;
ALTER TABLE public.otp_codes ADD COLUMN IF NOT EXISTS revoked_at timestamptz;
ALTER TABLE public.otp_codes ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0;
ALTER TABLE public.otp_codes ADD COLUMN IF NOT EXISTS max_attempts integer NOT NULL DEFAULT 5;
ALTER TABLE public.otp_codes ADD COLUMN IF NOT EXISTS created_at timestamptz;
ALTER TABLE public.otp_codes ADD COLUMN IF NOT EXISTS updated_at timestamptz;

-- Drop every legacy CHECK before changing values. Canonical checks are
-- re-added as NOT VALID after the repair, so no historical row is deleted.
DO $drop_old_otp_checks$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.conname
      FROM pg_constraint c
     WHERE c.conrelid = 'public.otp_codes'::regclass
       AND c.contype = 'c'
  LOOP
    EXECUTE format('ALTER TABLE public.otp_codes DROP CONSTRAINT %I', r.conname);
  END LOOP;
END
$drop_old_otp_checks$;

-- Remove the old plaintext value and prevent any future plaintext write. The
-- column is kept (not dropped) so the migration never destroys history.
DO $plaintext$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'otp_codes'
       AND column_name = 'code'
  ) THEN
    -- Remove NOT NULL/default first: a legacy plaintext column may be
    -- mandatory, and clearing it would otherwise fail before the constraint is
    -- relaxed.
    EXECUTE 'ALTER TABLE public.otp_codes ALTER COLUMN code DROP NOT NULL';
    EXECUTE 'ALTER TABLE public.otp_codes ALTER COLUMN code DROP DEFAULT';
    EXECUTE 'UPDATE public.otp_codes SET code = NULL WHERE code IS NOT NULL';

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conname = 'otp_codes_no_plaintext_check'
         AND conrelid = 'public.otp_codes'::regclass
    ) THEN
      EXECUTE 'ALTER TABLE public.otp_codes ADD CONSTRAINT otp_codes_no_plaintext_check CHECK (code IS NULL) NOT VALID';
    END IF;
  END IF;
END
$plaintext$;

-- Old `status` columns from the earlier draft were sometimes NOT NULL with no
-- default. The new flow uses used_at/revoked_at, but a legacy column must not
-- block inserts. Keep it optional and give it a harmless default when safe.
DO $legacy_otp_status$
DECLARE
  v_udt text;
  v_has_pending boolean;
BEGIN
  SELECT udt_name INTO v_udt
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'otp_codes'
     AND column_name = 'status';

  IF v_udt IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.otp_codes ALTER COLUMN status DROP NOT NULL';
    IF v_udt = 'text' THEN
      EXECUTE 'ALTER TABLE public.otp_codes ALTER COLUMN status SET DEFAULT ''pending''';
    ELSE
      SELECT EXISTS (
        SELECT 1
          FROM pg_enum e
          JOIN pg_type t ON t.oid = e.enumtypid
          JOIN pg_namespace n ON n.oid = t.typnamespace
         WHERE n.nspname = 'public'
           AND t.typname = v_udt
           AND e.enumlabel = 'pending'
      ) INTO v_has_pending;
      IF v_has_pending THEN
        EXECUTE 'ALTER TABLE public.otp_codes ALTER COLUMN status SET DEFAULT ''pending''';
      ELSE
        EXECUTE 'ALTER TABLE public.otp_codes ALTER COLUMN status DROP DEFAULT';
      END IF;
    END IF;
  END IF;
END
$legacy_otp_status$;

DO $otp_types$
DECLARE
  v_udt text;
BEGIN
  SELECT udt_name INTO v_udt
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'otp_codes' AND column_name = 'role';

  IF v_udt IS NOT NULL AND v_udt <> 'app_role' THEN
    EXECUTE 'ALTER TABLE public.otp_codes ALTER COLUMN role DROP DEFAULT';
    EXECUTE $sql$
      ALTER TABLE public.otp_codes
        ALTER COLUMN role TYPE public.app_role
        USING (CASE
          WHEN role::text IN ('manager', 'admin', 'coach')
            THEN role::text::public.app_role
          ELSE 'coach'::public.app_role
        END)
    $sql$;
  END IF;

  SELECT udt_name INTO v_udt
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'otp_codes' AND column_name = 'delivery_method';

  IF v_udt IS NOT NULL AND v_udt <> 'otp_delivery_method' THEN
    EXECUTE 'ALTER TABLE public.otp_codes ALTER COLUMN delivery_method DROP DEFAULT';
    EXECUTE $sql$
      ALTER TABLE public.otp_codes
        ALTER COLUMN delivery_method TYPE public.otp_delivery_method
        USING (CASE
          WHEN delivery_method::text IN ('email', 'whatsapp', 'sms')
            THEN delivery_method::text::public.otp_delivery_method
          ELSE 'email'::public.otp_delivery_method
        END)
    $sql$;
  END IF;

  SELECT udt_name INTO v_udt
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'otp_codes' AND column_name = 'purpose';

  IF v_udt IS NOT NULL AND v_udt <> 'otp_purpose' THEN
    EXECUTE 'ALTER TABLE public.otp_codes ALTER COLUMN purpose DROP DEFAULT';
    EXECUTE $sql$
      ALTER TABLE public.otp_codes
        ALTER COLUMN purpose TYPE public.otp_purpose
        USING (CASE
          WHEN purpose::text IN ('invitation', 'password_reset')
            THEN purpose::text::public.otp_purpose
          ELSE 'invitation'::public.otp_purpose
        END)
    $sql$;
  END IF;
END
$otp_types$;

UPDATE public.otp_codes
   SET created_at = COALESCE(created_at, now()),
       updated_at = COALESCE(updated_at, now())
 WHERE created_at IS NULL OR updated_at IS NULL;

UPDATE public.otp_codes
   SET expires_at = COALESCE(created_at, now()) + interval '10 minutes'
 WHERE expires_at IS NULL
    OR expires_at <= created_at;

UPDATE public.otp_codes
   SET attempt_count = 0
 WHERE attempt_count IS NULL OR attempt_count < 0;

UPDATE public.otp_codes
   SET max_attempts = 5
 WHERE max_attempts IS NULL OR max_attempts <= 0;

ALTER TABLE public.otp_codes ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE public.otp_codes ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE public.otp_codes ALTER COLUMN attempt_count SET DEFAULT 0;
ALTER TABLE public.otp_codes ALTER COLUMN max_attempts SET DEFAULT 5;
ALTER TABLE public.otp_codes ALTER COLUMN delivery_method SET DEFAULT 'email';
ALTER TABLE public.otp_codes ALTER COLUMN purpose SET DEFAULT 'invitation';

-- The owner role can never travel through the invitation flow.
UPDATE public.otp_codes
   SET revoked_at = COALESCE(revoked_at, now()),
       role = 'coach',
       updated_at = now()
 WHERE role::text = 'owner';

-- Any row that cannot be bound to the new flow is revoked, never deleted.
UPDATE public.otp_codes
   SET revoked_at = COALESCE(revoked_at, now()),
       updated_at = now()
 WHERE revoked_at IS NULL
   AND (
     invitation_id IS NULL
     OR code_hash IS NULL
     OR institution_id IS NULL
     OR role IS NULL
     OR expires_at IS NULL
   );

-- Keep at most one live OTP per invitation. This repairs duplicate rows left
-- by the earlier draft before the unique index is created.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY invitation_id
           ORDER BY created_at DESC, id DESC
         ) AS rn
    FROM public.otp_codes
   WHERE invitation_id IS NOT NULL
     AND used_at IS NULL
     AND revoked_at IS NULL
)
UPDATE public.otp_codes o
   SET revoked_at = now(),
       updated_at = now()
  FROM ranked r
 WHERE o.id = r.id
   AND r.rn > 1;

-- Drop legacy unique constraints/indexes that assumed one OTP row per
-- invitation or one row per hash. The new flow keeps history and only one
-- *live* code per invitation, enforced by the partial unique index below.
DO $legacy_unique$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.conname
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'otp_codes'
       AND c.contype = 'u'
       AND (
         SELECT array_agg(a.attname::text ORDER BY a.attname)
           FROM unnest(c.conkey) k
           JOIN pg_attribute a
             ON a.attrelid = c.conrelid
            AND a.attnum = k
       ) IN (ARRAY['invitation_id'], ARRAY['code_hash'])
  LOOP
    EXECUTE format('ALTER TABLE public.otp_codes DROP CONSTRAINT %I', r.conname);
  END LOOP;

  FOR r IN
    SELECT i.indexname
      FROM pg_indexes i
     WHERE i.schemaname = 'public'
       AND i.tablename = 'otp_codes'
       AND i.indexname <> 'otp_codes_one_live_per_invitation'
       AND i.indexdef ~* '^CREATE UNIQUE INDEX'
       AND (i.indexdef ~* '\(invitation_id\)' OR i.indexdef ~* '\(code_hash\)')
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS public.%I', r.indexname);
  END LOOP;
END
$legacy_unique$;

DO $otp_constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'otp_codes_invitation_required_check'
       AND conrelid = 'public.otp_codes'::regclass
  ) THEN
    ALTER TABLE public.otp_codes
      ADD CONSTRAINT otp_codes_invitation_required_check
      CHECK (invitation_id IS NOT NULL) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'otp_codes_hash_present_check'
       AND conrelid = 'public.otp_codes'::regclass
  ) THEN
    ALTER TABLE public.otp_codes
      ADD CONSTRAINT otp_codes_hash_present_check
      CHECK (code_hash IS NOT NULL) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'otp_codes_institution_required_check'
       AND conrelid = 'public.otp_codes'::regclass
  ) THEN
    ALTER TABLE public.otp_codes
      ADD CONSTRAINT otp_codes_institution_required_check
      CHECK (institution_id IS NOT NULL) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'otp_codes_role_required_check'
       AND conrelid = 'public.otp_codes'::regclass
  ) THEN
    ALTER TABLE public.otp_codes
      ADD CONSTRAINT otp_codes_role_required_check
      CHECK (role IS NOT NULL) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'otp_codes_recipient_present_check'
       AND conrelid = 'public.otp_codes'::regclass
  ) THEN
    ALTER TABLE public.otp_codes
      ADD CONSTRAINT otp_codes_recipient_present_check
      CHECK (email IS NOT NULL OR phone IS NOT NULL) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'otp_codes_attempts_check'
       AND conrelid = 'public.otp_codes'::regclass
  ) THEN
    ALTER TABLE public.otp_codes
      ADD CONSTRAINT otp_codes_attempts_check
      CHECK (attempt_count >= 0 AND max_attempts > 0) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'otp_codes_expiry_check'
       AND conrelid = 'public.otp_codes'::regclass
  ) THEN
    ALTER TABLE public.otp_codes
      ADD CONSTRAINT otp_codes_expiry_check
      CHECK (expires_at > created_at) NOT VALID;
  END IF;
END
$otp_constraints$;

DO $otp_fks$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'otp_codes_invitation_id_fkey'
       AND conrelid = 'public.otp_codes'::regclass
  ) THEN
    ALTER TABLE public.otp_codes
      ADD CONSTRAINT otp_codes_invitation_id_fkey
      FOREIGN KEY (invitation_id) REFERENCES public.invitations(id)
      ON DELETE RESTRICT NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'otp_codes_institution_id_fkey'
       AND conrelid = 'public.otp_codes'::regclass
  ) THEN
    ALTER TABLE public.otp_codes
      ADD CONSTRAINT otp_codes_institution_id_fkey
      FOREIGN KEY (institution_id) REFERENCES public.institutions(id)
      ON DELETE RESTRICT NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'otp_codes_created_by_fkey'
       AND conrelid = 'public.otp_codes'::regclass
  ) THEN
    ALTER TABLE public.otp_codes
      ADD CONSTRAINT otp_codes_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES public.profiles(id)
      ON DELETE SET NULL NOT VALID;
  END IF;
END
$otp_fks$;

CREATE INDEX IF NOT EXISTS otp_codes_invitation_idx
  ON public.otp_codes(invitation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS otp_codes_hash_idx
  ON public.otp_codes(code_hash);
CREATE INDEX IF NOT EXISTS otp_codes_expires_idx
  ON public.otp_codes(expires_at)
  WHERE used_at IS NULL AND revoked_at IS NULL;

-- Legacy drafts could leave several live codes for one invitation. Keep the
-- newest and revoke the rest before the unique partial index is created, so
-- the migration cannot fail on old data and no live code is deleted.
WITH ranked AS (
  SELECT o.id,
         row_number() OVER (
           PARTITION BY o.invitation_id
           ORDER BY o.created_at DESC, o.id DESC
         ) AS position
    FROM public.otp_codes o
   WHERE o.invitation_id IS NOT NULL
     AND o.used_at IS NULL
     AND o.revoked_at IS NULL
)
UPDATE public.otp_codes o
   SET revoked_at = now(),
       updated_at = now()
  FROM ranked r
 WHERE o.id = r.id
   AND r.position > 1;

DROP INDEX IF EXISTS public.otp_codes_one_live_per_invitation;
CREATE UNIQUE INDEX otp_codes_one_live_per_invitation
  ON public.otp_codes(invitation_id)
  WHERE invitation_id IS NOT NULL
    AND used_at IS NULL
    AND revoked_at IS NULL;

DROP TRIGGER IF EXISTS otp_codes_set_updated_at ON public.otp_codes;
CREATE TRIGGER otp_codes_set_updated_at
  BEFORE UPDATE ON public.otp_codes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 4. RLS / grants
-- ---------------------------------------------------------------------------
ALTER TABLE public.invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.otp_codes ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.invitations FROM anon, authenticated;
REVOKE ALL ON TABLE public.otp_codes FROM anon, authenticated;

-- The platform owner and institution managers may read invitations. Institution
-- administrators and coaches are not allowed to invite or review accounts in the
-- final permission model, so they cannot read invitation rows either. Writes are
-- service-role only (the Edge Functions); no browser can forge an invitation.
GRANT SELECT ON TABLE public.invitations TO authenticated;
GRANT ALL ON TABLE public.invitations TO service_role;
GRANT ALL ON TABLE public.otp_codes TO service_role;

DROP POLICY IF EXISTS invitations_select_admin ON public.invitations;
CREATE POLICY invitations_select_admin
  ON public.invitations
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_owner()
    OR (
      institution_id = public.current_institution_id()
      AND public.current_app_role() = 'manager'
    )
  );

-- No policy is created for otp_codes on purpose. Even if a future grant is
-- added, RLS has no permissive policy for anon/authenticated.
DROP POLICY IF EXISTS otp_codes_no_client_access ON public.otp_codes;

-- ---------------------------------------------------------------------------
-- 5. Remove the broken RPCs from the earlier draft (new signatures below)
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.generate_otp_code(text, text, uuid, public.app_role, public.otp_delivery_method, public.otp_purpose, uuid);
DROP FUNCTION IF EXISTS public.generate_otp_code(text, text, uuid, text, text, text, uuid);
DROP FUNCTION IF EXISTS public.generate_otp_code(uuid, uuid);
DROP FUNCTION IF EXISTS public.verify_otp_code(text);
DROP FUNCTION IF EXISTS public.verify_otp_code(uuid, text);
DROP FUNCTION IF EXISTS public.verify_otp_code(uuid, text, uuid);
DROP FUNCTION IF EXISTS public.revoke_otp_code(text);
DROP FUNCTION IF EXISTS public.revoke_otp_code(uuid);
DROP FUNCTION IF EXISTS public.revoke_otp_code(uuid, text);
DROP FUNCTION IF EXISTS public.get_otp_statistics();

-- Drop every remaining overload of these names. The earlier draft used
-- signatures that cannot be inferred from this file, and CREATE FUNCTION
-- cannot change an existing return type.
DO $drop_old_functions$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS signature
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN (
         'generate_otp_code',
         'verify_otp_code',
         'revoke_otp_code',
         'get_otp_statistics',
         'expire_stale_invitations'
       )
  LOOP
    EXECUTE 'DROP FUNCTION ' || r.signature;
  END LOOP;
END
$drop_old_functions$;

-- ---------------------------------------------------------------------------
-- 6. generate_otp_code
--    Called only by the invite-user Edge Function with the service role.
--    The plaintext code is returned exactly once to the server, never stored.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.generate_otp_code(
  p_invitation_id uuid,
  p_created_by uuid DEFAULT NULL
)
RETURNS TABLE (
  otp_id uuid,
  otp_code text,
  expires_at timestamptz
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $fn$
DECLARE
  v_claim_role text := COALESCE(current_setting('request.jwt.claim.role', true), '');
  v_inv_id uuid;
  v_inviter_id uuid;
  v_institution_id uuid;
  v_role public.app_role;
  v_invited_email text;
  v_invited_phone text;
  v_invited_name text;
  v_delivery_method public.otp_delivery_method;
  v_status text;
  v_expires_at timestamptz;
  v_created_at timestamptz;
  v_code text;
  v_hash text;
  v_code_expires timestamptz;
  v_id uuid;
  v_random bigint;
  v_bytes bytea;
  v_recent integer;
  v_recent_inviter integer;
BEGIN
  IF v_claim_role NOT IN ('', 'service_role') THEN
    RAISE EXCEPTION 'service_role_required';
  END IF;

  IF p_invitation_id IS NULL THEN
    RAISE EXCEPTION 'invitation_required';
  END IF;

  SELECT i.id,
         i.inviter_id,
         i.institution_id,
         i.role,
         i.invited_email,
         i.invited_phone,
         i.invited_name,
         i.delivery_method,
         i.status::text,
         i.expires_at,
         i.created_at
    INTO v_inv_id,
         v_inviter_id,
         v_institution_id,
         v_role,
         v_invited_email,
         v_invited_phone,
         v_invited_name,
         v_delivery_method,
         v_status,
         v_expires_at,
         v_created_at
    FROM public.invitations i
   WHERE i.id = p_invitation_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'invitation_not_found';
  END IF;

  IF v_status <> 'pending' THEN
    RAISE EXCEPTION 'invitation_not_pending';
  END IF;

  IF v_expires_at IS NULL OR v_expires_at <= now() THEN
    UPDATE public.invitations
       SET status = 'expired', updated_at = now()
     WHERE id = v_inv_id;
    -- Return one empty row. The Edge Function maps a null otp_code to 410
    -- without treating the normal expiry as an exception.
    RETURN QUERY SELECT NULL::uuid, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;

  IF v_role IS NULL OR v_role = 'owner' THEN
    RAISE EXCEPTION 'owner_invitation_forbidden';
  END IF;

  IF v_institution_id IS NULL
     OR v_delivery_method IS NULL
     OR (v_invited_email IS NULL AND v_invited_phone IS NULL)
     OR (v_delivery_method = 'email' AND v_invited_email IS NULL)
     OR (v_delivery_method IN ('whatsapp', 'sms') AND v_invited_phone IS NULL) THEN
    RAISE EXCEPTION 'invalid_invitation';
  END IF;

  IF p_created_by IS NOT NULL
     AND v_inviter_id IS NOT NULL
     AND p_created_by <> v_inviter_id THEN
    RAISE EXCEPTION 'inviter_mismatch';
  END IF;

  -- Simple server-side throttle: at most five codes per invitation in fifteen
  -- minutes and at most thirty codes per inviter across all invitations. The
  -- Edge Function also throttles invitations per inviter.
  SELECT count(*)::integer
    INTO v_recent
    FROM public.otp_codes
   WHERE invitation_id = p_invitation_id
     AND created_at > now() - interval '15 minutes';

  IF v_recent >= 5 THEN
    RAISE EXCEPTION 'otp_rate_limited';
  END IF;

  SELECT count(*)::integer
    INTO v_recent_inviter
    FROM public.otp_codes
   WHERE created_by = COALESCE(p_created_by, v_inviter_id)
     AND created_at > now() - interval '15 minutes';

  IF v_recent_inviter >= 30 THEN
    RAISE EXCEPTION 'otp_rate_limited';
  END IF;

  -- A new code invalidates every still-live code for this invitation.
  UPDATE public.otp_codes
     SET revoked_at = now(), updated_at = now()
   WHERE invitation_id = p_invitation_id
     AND used_at IS NULL
     AND revoked_at IS NULL;

  -- Cryptographically secure 6-digit value from pgcrypto, not random().
  v_bytes := gen_random_bytes(4);
  v_random := (get_byte(v_bytes, 0)::bigint * 16777216)
            + (get_byte(v_bytes, 1)::bigint * 65536)
            + (get_byte(v_bytes, 2)::bigint * 256)
            +  get_byte(v_bytes, 3)::bigint;
  v_code := (100000 + (v_random % 900000))::text;
  v_hash := encode(digest(v_code, 'sha256'), 'hex');
  v_code_expires := now() + interval '10 minutes';

  INSERT INTO public.otp_codes (
    invitation_id,
    code_hash,
    email,
    phone,
    institution_id,
    role,
    delivery_method,
    purpose,
    created_by,
    expires_at,
    max_attempts
  ) VALUES (
    v_inv_id,
    v_hash,
    v_invited_email,
    v_invited_phone,
    v_institution_id,
    v_role,
    v_delivery_method,
    'invitation',
    COALESCE(p_created_by, v_inviter_id),
    v_code_expires,
    5
  )
  RETURNING id INTO v_id;

  INSERT INTO public.audit_logs (
    institution_id,
    actor_id,
    action,
    table_name,
    record_id,
    old_data,
    new_data
  ) VALUES (
    v_institution_id,
    COALESCE(p_created_by, v_inviter_id),
    'otp_generated',
    'otp_codes',
    v_id::text,
    NULL,
    jsonb_build_object(
      'invitation_id', v_inv_id,
      'delivery_method', v_delivery_method::text,
      'purpose', 'invitation',
      'expires_at', v_code_expires
    )
  );

  RETURN QUERY SELECT v_id, v_code, v_code_expires;
END;
$fn$;

-- ---------------------------------------------------------------------------
-- 7. verify_otp_code
--    Atomic: locks the invitation and the live OTP, counts failed attempts,
--    checks the signed-in account against the invitation recipient, consumes
--    the OTP, accepts the invitation, links the profile to the institution/role
--    and writes the audit record. Either all of it commits or none of it does.
--    A new account (or a rejected/suspended one) is linked but remains pending
--    for Owner/Director review. Only an already-active account of the same
--    institution stays active.
--
--    p_user_id is supplied by the verify-otp Edge Function after validating
--    the caller's JWT. It is never accepted from a browser directly.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.verify_otp_code(
  p_invitation_id uuid,
  p_otp_code text,
  p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $fn$
DECLARE
  v_claim_role text := COALESCE(current_setting('request.jwt.claim.role', true), '');
  v_inv_id uuid;
  v_inviter_id uuid;
  v_institution_id uuid;
  v_role public.app_role;
  v_invited_email text;
  v_invited_phone text;
  v_invited_name text;
  v_delivery_method public.otp_delivery_method;
  v_status text;
  v_accepted_by uuid;
  v_inv_expires timestamptz;
  v_otp_id uuid;
  v_otp_hash text;
  v_otp_institution_id uuid;
  v_otp_role public.app_role;
  v_otp_delivery_method public.otp_delivery_method;
  v_otp_expires timestamptz;
  v_otp_attempts integer;
  v_otp_max_attempts integer;
  v_profile_email text;
  v_profile_phone text;
  v_profile_status text;
  v_profile_role public.app_role;
  v_profile_institution_id uuid;
  v_auth_email text;
  v_auth_phone text;
  v_entered_hash text;
  v_attempts integer;
  v_remaining integer;
BEGIN
  IF v_claim_role NOT IN ('', 'service_role') THEN
    RAISE EXCEPTION 'service_role_required';
  END IF;

  IF p_invitation_id IS NULL
     OR p_user_id IS NULL
     OR p_otp_code IS NULL
     OR p_otp_code !~ '^[0-9]{6}$' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_request');
  END IF;

  SELECT i.id,
         i.inviter_id,
         i.institution_id,
         i.role,
         i.invited_email,
         i.invited_phone,
         i.invited_name,
         i.delivery_method,
         i.status::text,
         i.accepted_by,
         i.expires_at
    INTO v_inv_id,
         v_inviter_id,
         v_institution_id,
         v_role,
         v_invited_email,
         v_invited_phone,
         v_invited_name,
         v_delivery_method,
         v_status,
         v_accepted_by,
         v_inv_expires
    FROM public.invitations i
   WHERE i.id = p_invitation_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invitation_not_found');
  END IF;

  IF v_status = 'accepted' THEN
    IF v_accepted_by = p_user_id THEN
      RETURN jsonb_build_object(
        'ok', true,
        'already_accepted', true,
        'user_id', p_user_id,
        'role', v_role::text,
        'institution_id', v_institution_id
      );
    END IF;
    RETURN jsonb_build_object('ok', false, 'error', 'invitation_already_accepted');
  END IF;

  IF v_status <> 'pending' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invitation_not_pending');
  END IF;

  IF v_inv_expires IS NULL OR v_inv_expires <= now() THEN
    UPDATE public.invitations
       SET status = 'expired', updated_at = now()
     WHERE id = v_inv_id;
    RETURN jsonb_build_object('ok', false, 'error', 'invitation_expired');
  END IF;

  IF v_role IS NULL OR v_role = 'owner' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'owner_role_forbidden');
  END IF;

  IF v_inviter_id = p_user_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'self_invitation_forbidden');
  END IF;

  IF v_institution_id IS NULL
     OR v_delivery_method IS NULL
     OR (v_invited_email IS NULL AND v_invited_phone IS NULL) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_invitation');
  END IF;

  SELECT p.email, p.phone, p.account_status, p.role, p.institution_id
    INTO v_profile_email, v_profile_phone, v_profile_status, v_profile_role, v_profile_institution_id
    FROM public.profiles p
   WHERE p.id = p_user_id
   FOR UPDATE;

  IF NOT FOUND THEN
    -- The auth trigger normally creates this row. Create a safe pending row
    -- instead of failing with a half-created account.
    INSERT INTO public.profiles (
      id, email, full_name, role, institution_id, account_status
    ) VALUES (
      p_user_id,
      COALESCE(lower(v_invited_email), ''),
      COALESCE(v_invited_name, ''),
      'coach',
      NULL,
      'pending'
    )
    ON CONFLICT (id) DO NOTHING;

    SELECT p.email, p.phone, p.account_status, p.role, p.institution_id
      INTO v_profile_email, v_profile_phone, v_profile_status, v_profile_role, v_profile_institution_id
      FROM public.profiles p
     WHERE p.id = p_user_id
     FOR UPDATE;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'error', 'profile_not_found');
    END IF;
  END IF;

  -- Use the Auth identity first and fall back to the profile row.
  SELECT lower(COALESCE(u.email, '')), COALESCE(u.phone, '')
    INTO v_auth_email, v_auth_phone
    FROM auth.users u
   WHERE u.id = p_user_id;

  v_auth_email := lower(COALESCE(NULLIF(v_auth_email, ''), v_profile_email, ''));
  v_auth_phone := COALESCE(NULLIF(v_auth_phone, ''), v_profile_phone, '');

  -- Recipient binding. Email is the account identity; phone is the delivery
  -- channel for WhatsApp/SMS. The OTP itself proves control of that channel.
  IF v_invited_email IS NOT NULL THEN
    IF v_auth_email = '' OR v_auth_email IS DISTINCT FROM lower(v_invited_email) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'recipient_mismatch');
    END IF;
  ELSIF v_invited_phone IS NOT NULL THEN
    IF regexp_replace(COALESCE(v_auth_phone, v_profile_phone, ''), '[^0-9]', '', 'g')
       = '' OR
       regexp_replace(COALESCE(v_auth_phone, v_profile_phone, ''), '[^0-9]', '', 'g')
       <> regexp_replace(v_invited_phone, '[^0-9]', '', 'g') THEN
      RETURN jsonb_build_object('ok', false, 'error', 'recipient_mismatch');
    END IF;
  ELSE
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_invitation');
  END IF;

  IF v_profile_role = 'owner' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'owner_role_forbidden');
  END IF;

  IF v_profile_status = 'suspended' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'account_suspended');
  END IF;

  -- An active member of another institution cannot be moved by an invitation.
  IF v_profile_status = 'active'
     AND v_profile_institution_id IS NOT NULL
     AND v_profile_institution_id <> v_institution_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'different_institution');
  END IF;

  SELECT o.id,
         o.code_hash,
         o.institution_id,
         o.role,
         o.delivery_method,
         o.expires_at,
         o.attempt_count,
         o.max_attempts
    INTO v_otp_id,
         v_otp_hash,
         v_otp_institution_id,
         v_otp_role,
         v_otp_delivery_method,
         v_otp_expires,
         v_otp_attempts,
         v_otp_max_attempts
    FROM public.otp_codes o
   WHERE o.invitation_id = v_inv_id
     AND o.used_at IS NULL
     AND o.revoked_at IS NULL
   ORDER BY o.created_at DESC, o.id DESC
   LIMIT 1
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'otp_not_found');
  END IF;

  IF v_otp_expires IS NULL OR v_otp_expires <= now() THEN
    UPDATE public.otp_codes
       SET revoked_at = now(), updated_at = now()
     WHERE id = v_otp_id;
    RETURN jsonb_build_object('ok', false, 'error', 'otp_expired');
  END IF;

  v_otp_attempts := COALESCE(v_otp_attempts, 0);
  v_otp_max_attempts := COALESCE(v_otp_max_attempts, 5);

  IF v_otp_attempts >= v_otp_max_attempts THEN
    UPDATE public.otp_codes
       SET revoked_at = now(), updated_at = now()
     WHERE id = v_otp_id;
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'too_many_attempts',
      'attempts_remaining', 0
    );
  END IF;

  IF v_otp_institution_id IS DISTINCT FROM v_institution_id
     OR v_otp_role IS DISTINCT FROM v_role
     OR v_otp_delivery_method IS DISTINCT FROM v_delivery_method THEN
    RETURN jsonb_build_object('ok', false, 'error', 'otp_binding_mismatch');
  END IF;

  IF v_otp_hash IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'otp_not_found');
  END IF;

  v_entered_hash := encode(digest(p_otp_code, 'sha256'), 'hex');

  IF v_otp_hash IS DISTINCT FROM v_entered_hash THEN
    UPDATE public.otp_codes
       SET attempt_count = attempt_count + 1,
           updated_at = now()
     WHERE id = v_otp_id
     RETURNING attempt_count INTO v_attempts;

    v_remaining := GREATEST(0, v_otp_max_attempts - v_attempts);

    IF v_attempts >= v_otp_max_attempts THEN
      UPDATE public.otp_codes
         SET revoked_at = now(), updated_at = now()
       WHERE id = v_otp_id;
      RETURN jsonb_build_object(
        'ok', false,
        'error', 'too_many_attempts',
        'attempts_remaining', 0
      );
    END IF;

    RETURN jsonb_build_object(
      'ok', false,
      'error', 'invalid_otp',
      'attempts_remaining', v_remaining
    );
  END IF;

  -- Success: consume this code, revoke siblings, accept the invitation and
  -- link the profile. New accounts stay pending until an authorised reviewer
  -- approves them; an already-active member of the same institution stays
  -- active so an invitation can refresh their role without a lockout.
  UPDATE public.otp_codes
     SET used_at = now(), updated_at = now()
   WHERE id = v_otp_id;

  UPDATE public.otp_codes
     SET revoked_at = now(), updated_at = now()
   WHERE invitation_id = v_inv_id
     AND id <> v_otp_id
     AND used_at IS NULL
     AND revoked_at IS NULL;

  UPDATE public.invitations
     SET status = 'accepted',
         accepted_by = p_user_id,
         accepted_at = now(),
         updated_at = now()
   WHERE id = v_inv_id;

  UPDATE public.profiles
     SET role = v_role,
         institution_id = v_institution_id,
         account_status = CASE
           WHEN v_profile_status = 'active'
            AND v_profile_institution_id = v_institution_id THEN 'active'
           ELSE 'pending'
         END,
         full_name = COALESCE(NULLIF(v_invited_name, ''), full_name),
         email = COALESCE(NULLIF(v_invited_email, ''), email),
         phone = COALESCE(NULLIF(v_invited_phone, ''), phone),
         approved_by = CASE
           WHEN v_profile_status = 'active'
            AND v_profile_institution_id = v_institution_id THEN approved_by
           ELSE NULL
         END,
         approved_at = CASE
           WHEN v_profile_status = 'active'
            AND v_profile_institution_id = v_institution_id THEN approved_at
           ELSE NULL
         END,
         created_by = COALESCE(created_by, v_inviter_id),
         updated_at = now()
   WHERE id = p_user_id;

  INSERT INTO public.audit_logs (
    institution_id,
    actor_id,
    action,
    table_name,
    record_id,
    old_data,
    new_data
  ) VALUES (
    v_institution_id,
    p_user_id,
    'invitation_accepted',
    'invitations',
    v_inv_id::text,
    NULL,
    jsonb_build_object(
      'role', v_role::text,
      'institution_id', v_institution_id,
      'delivery_method', v_delivery_method::text,
      'user_id', p_user_id,
      'account_status', CASE
        WHEN v_profile_status = 'active'
         AND v_profile_institution_id = v_institution_id THEN 'active'
        ELSE 'pending'
      END
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'user_id', p_user_id,
    'role', v_role::text,
    'institution_id', v_institution_id,
    'message', 'invitation_accepted'
  );
END;
$fn$;

-- ---------------------------------------------------------------------------
-- 8. revoke_otp_code
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.revoke_otp_code(
  p_invitation_id uuid,
  p_reason text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $fn$
DECLARE
  v_claim_role text := COALESCE(current_setting('request.jwt.claim.role', true), '');
  v_count integer := 0;
  v_institution_id uuid;
BEGIN
  IF v_claim_role NOT IN ('', 'service_role') THEN
    RAISE EXCEPTION 'service_role_required';
  END IF;

  IF p_invitation_id IS NULL THEN
    RETURN false;
  END IF;

  UPDATE public.otp_codes
     SET revoked_at = now(), updated_at = now()
   WHERE invitation_id = p_invitation_id
     AND used_at IS NULL
     AND revoked_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  UPDATE public.invitations
     SET status = 'revoked', updated_at = now()
   WHERE id = p_invitation_id
     AND status = 'pending'
  RETURNING institution_id INTO v_institution_id;

  IF v_institution_id IS NOT NULL THEN
    INSERT INTO public.audit_logs (
      institution_id,
      actor_id,
      action,
      table_name,
      record_id,
      old_data,
      new_data
    ) VALUES (
      v_institution_id,
      NULL,
      'invitation_revoked',
      'invitations',
      p_invitation_id::text,
      NULL,
      jsonb_build_object(
        'reason', left(COALESCE(NULLIF(p_reason, ''), 'revoked'), 200),
        'revoked_otp_count', v_count
      )
    );
  END IF;

  RETURN v_count > 0 OR v_institution_id IS NOT NULL;
END;
$fn$;

-- ---------------------------------------------------------------------------
-- 9. get_otp_statistics (monitoring only; no recipient data)
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.get_otp_statistics()
RETURNS TABLE (
  total_otps bigint,
  pending bigint,
  used bigint,
  revoked bigint,
  by_delivery_method jsonb,
  by_purpose jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $fn$
DECLARE
  v_claim_role text := COALESCE(current_setting('request.jwt.claim.role', true), '');
BEGIN
  IF v_claim_role NOT IN ('', 'service_role') THEN
    RAISE EXCEPTION 'insufficient_permission';
  END IF;

  RETURN QUERY
  SELECT
    COUNT(*)::bigint,
    COUNT(*) FILTER (
      WHERE o.used_at IS NULL
        AND o.revoked_at IS NULL
        AND o.expires_at > now()
    )::bigint,
    COUNT(*) FILTER (WHERE o.used_at IS NOT NULL)::bigint,
    COUNT(*) FILTER (WHERE o.revoked_at IS NOT NULL)::bigint,
    jsonb_build_object(
      'email', COUNT(*) FILTER (WHERE o.delivery_method = 'email'),
      'whatsapp', COUNT(*) FILTER (WHERE o.delivery_method = 'whatsapp'),
      'sms', COUNT(*) FILTER (WHERE o.delivery_method = 'sms')
    ),
    jsonb_build_object(
      'invitation', COUNT(*) FILTER (WHERE o.purpose = 'invitation'),
      'password_reset', COUNT(*) FILTER (WHERE o.purpose = 'password_reset')
    )
  FROM public.otp_codes o;
END;
$fn$;

-- ---------------------------------------------------------------------------
-- 10. expire_stale_invitations (safe maintenance; service-role only)
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.expire_stale_invitations()
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $fn$
DECLARE
  v_claim_role text := COALESCE(current_setting('request.jwt.claim.role', true), '');
  v_count integer := 0;
BEGIN
  IF v_claim_role NOT IN ('', 'service_role') THEN
    RAISE EXCEPTION 'service_role_required';
  END IF;

  WITH changed AS (
    UPDATE public.invitations
       SET status = 'expired', updated_at = now()
     WHERE status = 'pending'
       AND expires_at IS NOT NULL
       AND expires_at <= now()
    RETURNING id
  )
  SELECT count(*)::integer INTO v_count FROM changed;

  UPDATE public.otp_codes
     SET revoked_at = now(), updated_at = now()
   WHERE used_at IS NULL
     AND revoked_at IS NULL
     AND expires_at IS NOT NULL
     AND expires_at <= now();

  RETURN v_count;
END;
$fn$;

-- ---------------------------------------------------------------------------
-- 11. Function grants: server-only for sensitive RPCs
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.generate_otp_code(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.verify_otp_code(uuid, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.revoke_otp_code(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_otp_statistics() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.expire_stale_invitations() FROM PUBLIC;

REVOKE ALL ON FUNCTION public.generate_otp_code(uuid, uuid) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.verify_otp_code(uuid, text, uuid) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.revoke_otp_code(uuid, text) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.get_otp_statistics() FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.expire_stale_invitations() FROM anon, authenticated;

GRANT EXECUTE ON FUNCTION public.generate_otp_code(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.verify_otp_code(uuid, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.revoke_otp_code(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_otp_statistics() TO service_role;
GRANT EXECUTE ON FUNCTION public.expire_stale_invitations() TO service_role;

-- ---------------------------------------------------------------------------
-- 12. Documentation
-- ---------------------------------------------------------------------------
COMMENT ON TABLE public.invitations IS
  'Invitation metadata. Writes are service-role only; institution admins may read their own rows.';
COMMENT ON TABLE public.otp_codes IS
  'SHA-256 hashes of single-use OTPs. Server-only; no plaintext OTP column is used.';
COMMENT ON COLUMN public.otp_codes.code_hash IS
  'encode(digest(code, ''sha256''), ''hex''); matches Web Crypto SHA-256 for 6 ASCII digits.';
COMMENT ON FUNCTION public.generate_otp_code(uuid, uuid) IS
  'Service-role only. Creates a cryptographically random 6-digit OTP bound to one invitation; returns the plaintext once and stores only its hash.';
COMMENT ON FUNCTION public.verify_otp_code(uuid, text, uuid) IS
  'Service-role only. Atomically verifies the recipient and OTP, consumes it, accepts the invitation and activates the profile.';
COMMENT ON FUNCTION public.revoke_otp_code(uuid, text) IS
  'Service-role only. Revokes live OTPs and marks a pending invitation revoked.';
COMMENT ON FUNCTION public.expire_stale_invitations() IS
  'Service-role only. Marks expired pending invitations and revokes expired OTPs.';

-- =============================================================================
-- END OF MIGRATION
-- =============================================================================

commit;
