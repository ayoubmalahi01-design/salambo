# THE TRAINERS – تدريب — Supabase Audit: Project Reference Mismatch (STOP)

**Status:** BLOCKED — Supabase project reference mismatch detected. No live database connection was made.
**Date:** 2026-11-15
**Audit mode:** READ-ONLY
**Project directory:** `C:\Users\Admin\Documents\Default Project\tadrib-appjet-source\tadrib-appjet`

---

## 1. Project folder verification (PASSED)

- Folder exists and contains the real application source: `package.json` (`"name": "the-trainers"`, `"version": "1.0.0"`), `src/`, `supabase/`, `scripts/`, `tests/`, `public/`, `docs/`.
- The application source is intact and matches the THE TRAINERS – تدريب project.
- No replacement project was created and no other project was used.

## 2. Supabase reference verification (MISMATCH — STOP)

The user's stated Supabase project:

| Field | Expected (user-provided) |
|---|---|
| Project URL | `https://ikrfxvxbqrmcnnzwrhsz.supabase.co` |
| Project Reference | `ikrfxvxbqrmcnnzwrhsz` |
| Dashboard | `https://supabase.com/dashboard/project/ikrfxvxbqrmcnnzwrhsz` |

The project's actual environment configuration (`.env.local`, read-only):

```
VITE_SUPABASE_URL=https://rxkyryaplszuklagvidi.supabase.co
VITE_SUPABASE_ANON_KEY=sb_publishable_1PCuhwmLFZSgpUi9uPum-w_nKeLkR1Q
```

Resolved reference from `.env.local`: **`rxkyryaplszuklagvidi`**

Comparison:

| | Value |
|---|---|
| Env-configured reference | `rxkyryaplszuklagvidi` |
| User-stated expected reference | `ikrfxvxbqrmcnnzwrhsz` |
| Match | ❌ NO — DIFFERENT PROJECTS |

### Conclusion

The application's `.env.local` points to a **different** Supabase project (`rxkyryaplszuklagvidi`) than the one the user now states is associated with THE TRAINERS (`ikrfxvxbqrmcnnzwrhsz`).

Per the user's own instruction ("If the project points to a different Supabase project, stop the connection and write the difference in the report"), the live database audit has been **stopped**. No connection to either Supabase project was made in this session, and no SQL, RLS, Storage, Auth, Edge Function, or application file changes were executed.

## 3. What was NOT done (and why)

- No REST/PostgREST probes against either project.
- No Schema, RLS, Function, Trigger, Storage, or Edge Function inspection.
- No SQL executed (read-only or otherwise).
- No application files modified (`.env.local` left untouched).
- No audit report beyond this one was written, because the target project could not be confirmed.

## 4. What is needed to proceed

Please confirm one of the following:

1. **The env-configured project is correct** (`rxkyryaplszuklagvidi`) — i.e. the user's stated reference `ikrfxvxbqrmcnnzwrhsz` was a mistake. In that case the audit will run against `rxkyryaplszuklagvidi` and the env config is already correct.

2. **The user-stated project is correct** (`ikrfxvxbqrmcnnzwrhsz`) — i.e. `.env.local` is stale/wrong. In that case, updating `.env.local` to point to `ikrfxvxbqrmcnnzwrhsz` is a file change that requires your explicit approval before I touch it (audit mode forbids silent switching). Once approved, I will update only the two env values and then run the full read-only audit against `ikrfxvxbqrmcnnzwrhsz`.

3. **Neither** — provide the correct reference and credentials.

No further live audit work will be performed until this is resolved. All future audit reports will be written to `docs/supabase-audit/`.

---

## 5. Local project audit (performed without DB connection)

The following was verified locally without any database connection (read-only file inspection):

- `package.json`: name `the-trainers`, version `1.0.0`, private, Vite + React + Supabase JS client.
- Source tree: `src/` (single `App.tsx` ~3400 lines + `lib/`), `supabase/` (SQL + migrations), `scripts/verify-project.mjs`, `tests/` (109 tests), `docs/`.
- Client config reads `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` (or publishable) from `import.meta.env` — see `src/lib/supabase.ts`. No hardcoded project ref in source.
- The Supabase project reference is therefore controlled entirely by `.env.local` (or `.env`), which currently resolves to `rxkyryaplszuklagvidi`.

No SQL, migrations, or application files were executed or modified during this local inspection.
