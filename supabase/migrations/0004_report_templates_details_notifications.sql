
-- ============================================================================
-- THE TRAINERS – تدريب
-- MIGRATION 0004 — CORRECTED PRODUCTION VERSION
-- Target project: rxkyryaplszuklagvidi
--
-- Adds:
--   1. Report template metadata
--   2. Student-level report details
--   3. Institution/report/student consistency protection
--   4. Correct report submission notifications
--
-- Safety:
--   - Additive changes only
--   - No table deletion
--   - No data deletion
--   - Existing report_templates policies preserved
--   - Existing daily report protection function preserved
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. REPORT TEMPLATE METADATA
-- ============================================================================

ALTER TABLE public.report_templates
    ADD COLUMN IF NOT EXISTS name text,
    ADD COLUMN IF NOT EXISTS description text,
    ADD COLUMN IF NOT EXISTS instructions text,
    ADD COLUMN IF NOT EXISTS is_archived boolean NOT NULL DEFAULT false;


-- ============================================================================
-- 2. REPORT DETAILS TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.report_details (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    report_id uuid NOT NULL
        REFERENCES public.daily_reports(id)
        ON DELETE CASCADE,

    institution_id uuid NOT NULL
        REFERENCES public.institutions(id)
        ON DELETE CASCADE,

    student_id uuid
        REFERENCES public.students(id)
        ON DELETE SET NULL,

    student_name_snapshot text,
    attendance_status text,
    observation text,
    incident text,
    injury_details text,
    notes text,

    created_by uuid
        REFERENCES public.profiles(id)
        ON DELETE SET NULL,

    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);


-- ============================================================================
-- 3. REPORT DETAILS INDEXES
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_report_details_report_id
    ON public.report_details(report_id);

CREATE INDEX IF NOT EXISTS idx_report_details_institution_id
    ON public.report_details(institution_id);

CREATE INDEX IF NOT EXISTS idx_report_details_student_id
    ON public.report_details(student_id);


-- ============================================================================
-- 4. REPORT DETAILS RELATIONSHIP GUARD
-- Ensures report and student belong to the same institution.
-- Also protects service-role / privileged writes that bypass RLS.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.guard_report_detail_relation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM public.daily_reports r
        WHERE r.id = NEW.report_id
          AND r.institution_id = NEW.institution_id
    ) THEN
        RAISE EXCEPTION
            'Report detail must belong to the same institution as its report';
    END IF;

    IF NEW.student_id IS NOT NULL
       AND NOT EXISTS (
           SELECT 1
           FROM public.students s
           WHERE s.id = NEW.student_id
             AND s.institution_id = NEW.institution_id
       )
    THEN
        RAISE EXCEPTION
            'Report detail student must belong to the same institution';
    END IF;

    RETURN NEW;
END;
$function$;


DROP TRIGGER IF EXISTS report_details_relation_guard
    ON public.report_details;

CREATE TRIGGER report_details_relation_guard
BEFORE INSERT OR UPDATE OF report_id, institution_id, student_id
ON public.report_details
FOR EACH ROW
EXECUTE FUNCTION public.guard_report_detail_relation();


-- ============================================================================
-- 5. ENABLE RLS
-- ============================================================================

ALTER TABLE public.report_details ENABLE ROW LEVEL SECURITY;


-- ============================================================================
-- 6. REPORT DETAILS SELECT POLICY
-- Managers/admins can read institution reports.
-- Coaches can read their own reports.
-- ============================================================================

DO $block$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'report_details'
          AND policyname = 'report_details_select'
    ) THEN
        CREATE POLICY report_details_select
        ON public.report_details
        FOR SELECT
        TO authenticated
        USING (
            institution_id = public.current_institution_id()
            AND (
                public.current_app_role() IN ('manager', 'admin')
                OR EXISTS (
                    SELECT 1
                    FROM public.daily_reports r
                    WHERE r.id = report_details.report_id
                      AND r.institution_id = report_details.institution_id
                      AND r.coach_id = auth.uid()
                )
            )
        );
    END IF;
END;
$block$;


-- ============================================================================
-- 7. REPORT DETAILS INSERT POLICY
-- Coaches can add details only to their own non-finalized reports.
-- Managers/admins can add details within their institution.
-- ============================================================================

DO $block$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'report_details'
          AND policyname = 'report_details_insert'
    ) THEN
        CREATE POLICY report_details_insert
        ON public.report_details
        FOR INSERT
        TO authenticated
        WITH CHECK (
            institution_id = public.current_institution_id()
            AND (
                public.current_app_role() IN ('manager', 'admin')
                OR EXISTS (
                    SELECT 1
                    FROM public.daily_reports r
                    WHERE r.id = report_details.report_id
                      AND r.institution_id = report_details.institution_id
                      AND r.coach_id = auth.uid()
                      AND r.is_finalized = false
                )
            )
            AND (
                student_id IS NULL
                OR EXISTS (
                    SELECT 1
                    FROM public.students s
                    WHERE s.id = report_details.student_id
                      AND s.institution_id = report_details.institution_id
                )
            )
        );
    END IF;
END;
$block$;


-- ============================================================================
-- 8. REPORT DETAILS UPDATE POLICY
-- Full USING and WITH CHECK protections.
-- Coaches cannot edit details of finalized reports.
-- Managers/admins retain institution-level management.
-- ============================================================================

DO $block$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'report_details'
          AND policyname = 'report_details_update'
    ) THEN
        CREATE POLICY report_details_update
        ON public.report_details
        FOR UPDATE
        TO authenticated
        USING (
            institution_id = public.current_institution_id()
            AND (
                public.current_app_role() IN ('manager', 'admin')
                OR EXISTS (
                    SELECT 1
                    FROM public.daily_reports r
                    WHERE r.id = report_details.report_id
                      AND r.institution_id = report_details.institution_id
                      AND r.coach_id = auth.uid()
                      AND r.is_finalized = false
                )
            )
        )
        WITH CHECK (
            institution_id = public.current_institution_id()
            AND (
                public.current_app_role() IN ('manager', 'admin')
                OR EXISTS (
                    SELECT 1
                    FROM public.daily_reports r
                    WHERE r.id = report_details.report_id
                      AND r.institution_id = report_details.institution_id
                      AND r.coach_id = auth.uid()
                      AND r.is_finalized = false
                )
            )
            AND (
                student_id IS NULL
                OR EXISTS (
                    SELECT 1
                    FROM public.students s
                    WHERE s.id = report_details.student_id
                      AND s.institution_id = report_details.institution_id
                )
            )
        );
    END IF;
END;
$block$;


-- ============================================================================
-- 9. REPORT DETAILS DELETE POLICY
-- ============================================================================

DO $block$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'report_details'
          AND policyname = 'report_details_delete'
    ) THEN
        CREATE POLICY report_details_delete
        ON public.report_details
        FOR DELETE
        TO authenticated
        USING (
            institution_id = public.current_institution_id()
            AND (
                public.current_app_role() IN ('manager', 'admin')
                OR EXISTS (
                    SELECT 1
                    FROM public.daily_reports r
                    WHERE r.id = report_details.report_id
                      AND r.institution_id = report_details.institution_id
                      AND r.coach_id = auth.uid()
                      AND r.is_finalized = false
                )
            )
        );
    END IF;
END;
$block$;


-- ============================================================================
-- 10. REPORT SUBMISSION NOTIFICATION FUNCTION
--
-- INSERT: notify only when the new report is finalized.
-- UPDATE: notify only on transition from non-finalized to finalized.
-- Ordinary updates and review updates do not send notifications.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.notify_submitted_report()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN

    IF TG_OP = 'INSERT' THEN

        IF NEW.is_finalized IS NOT TRUE THEN
            RETURN NEW;
        END IF;

    ELSIF TG_OP = 'UPDATE' THEN

        IF OLD.is_finalized IS TRUE
           OR NEW.is_finalized IS NOT TRUE
        THEN
            RETURN NEW;
        END IF;

    ELSE
        RETURN NEW;
    END IF;

    INSERT INTO public.notifications (
        institution_id,
        recipient_id,
        title,
        body,
        notification_type
    )
    SELECT
        NEW.institution_id,
        p.id,
        'Daily report submitted',
        NEW.coach_name_snapshot
            || ' submitted a report for '
            || NEW.report_date::text,
        'report'
    FROM public.profiles p
    WHERE p.institution_id = NEW.institution_id
      AND p.account_status = 'active'
      AND p.role IN ('manager', 'admin');

    RETURN NEW;
END;
$function$;


-- ============================================================================
-- 11. RECREATE THE TWO KNOWN REPORT NOTIFICATION TRIGGERS
-- These are the existing trigger names found in the database audit.
-- ============================================================================

DROP TRIGGER IF EXISTS daily_report_notify
    ON public.daily_reports;

CREATE TRIGGER daily_report_notify
AFTER INSERT
ON public.daily_reports
FOR EACH ROW
WHEN (NEW.is_finalized IS TRUE)
EXECUTE FUNCTION public.notify_submitted_report();


DROP TRIGGER IF EXISTS daily_report_notify_update
    ON public.daily_reports;

CREATE TRIGGER daily_report_notify_update
AFTER UPDATE OF is_finalized
ON public.daily_reports
FOR EACH ROW
WHEN (
    OLD.is_finalized IS NOT TRUE
    AND NEW.is_finalized IS TRUE
)
EXECUTE FUNCTION public.notify_submitted_report();


COMMIT;


-- ============================================================================
-- 12. POST-MIGRATION VERIFICATION
-- ============================================================================

-- Report template columns
SELECT
    column_name,
    data_type,
    is_nullable,
    column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'report_templates'
  AND column_name IN (
      'name',
      'description',
      'instructions',
      'is_archived'
  )
ORDER BY column_name;


-- Report details table columns
SELECT
    column_name,
    data_type,
    is_nullable,
    column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'report_details'
ORDER BY ordinal_position;


-- Report details policies
SELECT
    policyname,
    permissive,
    roles,
    cmd,
    qual,
    with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename = 'report_details'
ORDER BY policyname;


-- Report notification triggers
SELECT
    tgname,
    pg_get_triggerdef(oid, true) AS trigger_definition
FROM pg_trigger
WHERE tgrelid = 'public.daily_reports'::regclass
  AND NOT tgisinternal
  AND tgname IN (
      'daily_report_notify',
      'daily_report_notify_update'
  )
ORDER BY tgname;
