
-- ============================================================================
-- THE TRAINERS – تدريب
-- SAFE RLS / STORAGE AUDIT SCRIPT
-- Target: rxkyryaplszuklagvidi
-- READ-ONLY VERIFICATION ONLY – NOT A DEPLOYMENT SCRIPT
-- ============================================================================

-- §1. VERIFY RLS STATUS
-- Read-only: inspect which public tables have RLS enabled.
-- Do NOT enable RLS automatically before reviewing existing policies.

SELECT
    schemaname,
    tablename,
    rowsecurity AS rls_enabled
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tablename;


-- §2. VERIFY EXISTING RLS POLICIES
-- Read-only.

SELECT
    schemaname,
    tablename,
    policyname,
    permissive,
    roles,
    cmd,
    qual,
    with_check
FROM pg_policies
WHERE schemaname IN ('public', 'storage')
ORDER BY schemaname, tablename, policyname;


-- §3. VERIFY STORAGE BUCKETS
-- Read-only.

SELECT
    id,
    name,
    public,
    created_at,
    updated_at
FROM storage.buckets
ORDER BY name;


-- §4. VERIFY STORAGE POLICIES
-- Read-only.

SELECT
    policyname,
    permissive,
    roles,
    cmd,
    qual,
    with_check
FROM pg_policies
WHERE schemaname = 'storage'
  AND tablename = 'objects'
ORDER BY policyname;


-- §5. VERIFY TRIGGERS
-- Read-only.

SELECT
    tgname,
    tgrelid::regclass AS table_name
FROM pg_trigger
WHERE NOT tgisinternal
ORDER BY table_name, tgname;


-- §6. VERIFY PUBLIC RPC FUNCTIONS
-- Read-only: inspect function names and definitions.

SELECT
    p.proname,
    pg_get_function_identity_arguments(p.oid) AS arguments,
    pg_get_functiondef(p.oid) AS definition
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
ORDER BY p.proname;


-- ============================================================================
-- IMPORTANT:
-- No RLS changes.
-- No policy creation or deletion.
-- No Storage bucket creation or modification.
-- No data changes.
-- No Edge Function deployment.
-- Review the actual results before preparing production fixes.
-- ============================================================================
