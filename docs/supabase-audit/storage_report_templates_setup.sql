
-- ============================================================================
-- THE TRAINERS – تدريب
-- STORAGE: REPORT TEMPLATES
-- Target: rxkyryaplszuklagvidi
-- Additive and scoped setup
-- ============================================================================

BEGIN;

-- 1. Create the private bucket only if it does not already exist.
-- Existing bucket configuration and stored files are not overwritten.

INSERT INTO storage.buckets (
    id,
    name,
    public,
    file_size_limit,
    allowed_mime_types
)
VALUES (
    'trainer-report-templates',
    'trainer-report-templates',
    false,
    10485760,
    ARRAY[
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ]::text[]
)
ON CONFLICT (id) DO NOTHING;


-- 2. Remove only the four policies dedicated to this bucket.
-- No other bucket policies are modified.

DROP POLICY IF EXISTS report_templates_read
ON storage.objects;

DROP POLICY IF EXISTS report_templates_write
ON storage.objects;

DROP POLICY IF EXISTS report_templates_update
ON storage.objects;

DROP POLICY IF EXISTS report_templates_delete
ON storage.objects;


-- 3. READ:
-- Every active member can read templates belonging to their institution.

CREATE POLICY report_templates_read
ON storage.objects
FOR SELECT
TO authenticated
USING (
    bucket_id = 'trainer-report-templates'
    AND public.is_active_member()
    AND (storage.foldername(name))[1]
        = public.current_institution_id()::text
    AND (storage.foldername(name))[2] = 'report-templates'
);


-- 4. INSERT:
-- Only managers and admins can upload templates.

CREATE POLICY report_templates_write
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
    bucket_id = 'trainer-report-templates'
    AND public.is_active_member()
    AND public.current_app_role() IN ('manager', 'admin')
    AND (storage.foldername(name))[1]
        = public.current_institution_id()::text
    AND (storage.foldername(name))[2] = 'report-templates'
);


-- 5. UPDATE:
-- Only managers and admins can update templates in their institution.

CREATE POLICY report_templates_update
ON storage.objects
FOR UPDATE
TO authenticated
USING (
    bucket_id = 'trainer-report-templates'
    AND public.is_active_member()
    AND public.current_app_role() IN ('manager', 'admin')
    AND (storage.foldername(name))[1]
        = public.current_institution_id()::text
    AND (storage.foldername(name))[2] = 'report-templates'
)
WITH CHECK (
    bucket_id = 'trainer-report-templates'
    AND public.is_active_member()
    AND public.current_app_role() IN ('manager', 'admin')
    AND (storage.foldername(name))[1]
        = public.current_institution_id()::text
    AND (storage.foldername(name))[2] = 'report-templates'
);


-- 6. DELETE:
-- Only managers and admins can delete templates in their institution.

CREATE POLICY report_templates_delete
ON storage.objects
FOR DELETE
TO authenticated
USING (
    bucket_id = 'trainer-report-templates'
    AND public.is_active_member()
    AND public.current_app_role() IN ('manager', 'admin')
    AND (storage.foldername(name))[1]
        = public.current_institution_id()::text
    AND (storage.foldername(name))[2] = 'report-templates'
);

COMMIT;


-- ============================================================================
-- 7. VERIFICATION
-- Run these SELECT queries after the transaction.
-- ============================================================================

-- A. Verify bucket configuration.
SELECT
    id,
    name,
    public,
    file_size_limit,
    allowed_mime_types
FROM storage.buckets
WHERE id = 'trainer-report-templates';


-- B. Verify policies on the new bucket.
SELECT
    policyname,
    cmd,
    roles,
    qual,
    with_check
FROM pg_policies
WHERE schemaname = 'storage'
  AND tablename = 'objects'
  AND policyname IN (
      'report_templates_read',
      'report_templates_write',
      'report_templates_update',
      'report_templates_delete'
  )
ORDER BY policyname;
