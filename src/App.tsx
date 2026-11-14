import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { NavLink, Route, Routes, useNavigate } from 'react-router-dom'
import {
  Activity, Archive, Bell, Building2, CalendarDays, Check, ChevronLeft, ClipboardList,
  FileUp, GraduationCap, HeartPulse, History, Home, Languages, LogOut, Menu,
  MessageCircle, Mic, NotebookPen, Paperclip, Pencil, Plus, Search, Send,
  Settings as SettingsIcon, ShieldCheck, Square, Trash2, UserPlus, Users, X,
  type LucideIcon,
} from 'lucide-react'
import type { Session } from '@supabase/supabase-js'
import { supabase, isConfigured } from './lib/supabase'
import { makeT, isRtl, setDateLocale, formatDateTime, formatTime, type Lang } from './lib/i18n'
import { notify, setToastListener } from './lib/toast'
import {
  loadAttendance, saveAttendance, buildAttendanceRows, NO_SESSION,
} from './lib/attendance'
import {
  accountGate, gateTitleKey, gateBodyKey, gateAllowsRetry, type GateState,
} from './lib/account-gate'
import {
  loadReportDraft, saveReportDraft, clearReportDraft, hasDraftContent,
  type ReportCounts,
} from './lib/report-draft'
import {
  pushEnv, pushNotification, requestPushPermission, type PushPermission,
} from './lib/push-notify'

type Role = 'owner' | 'manager' | 'admin' | 'coach'
type Profile = {
  id: string
  full_name: string
  email: string
  role: Role
  institution_id: string | null
  account_status: string
  preferred_language: Lang
}
type T = (key: string) => string
type Student = {
  id: string
  student_code: string
  full_name: string
  is_active: boolean
  date_of_birth?: string | null
  institution_id?: string | null
}
type Person = {
  id: string
  full_name: string
  email: string
  role?: string
  account_status?: string
}
type Conversation = {
  id: string
  title: string | null
  conversation_type: string
  created_by: string
  created_at: string
  label?: string
  people?: Person[]
}
type ChatMessage = {
  id: string
  body: string | null
  sender_id: string
  created_at: string
  message_type: string
  media_path: string | null
  profiles?: { full_name?: string | null } | null
  media_url?: string
}
type ReportRow = {
  id: string
  coach_id: string
  coach_name_snapshot: string
  report_date: string
  present_count: number
  absent_count: number
  late_count: number
  injured_count: number
  excused_count: number
  notes?: string | null
  status: string
  is_finalized: boolean
  reviewed_by?: string | null
  created_at: string
}
type MedicalRecord = {
  id: string
  student_id: string
  record_type: string
  details: string
  start_date?: string | null
  end_date?: string | null
  attachment_path?: string | null
  attachment_url?: string
  created_at: string
}
type AuditRow = {
  id: number | string
  actor_id?: string | null
  action: string
  table_name: string
  record_id?: string | null
  old_data?: unknown
  new_data?: unknown
  created_at: string
  profiles?: { full_name?: string | null } | null
}

function localDate() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** True when Supabase redirected back with a password-recovery or invite token. */
function passwordSetupLink(): 'recovery' | 'invite' | null {
  if (typeof window === 'undefined') return null
  try {
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''))
    const type = hash.get('type') || new URLSearchParams(window.location.search).get('type')
    return type === 'recovery' || type === 'invite' ? type : null
  } catch {
    return null
  }
}

function defaultLocalProfile(): Profile {
  return {
    id: 'local-preview',
    full_name: '',
    email: '',
    role: 'owner',
    institution_id: null,
    account_status: 'active',
    preferred_language: 'ar',
  }
}

function parseStudentPaste(raw: string): { student_code: string; full_name: string }[] {
  const lines = raw.replace(/\r/g, '').split('\n').map((x) => x.trim()).filter(Boolean)
  if (!lines.length) return []
  const delimiter = lines[0].includes('\t') ? '\t' : (lines[0].includes(';') ? ';' : ',')
  const parse = (line: string) => {
    const out: string[] = []
    let value = ''
    let quoted = false
    for (let i = 0; i < line.length; i++) {
      const c = line[i]
      if (c === '"') {
        if (quoted && line[i + 1] === '"') { value += '"'; i++ } else quoted = !quoted
      } else if (c === delimiter && !quoted) {
        out.push(value.trim()); value = ''
      } else value += c
    }
    out.push(value.trim())
    return out
  }
  const rows = lines.map(parse)
  const first = rows[0].map((x) => x.toLowerCase())
  const codeNames = ['code', 'student_code', 'الرقم', 'رمز']
  const nameNames = ['name', 'full_name', 'الاسم', 'اسم التلميذ', 'الاسم الكامل']
  const hasHeader = first.some((x) => codeNames.includes(x) || nameNames.includes(x))
  const data = hasHeader ? rows.slice(1) : rows
  const header = hasHeader ? first : []
  return data.map((cols) => {
    let codeIndex = hasHeader ? header.findIndex((x) => codeNames.includes(x)) : 0
    let nameIndex = hasHeader ? header.findIndex((x) => nameNames.includes(x)) : 1
    if (codeIndex < 0) codeIndex = 0
    if (nameIndex < 0) nameIndex = 1
    return {
      student_code: (cols[codeIndex] || '').trim(),
      full_name: (cols[nameIndex] || '').trim(),
    }
  }).filter((x) => x.student_code && x.full_name)
}

const roleLabel = (role: string, t: T) => t(role)
const emptyCounts = (): ReportCounts => ({
  present_count: 0, absent_count: 0, late_count: 0, injured_count: 0, excused_count: 0,
})
export default function App() {
  const [lang, setLang] = useState<Lang>(() => {
    try {
      const saved = localStorage.getItem('tt_lang')
      return saved === 'ar' || saved === 'fr' || saved === 'en' ? saved : 'ar'
    } catch { return 'ar' }
  })
  const [session, setSession] = useState<Session | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [profileError, setProfileError] = useState('')
  const [localProfile, setLocalProfile] = useState<Profile>(defaultLocalProfile)
  const [passwordSetup, setPasswordSetup] = useState<'recovery' | 'invite' | null>(passwordSetupLink)
  const [busy, setBusy] = useState(true)
  const [menu, setMenu] = useState(false)
  const [toast, setToast] = useState('')
  const [unread, setUnread] = useState(0)
  const nav = useNavigate()
  const t: T = useMemo(() => makeT(lang), [lang])
  const rtl = isRtl(lang)
  const isLocalMode = !isConfigured
  const gate: GateState = accountGate(profile, profileError)

  useEffect(() => {
    document.documentElement.lang = lang
    document.documentElement.dir = rtl ? 'rtl' : 'ltr'
    setDateLocale(lang)
    try { localStorage.setItem('tt_lang', lang) } catch { /* storage is optional */ }
  }, [lang, rtl])

  useEffect(() => setToastListener(setToast), [])

  useEffect(() => {
    if (!toast) return
    const id = window.setTimeout(() => setToast(''), 4200)
    return () => window.clearTimeout(id)
  }, [toast])

  async function loadProfile(id: string) {
    if (!isConfigured) return
    const { data, error } = await supabase.from('profiles').select('*').eq('id', id).maybeSingle()
    if (error) {
      setProfileError(error.message)
      setProfile(null)
      return
    }
    setProfileError('')
    setProfile((data as Profile | null) ?? null)
  }

  useEffect(() => {
    if (!isConfigured) { setBusy(false); return }
    let alive = true
    const sync = async (id: string) => {
      await loadProfile(id)
      if (alive) setBusy(false)
    }
    supabase.auth.getSession().then(({ data }) => {
      if (!alive) return
      setSession(data.session)
      if (data.session) void sync(data.session.user.id)
      else setBusy(false)
    })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, next) => {
      if (!alive) return
      if (event === 'PASSWORD_RECOVERY') setPasswordSetup('recovery')
      setSession(next)
      if (next) {
        setBusy(true)
        void sync(next.user.id)
      } else {
        setProfile(null)
        setProfileError('')
        setBusy(false)
      }
    })
    return () => { alive = false; subscription.unsubscribe() }
  }, [])

  useEffect(() => {
    if (isLocalMode || !profile) { setUnread(0); return }
    let alive = true
    const refresh = async () => {
      const { count } = await supabase
        .from('notifications')
        .select('id', { count: 'exact', head: true })
        .eq('recipient_id', profile.id)
        .is('read_at', null)
      if (alive) setUnread(count ?? 0)
    }
    void refresh()
    const channel = supabase
      .channel(`tt-shell-${profile.id}`)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'notifications', filter: `recipient_id=eq.${profile.id}`,
      }, (payload) => {
        void refresh()
        if (payload.eventType === 'INSERT') {
          const row = payload.new as { title?: string; body?: string }
          pushNotification(row.title ?? '', row.body ?? '')
        }
      })
      .subscribe()
    return () => { alive = false; supabase.removeChannel(channel) }
  }, [profile?.id, isLocalMode])

  async function signOut() {
    if (isLocalMode) {
      setLocalProfile(defaultLocalProfile())
      setMenu(false)
      nav('/')
      return
    }
    await supabase.auth.signOut()
    setSession(null)
    setProfile(null)
    setProfileError('')
    setMenu(false)
    nav('/')
  }

  function retryProfile() {
    if (!session) return
    setBusy(true)
    void loadProfile(session.user.id).finally(() => setBusy(false))
  }

  if (passwordSetup) {
    return (
      <RecoveryScreen
        mode={passwordSetup}
        t={t}
        onDone={() => setPasswordSetup(null)}
        onSignOut={() => { setPasswordSetup(null); void signOut() }}
      />
    )
  }

  if (busy) {
    return <div className="loading-screen"><div className="brand-mark">T</div><p>{t('loading')}</p></div>
  }

  if (!isLocalMode) {
    if (!session) {
      return <Login lang={lang} setLang={setLang} t={t} />
    }
    if (gate !== 'active') {
      return <GateScreen state={gate} t={t} onRetry={retryProfile} onSignOut={signOut} />
    }
  }

  const viewProfile: Profile | null = isLocalMode ? localProfile : profile
  if (!viewProfile) {
    return <GateScreen state="error" t={t} onRetry={retryProfile} onSignOut={signOut} />
  }

  const owner = viewProfile.role === 'owner'
  const admin = ['owner', 'manager', 'admin'].includes(viewProfile.role)
  const navItems: [string, LucideIcon, string, boolean?][] = owner
    ? [
        ['/', Home, 'home'],
        ['/owner', Building2, 'ownerConsole'],
        ['/audit', History, 'audit'],
      ]
    : [
        ['/', Home, 'home'],
        ['/students', Users, 'students'],
        ['/attendance', CalendarDays, 'attendance'],
        ['/reports', ClipboardList, 'reports'],
        ...(viewProfile.role === 'coach' ? [['/notebook', NotebookPen, 'notebook'] as [string, LucideIcon, string]] : []),
        ['/notices', Bell, 'notices'],
        ['/notifications', Bell, 'notifications', true],
        ['/messages', MessageCircle, 'messages'],
        ...(admin ? [
          ['/team', UserPlus, 'team'] as [string, LucideIcon, string],
          ['/medical', HeartPulse, 'medical'] as [string, LucideIcon, string],
          ['/settings', SettingsIcon, 'settings'] as [string, LucideIcon, string],
          ['/audit', History, 'audit'] as [string, LucideIcon, string],
        ] : []),
      ]

  return (
    <div className="app-shell">
      <header className="topbar">
        <button className="icon-btn mobile-menu" aria-label="Menu" onClick={() => setMenu((v) => !v)}>
          {menu ? <X /> : <Menu />}
        </button>
        <div className="brand">
          <div className="brand-mark">T</div>
          <div className="app-name">
            <span className="arabic">{t('app')}</span>
            <span className="latin">{t('subtitle')}</span>
          </div>
        </div>
        <div className="top-actions">
          <select aria-label={t('language')} value={lang} onChange={(e) => setLang(e.target.value as Lang)}>
            <option value="ar">العربية</option>
            <option value="fr">Français</option>
            <option value="en">English</option>
          </select>
          <button className="icon-btn" onClick={signOut} title={t('logout')} aria-label={t('logout')}>
            <LogOut size={19} />
          </button>
        </div>
      </header>
      <div className="layout">
        <aside className={`sidebar ${menu ? 'open' : ''}`}>
          <div className="user-mini">
            <div className="avatar">{viewProfile.full_name?.slice(0, 1) || 'T'}</div>
            <div><b>{viewProfile.full_name || viewProfile.email || t('offline')}</b><small>{roleLabel(viewProfile.role, t)}</small></div>
          </div>
          <nav>
            {navItems.map(([to, Icon, key, badge]) => (
              <NavLink end={to === '/'} to={to} key={to} onClick={() => setMenu(false)}>
                <Icon size={19} />
                <span>{t(key)}</span>
                {badge && unread > 0 && <span className="unread-badge">{unread > 99 ? '99+' : unread}</span>}
                <ChevronLeft className="nav-arrow" size={16} />
              </NavLink>
            ))}
          </nav>
          <div className="sidebar-foot">
            <span className={`status-dot ${isConfigured ? 'online' : 'offline'}`}></span>
            <small>{isConfigured ? t('configured') : t('offline')}</small>
          </div>
        </aside>
        <main className="main-content">
          {isLocalMode && <div className="notice-box"><b>{t('configMissing')}</b><div>{t('configHint')}</div></div>}
          <Routes>
            <Route path="/" element={<Dashboard profile={viewProfile} t={t} />} />
            <Route path="/owner" element={owner ? <OwnerConsole profile={viewProfile} t={t} /> : <Denied t={t} />} />
            <Route path="/students" element={!owner ? <Students profile={viewProfile} t={t} /> : <Denied t={t} />} />
            <Route path="/attendance" element={!owner ? <Attendance profile={viewProfile} t={t} /> : <Denied t={t} />} />
            <Route path="/reports" element={!owner ? <Reports profile={viewProfile} t={t} /> : <Denied t={t} />} />
            <Route path="/notebook" element={viewProfile.role === 'coach' ? <Notebook profile={viewProfile} t={t} /> : <Denied t={t} />} />
            <Route path="/notices" element={!owner ? <Notices profile={viewProfile} t={t} /> : <Denied t={t} />} />
            <Route path="/notifications" element={!owner ? <Notifications profile={viewProfile} t={t} /> : <Denied t={t} />} />
            <Route path="/messages" element={!owner ? <Messages profile={viewProfile} t={t} /> : <Denied t={t} />} />
            <Route path="/team" element={admin && !owner ? <Team profile={viewProfile} t={t} /> : <Denied t={t} />} />
            <Route path="/medical" element={admin && !owner ? <Medical profile={viewProfile} t={t} /> : <Denied t={t} />} />
            <Route path="/settings" element={admin && !owner ? <InstitutionSettings profile={viewProfile} t={t} /> : <Denied t={t} />} />
            <Route path="/audit" element={admin ? <Audit t={t} /> : <Denied t={t} />} />
            <Route path="*" element={<Dashboard profile={viewProfile} t={t} />} />
          </Routes>
        </main>
      </div>
      {toast && <div className="toast" role="status" onClick={() => setToast('')}>{toast}</div>}
    </div>
  )
}
function RecoveryScreen({ mode, t, onDone, onSignOut }: {
  mode: 'recovery' | 'invite'
  t: T
  onDone: () => void
  onSignOut: () => void
}) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (password !== confirm) { notify(t('passwordMismatch')); return }
    setBusy(true)
    const { error } = await supabase.auth.updateUser({ password })
    setBusy(false)
    if (error) { notify(error.message); return }
    try { window.history.replaceState(null, '', window.location.pathname) } catch { /* optional */ }
    notify(t('passwordUpdated'))
    onDone()
  }

  return (
    <div className="login-wrap">
      <section className="login-card">
        <div className="login-brand">
          <div className="brand-mark big">T</div>
          <h1 className="app-name">
            <span className="arabic">{t('app')}</span>
            <span className="latin">{t('subtitle')}</span>
          </h1>
        </div>
        <h2>{t(mode === 'invite' ? 'setPasswordTitle' : 'resetPasswordTitle')}</h2>
        <form onSubmit={submit}>
          <label>
            {t('newPassword')}
            <input type="password" autoComplete="new-password" minLength={6} required
              value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          <label>
            {t('confirmPassword')}
            <input type="password" autoComplete="new-password" minLength={6} required
              value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </label>
          <button className="primary full" disabled={busy}>{busy ? t('loading') : t('updatePassword')}</button>
          <button type="button" className="secondary full" onClick={onSignOut}>{t('logout')}</button>
        </form>
      </section>
    </div>
  )
}

function Login({ lang, setLang, t }: { lang: Lang; setLang: (v: Lang) => void; t: T }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [mode, setMode] = useState<'login' | 'reset'>('login')
  const [resetBusy, setResetBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError('')
    if (!isConfigured) { setError(t('configMissing')); return }
    setLoading(true)
    const { error: authError } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
    if (authError) setError(authError.message)
    setLoading(false)
  }

  async function sendReset(e: FormEvent) {
    e.preventDefault()
    if (!email.trim()) { notify(t('resetEmailFirst')); return }
    setResetBusy(true)
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: window.location.origin,
    })
    setResetBusy(false)
    if (resetError) { notify(resetError.message); return }
    notify(t('resetSent'))
    setMode('login')
  }

  return (
    <div className="login-wrap">
      <section className="login-card">
        <div className="login-brand">
          <div className="brand-mark big">T</div>
          <h1 className="app-name">
            <span className="arabic">{t('app')}</span>
            <span className="latin">{t('subtitle')}</span>
          </h1>
        </div>
        <div className="login-lang">
          <Languages size={16} />
          <select aria-label={t('language')} value={lang} onChange={(e) => setLang(e.target.value as Lang)}>
            <option value="ar">العربية</option>
            <option value="fr">Français</option>
            <option value="en">English</option>
          </select>
        </div>
        <h2>{mode === 'login' ? t('welcome') : t('forgotPassword')}</h2>
        {mode === 'login' ? (
          <form onSubmit={submit}>
            <label>
              {t('email')}
              <input type="email" autoComplete="username" required value={email}
                onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" />
            </label>
            <label>
              {t('password')}
              <input type="password" autoComplete="current-password" required value={password}
                onChange={(e) => setPassword(e.target.value)} />
            </label>
            {error && <div className="error-box">{error}</div>}
            <button className="primary full" disabled={loading}>{loading ? t('loading') : t('login')}</button>
            <button type="button" className="secondary full" onClick={() => { setError(''); setMode('reset') }}>
              {t('forgotPassword')}
            </button>
          </form>
        ) : (
          <form onSubmit={sendReset}>
            <p className="muted">{t('resetEmailFirst')}</p>
            <label>
              {t('email')}
              <input type="email" autoComplete="email" required value={email}
                onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" />
            </label>
            <button className="primary full" disabled={resetBusy}>
              {resetBusy ? t('sendingReset') : t('forgotPassword')}
            </button>
            <button type="button" className="secondary full" onClick={() => setMode('login')}>
              {t('cancel')}
            </button>
          </form>
        )}
        <small className="secure-note"><ShieldCheck size={14} /> {t('secureAccess')}</small>
      </section>
    </div>
  )
}

function GateScreen({ state, t, onRetry, onSignOut }: {
  state: GateState
  t: T
  onRetry: () => void
  onSignOut: () => void
}) {
  return (
    <div className="login-wrap">
      <section className="login-card">
        <div className="login-brand">
          <div className="brand-mark big">T</div>
          <h1 className="app-name">
            <span className="arabic">{t('app')}</span>
            <span className="latin">{t('subtitle')}</span>
          </h1>
        </div>
        <h2>{t(gateTitleKey(state))}</h2>
        <p className="muted">{t(gateBodyKey(state))}</p>
        {gateAllowsRetry(state) && (
          <button className="primary full" onClick={onRetry}>{t('retry')}</button>
        )}
        <button className="secondary full" onClick={onSignOut}>{t('logout')}</button>
      </section>
    </div>
  )
}

function Heading({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <div className="page-heading">
      <div><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div>
      {action}
    </div>
  )
}

function Empty({ t }: { t: T }) {
  return <div className="empty"><div className="empty-icon"><Activity /></div><p>{t('noData')}</p></div>
}

function Stat({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: number }) {
  return (
    <div className="stat-card">
      <div className="stat-icon"><Icon size={20} /></div>
      <div><strong>{value}</strong><small>{label}</small></div>
    </div>
  )
}

function Denied({ t }: { t: T }) {
  return <section className="panel"><ShieldCheck /><h2>{t('noPermission')}</h2></section>
}
function Dashboard({ profile, t }: { profile: Profile; t: T }) {
  const [stats, setStats] = useState({ students: 0, reports: 0, notices: 0, team: 0 })
  const [recent, setRecent] = useState<ReportRow[]>([])
  const [errorKey, setErrorKey] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    async function run() {
      if (!isConfigured) { setLoading(false); return }
      const scoped = <Q,>(query: Q): Q => {
        if (!profile.institution_id) return query
        return (query as unknown as { eq: (column: string, value: string) => Q }).eq('institution_id', profile.institution_id)
      }
      const [studentsRes, reportsRes, noticesRes, teamRes] = await Promise.all([
        scoped(supabase.from('students').select('id', { count: 'exact', head: true })),
        scoped(supabase.from('daily_reports').select('id', { count: 'exact', head: true })),
        scoped(supabase.from('admin_notices').select('id', { count: 'exact', head: true })),
        scoped(supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('account_status', 'active')),
      ])
      if (!alive) return
      if (studentsRes.error || reportsRes.error || noticesRes.error || teamRes.error) {
        setErrorKey('loadingError')
      } else {
        setErrorKey('')
      }
      setStats({
        students: studentsRes.count ?? 0,
        reports: reportsRes.count ?? 0,
        notices: noticesRes.count ?? 0,
        team: teamRes.count ?? 0,
      })
      let recentQuery = supabase.from('daily_reports').select('*').order('created_at', { ascending: false }).limit(5)
      if (profile.role === 'coach') recentQuery = recentQuery.eq('coach_id', profile.id)
      if (profile.institution_id) recentQuery = recentQuery.eq('institution_id', profile.institution_id)
      const { data } = await recentQuery
      if (alive) setRecent((data ?? []) as ReportRow[])
      setLoading(false)
    }
    void run()
    return () => { alive = false }
  }, [profile.id, profile.role, profile.institution_id])

  return (
    <>
      <Heading title={t('home')} subtitle={`${t('welcome')} · ${profile.full_name || profile.email || t('offline')}`} />
      {errorKey && <div className="error-box">{t(errorKey)}</div>}
      <div className="stats-grid">
        <Stat icon={Users} label={t('statsStudents')} value={stats.students} />
        <Stat icon={ClipboardList} label={t('statsReports')} value={stats.reports} />
        <Stat icon={Bell} label={t('statsNotices')} value={stats.notices} />
        {profile.role !== 'coach' && <Stat icon={UserPlus} label={t('statsTeam')} value={stats.team} />}
      </div>
      {profile.role === 'coach' && <ShiftCard profile={profile} t={t} />}
      <section className="panel">
        <div className="panel-head"><h3>{t('reports')}</h3><span className="muted">{t('today')}</span></div>
        {loading ? <Empty t={t} /> : recent.length === 0 ? <Empty t={t} /> : (
          <div className="report-list">
            {recent.map((r) => (
              <div className="report-row" key={r.id}>
                <div className="report-icon"><ClipboardList size={18} /></div>
                <div className="grow"><b>{r.coach_name_snapshot}</b><small>{r.report_date}</small></div>
                <span className={`pill ${r.status === 'reviewed' ? 'success' : r.is_finalized ? 'success' : 'warning'}`}>
                  {r.status === 'reviewed' ? t('reviewed') : r.is_finalized ? t('finalized') : t('draft')}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  )
}

function ShiftCard({ profile, t }: { profile: Profile; t: T }) {
  const [active, setActive] = useState<{ id: string; started_at: string } | null>(null)
  const [loading, setLoading] = useState(false)

  async function refresh() {
    if (!isConfigured) return
    const { data } = await supabase
      .from('coach_shifts')
      .select('id,started_at')
      .eq('coach_id', profile.id)
      .is('ended_at', null)
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    setActive((data as { id: string; started_at: string } | null) ?? null)
  }

  useEffect(() => { void refresh() }, [profile.id])

  async function toggle() {
    if (!isConfigured) { notify(t('configMissing')); return }
    if (!active && !profile.institution_id) { notify(t('noPermission')); return }
    setLoading(true)
    const result = active
      ? await supabase.from('coach_shifts').update({ ended_at: new Date().toISOString() }).eq('id', active.id)
      : await supabase.from('coach_shifts').insert({ coach_id: profile.id, institution_id: profile.institution_id })
    if (result.error) notify(result.error.message)
    else notify(t('savedOk'))
    await refresh()
    setLoading(false)
  }

  return (
    <section className="shift-card">
      <div>
        <span className="eyebrow">{active ? t('shiftActive') : t('shiftInactive')}</span>
        <h3>{active ? formatTime(active.started_at) : t('shiftInactive')}</h3>
      </div>
      <button className={active ? 'danger' : 'primary'} disabled={loading} onClick={toggle}>
        {active ? t('finish') : t('start')}
      </button>
    </section>
  )
}
type StudentNote = {
  id: string
  body: string
  note_type: string
  created_at: string
  author_id: string
}

function Students({ profile, t }: { profile: Profile; t: T }) {
  const [items, setItems] = useState<Student[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [show, setShow] = useState(false)
  const [editing, setEditing] = useState<Student | null>(null)
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [birth, setBirth] = useState('')
  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulkText, setBulkText] = useState('')
  const [bulkBusy, setBulkBusy] = useState(false)
  const [noteStudent, setNoteStudent] = useState<Student | null>(null)
  const [noteItems, setNoteItems] = useState<StudentNote[]>([])
  const [note, setNote] = useState('')
  const canManage = ['owner', 'manager', 'admin'].includes(profile.role) && Boolean(profile.institution_id)

  async function load() {
    setLoading(true)
    if (!isConfigured) { setLoading(false); return }
    let query = supabase
      .from('students')
      .select('id,student_code,full_name,is_active,class_id,date_of_birth')
      .order('full_name')
    if (profile.institution_id) query = query.eq('institution_id', profile.institution_id)
    const { data, error } = await query
    if (error) notify(error.message)
    setItems((data ?? []) as Student[])
    setLoading(false)
  }

  useEffect(() => { void load() }, [profile.id, profile.institution_id])

  const filtered = useMemo(
    () => items.filter((s) => `${s.full_name} ${s.student_code}`.toLowerCase().includes(search.toLowerCase())),
    [items, search],
  )
  const existingCodes = useMemo(() => new Set(items.map((s) => s.student_code.toLowerCase())), [items])
  const parsed = useMemo(() => parseStudentPaste(bulkText), [bulkText])
  const importPlan = useMemo(() => {
    const seen = new Set<string>()
    const valid: { student_code: string; full_name: string }[] = []
    let duplicates = 0
    for (const row of parsed) {
      const key = row.student_code.toLowerCase()
      if (!key || seen.has(key) || existingCodes.has(key)) { duplicates++; continue }
      seen.add(key)
      valid.push(row)
    }
    return { valid, duplicates }
  }, [parsed, existingCodes])

  function openAdd() {
    setEditing(null); setCode(''); setName(''); setBirth(''); setShow(true)
  }

  function openEdit(student: Student) {
    setEditing(student)
    setCode(student.student_code)
    setName(student.full_name)
    setBirth(student.date_of_birth || '')
    setShow(true)
  }

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!canManage) { notify(t('noPermission')); return }
    const payload = {
      student_code: code.trim(),
      full_name: name.trim(),
      date_of_birth: birth || null,
    }
    const result = editing
      ? await supabase.from('students').update(payload).eq('id', editing.id)
      : await supabase.from('students').insert({ ...payload, institution_id: profile.institution_id })
    if (result.error) { notify(result.error.message); return }
    setShow(false)
    notify(t('savedOk'))
    await load()
  }

  async function toggleActive(student: Student) {
    if (!canManage) { notify(t('noPermission')); return }
    const { error } = await supabase.from('students').update({ is_active: !student.is_active }).eq('id', student.id)
    if (error) { notify(error.message); return }
    await load()
  }

  async function openNotes(student: Student) {
    setNoteStudent(student)
    setNote('')
    if (!isConfigured) { setNoteItems([]); return }
    const { data, error } = await supabase
      .from('student_notes')
      .select('id,body,note_type,created_at,author_id')
      .eq('student_id', student.id)
      .order('created_at', { ascending: false })
    if (error) notify(error.message)
    setNoteItems((data ?? []) as StudentNote[])
  }

  async function saveNote(e: FormEvent) {
    e.preventDefault()
    if (!noteStudent || !note.trim()) return
    const { error } = await supabase.from('student_notes').insert({
      institution_id: profile.institution_id,
      student_id: noteStudent.id,
      author_id: profile.id,
      body: note.trim(),
      note_type: 'general',
      follow_up_status: 'none',
    })
    if (error) { notify(error.message); return }
    notify(t('savedOk'))
    await openNotes(noteStudent)
  }

  async function importBulk() {
    if (!importPlan.valid.length) {
      notify(t(parsed.length ? 'allCodesExist' : 'noValidRows'))
      return
    }
    if (!profile.institution_id) { notify(t('noPermission')); return }
    setBulkBusy(true)
    const rows = importPlan.valid.map((row) => ({ ...row, institution_id: profile.institution_id }))
    const { error } = await supabase.from('students').insert(rows)
    setBulkBusy(false)
    if (error) { notify(`${t('importFailed')}: ${error.message}`); return }
    notify(`${t('importDone')} (${rows.length})`)
    setBulkText('')
    setBulkOpen(false)
    await load()
  }

  async function readImportFile(file: File | null) {
    if (!file) return
    try { setBulkText(await file.text()) } catch { notify(t('importFailed')) }
  }
  return (
    <>
      <Heading
        title={t('students')}
        action={canManage && (
          <div className="heading-actions">
            <button className="secondary action-btn" onClick={() => setBulkOpen(true)}>
              <FileUp size={17} /> {t('importExcel')}
            </button>
            <button className="primary action-btn" onClick={openAdd}>
              <Plus size={18} /> {t('add')}
            </button>
          </div>
        )}
      />
      <div className="searchbar">
        <Search size={18} />
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('search')} />
      </div>
      {loading ? <Empty t={t} /> : filtered.length === 0 ? <Empty t={t} /> : (
        <section className="panel student-list">
          {filtered.map((student) => (
            <div className="student-row" key={student.id}>
              <div className="avatar student-avatar"><GraduationCap size={19} /></div>
              <div className="grow"><b>{student.full_name}</b><small>#{student.student_code}</small></div>
              <span className={`pill ${student.is_active ? 'success' : 'warning'}`}>
                {student.is_active ? t('active') : t('inactive')}
              </span>
              <button className="icon-btn row-action" title={t('studentNotes')} onClick={() => openNotes(student)}>
                <NotebookPen size={16} />
              </button>
              {canManage && (
                <>
                  <button className="icon-btn row-action" title={t('edit')} onClick={() => openEdit(student)}>
                    <Pencil size={16} />
                  </button>
                  <button className="icon-btn row-action" title={t('archive')} onClick={() => toggleActive(student)}>
                    <Archive size={16} />
                  </button>
                </>
              )}
            </div>
          ))}
        </section>
      )}

      {show && (
        <Modal title={editing ? t('students') : t('studentAdd')} close={() => setShow(false)} closeLabel={t('close')}>
          <form onSubmit={save}>
            <label>{t('code')}<input required value={code} onChange={(e) => setCode(e.target.value)} /></label>
            <label>{t('name')}<input required value={name} onChange={(e) => setName(e.target.value)} /></label>
            <label>{t('date')}<input type="date" value={birth} onChange={(e) => setBirth(e.target.value)} /></label>
            <div className="modal-actions">
              <button type="button" className="secondary" onClick={() => setShow(false)}>{t('cancel')}</button>
              <button className="primary">{t('save')}</button>
            </div>
          </form>
        </Modal>
      )}

      {bulkOpen && (
        <Modal title={t('importTitle')} close={() => setBulkOpen(false)} closeLabel={t('close')}>
          <p className="muted">{t('importHint')}</p>
          <label>{t('importExcel')}
            <input type="file" accept=".csv,.txt,text/csv,text/plain"
              onChange={(e) => { void readImportFile(e.target.files?.[0] ?? null) }} />
          </label>
          <label>{t('importPreview')}
            <textarea rows={7} value={bulkText} onChange={(e) => setBulkText(e.target.value)}
              placeholder={'student_code,full_name\n001,محمد علي\n002,سارة أحمد'} />
          </label>
          <div className="bulk-preview">
            <div><b>{t('previewValid')}: {importPlan.valid.length}</b></div>
            <div>{t('importDup')}: {importPlan.duplicates}</div>
            {importPlan.valid.slice(0, 8).map((row, index) => (
              <div key={`${row.student_code}-${index}`}>{row.student_code} — {row.full_name}</div>
            ))}
            {importPlan.valid.length === 0 && parsed.length > 0 && (
              <div className="muted">{importPlan.duplicates ? t('allCodesExist') : t('noValidRows')}</div>
            )}
          </div>
          <div className="modal-actions">
            <button type="button" className="secondary" onClick={() => setBulkOpen(false)}>{t('cancel')}</button>
            <button className="primary" disabled={bulkBusy || !importPlan.valid.length} onClick={importBulk}>
              {bulkBusy ? t('importing') : t('confirmImport')}
            </button>
          </div>
        </Modal>
      )}

      {noteStudent && (
        <Modal title={`${t('studentNotes')} · ${noteStudent.full_name}`} close={() => setNoteStudent(null)} closeLabel={t('close')}>
          <form onSubmit={saveNote}>
            <label>{t('notes')}
              <DictateButton t={t} onText={setNote} />
              <textarea required rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
            </label>
            <button className="primary">{t('addNote')}</button>
          </form>
          {noteItems.map((item) => (
            <article className="notice note-item" key={item.id}>
              <p>{item.body}</p>
              <small>{formatDateTime(item.created_at)} · {t(item.note_type)}</small>
            </article>
          ))}
        </Modal>
      )}
    </>
  )
}
function Attendance({ profile, t }: { profile: Profile; t: T }) {
  const [students, setStudents] = useState<Student[]>([])
  const [status, setStatus] = useState<Record<string, string>>({})
  const [reasons, setReasons] = useState<Record<string, string>>({})
  const [date, setDate] = useState(localDate())
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [sessionKey, setSessionKey] = useState(NO_SESSION)

  async function load() {
    setLoading(true)
    if (!isConfigured) { setLoading(false); return }
    let query = supabase.from('students').select('id,student_code,full_name').eq('is_active', true).order('student_code')
    if (profile.institution_id) query = query.eq('institution_id', profile.institution_id)
    const [studentsRes, attendance] = await Promise.all([query, loadAttendance(date, profile.id)])
    if (studentsRes.error) notify(studentsRes.error.message)
    if (attendance.error) notify(attendance.error)
    setStudents((studentsRes.data ?? []) as Student[])
    const next: Record<string, string> = {}
    const why: Record<string, string> = {}
    for (const record of attendance.records) {
      next[record.student_id] = record.status
      why[record.student_id] = record.reason || ''
    }
    setStatus(next)
    setReasons(why)
    setSessionKey(attendance.sessionKey)
    setLoading(false)
  }

  useEffect(() => { void load() }, [date, profile.id, profile.institution_id])

  function mark(id: string, value: string) {
    setStatus((current) => ({ ...current, [id]: value }))
  }

  function markAllPresent() {
    const next: Record<string, string> = {}
    for (const student of students) next[student.id] = 'present'
    setStatus(next)
  }

  function clearAll() {
    setStatus({})
    setReasons({})
  }

  async function save() {
    if (!isConfigured) { notify(t('configMissing')); return }
    const rows = buildAttendanceRows(students, status, reasons, {
      institution_id: profile.institution_id,
      coach_id: profile.id,
      session_date: date,
    })
    if (!rows.length) { notify(t('nothingRecorded')); return }
    // Only a coach owns a shift. Managers/admins record attendance directly and
    // have no shift to start, so the coach-only prompt would be misleading.
    if (sessionKey === NO_SESSION && profile.role === 'coach' && !window.confirm(t('startShiftPrompt'))) return
    setBusy(true)
    const result = await saveAttendance(rows, profile.id, sessionKey)
    setBusy(false)
    if (result.error) { notify(result.error); return }
    setSessionKey(result.sessionKey)
    notify(t('attendanceSaved'))
  }

  const counts = useMemo(() => {
    const totals: Record<string, number> = {}
    for (const value of Object.values(status)) totals[value] = (totals[value] || 0) + 1
    return totals
  }, [status])

  const summary: [string, string][] = [
    ['present', t('present')],
    ['absent', t('absent')],
    ['late', t('late')],
    ['excused', t('excused')],
    ['permission', t('permission')],
    ['medical_exemption', t('medicalExemption')],
  ]

  return (
    <>
      <Heading title={t('attendance')} subtitle={t('attendanceSave')} />
      {profile.role !== 'coach' && <p className="muted">{t('adminAttendanceHint')}</p>}
      <section className="panel">
        <label>{t('date')}<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        <div className="attendance-summary">
          {summary.map(([key, label]) => <span key={key}>{label}: <b>{counts[key] || 0}</b></span>)}
          {sessionKey === NO_SESSION && <span className="pill warning">{t('noSession')}</span>}
        </div>
        <div className="attendance-bulk">
          <button type="button" className="secondary" disabled={!students.length} onClick={markAllPresent}>
            <Check size={16} /> {t('markAllPresent')}
          </button>
          <button type="button" className="secondary" disabled={!students.length} onClick={clearAll}>
            <X size={16} /> {t('clearAll')}
          </button>
        </div>
        {loading ? <Empty t={t} /> : students.length === 0 ? <Empty t={t} /> : (
          <div className="attendance-list">
            {students.map((student) => (
              <div className="attendance-row" key={student.id}>
                <div className="grow"><b>{student.student_code} · {student.full_name}</b></div>
                <select aria-label={student.full_name} value={status[student.id] || ''} onChange={(e) => mark(student.id, e.target.value)}>
                  <option value="">—</option>
                  <option value="present">{t('present')}</option>
                  <option value="absent">{t('absent')}</option>
                  <option value="late">{t('late')}</option>
                  <option value="excused">{t('excused')}</option>
                  <option value="permission">{t('permission')}</option>
                  <option value="medical_exemption">{t('medicalExemption')}</option>
                </select>
                {status[student.id] && status[student.id] !== 'present' && (
                  <input className="attendance-reason" value={reasons[student.id] || ''}
                    onChange={(e) => setReasons((current) => ({ ...current, [student.id]: e.target.value }))}
                    placeholder={t('reason')} />
                )}
              </div>
            ))}
          </div>
        )}
        <button className="primary full" disabled={busy || !Object.keys(status).length} onClick={save}>
          {t('attendanceSave')}
        </button>
      </section>
    </>
  )
}
function Reports({ profile, t }: { profile: Profile; t: T }) {
  const [items, setItems] = useState<ReportRow[]>([])
  const [loading, setLoading] = useState(true)
  const [show, setShow] = useState(false)
  const [notes, setNotes] = useState('')
  const [counts, setCounts] = useState<ReportCounts>(emptyCounts)
  const [reportDate, setReportDate] = useState(localDate())
  const [draftId, setDraftId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const admin = ['manager', 'admin'].includes(profile.role)

  async function load() {
    setLoading(true)
    if (!isConfigured) { setLoading(false); return }
    let query = supabase.from('daily_reports').select('*').order('created_at', { ascending: false })
    if (profile.role === 'coach') query = query.eq('coach_id', profile.id)
    if (profile.institution_id) query = query.eq('institution_id', profile.institution_id)
    const { data, error } = await query
    if (error) notify(error.message)
    setItems((data ?? []) as ReportRow[])
    setLoading(false)
  }

  useEffect(() => { void load() }, [profile.id, profile.role, profile.institution_id])

  useEffect(() => {
    if (!show) return
    const timer = window.setTimeout(() => {
      saveReportDraft(profile.id, { counts, notes, draftId })
    }, 400)
    return () => window.clearTimeout(timer)
  }, [show, counts, notes, draftId, profile.id])

  function countsFromStatuses(rows: { status: string }[]): ReportCounts {
    return {
      present_count: rows.filter((x) => x.status === 'present').length,
      absent_count: rows.filter((x) => x.status === 'absent').length,
      late_count: rows.filter((x) => x.status === 'late').length,
      injured_count: rows.filter((x) => x.status === 'medical_exemption').length,
      excused_count: rows.filter((x) => ['excused', 'permission'].includes(x.status)).length,
    }
  }

  async function openReport() {
    if (!isConfigured) { notify(t('configMissing')); return }
    const today = localDate()
    setReportDate(today)
    setDraftId(null)
    setNotes('')
    setCounts(emptyCounts())
    let query = supabase.from('attendance_records').select('status').eq('session_date', today).eq('coach_id', profile.id)
    if (profile.institution_id) query = query.eq('institution_id', profile.institution_id)
    const { data, error } = await query
    if (error) notify(error.message)
    setCounts(countsFromStatuses((data ?? []) as { status: string }[]))
    const draft = loadReportDraft(profile.id)
    if (draft && hasDraftContent(draft)) {
      setCounts(draft.counts)
      setNotes(draft.notes)
      setDraftId(draft.draftId)
      notify(t('draftRestored'))
    }
    setShow(true)
  }

  function continueDraft(row: ReportRow) {
    setDraftId(row.id)
    setReportDate(row.report_date)
    setNotes(row.notes || '')
    setCounts({
      present_count: row.present_count,
      absent_count: row.absent_count,
      late_count: row.late_count,
      injured_count: row.injured_count,
      excused_count: row.excused_count,
    })
    setShow(true)
  }

  async function latestShift() {
    if (!isConfigured) return null
    const { data } = await supabase
      .from('coach_shifts')
      .select('id,started_at,ended_at')
      .eq('coach_id', profile.id)
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    return (data as { id: string; started_at: string; ended_at: string | null } | null) ?? null
  }

  async function saveDraft() {
    if (!isConfigured) { notify(t('configMissing')); return }
    setBusy(true)
    const shift = await latestShift()
    const payload = {
      ...counts,
      notes: notes.trim() || null,
      coach_id: profile.id,
      institution_id: profile.institution_id,
      coach_name_snapshot: profile.full_name,
      shift_id: shift?.id ?? null,
      report_date: reportDate,
      status: 'draft',
      is_finalized: false,
      finalized_at: null,
      shift_start: shift?.started_at ?? null,
      shift_end: shift?.ended_at ?? null,
    }
    let error: { message: string } | null = null
    if (draftId) {
      const result = await supabase.from('daily_reports').update(payload).eq('id', draftId).eq('coach_id', profile.id)
      error = result.error
    } else {
      const result = await supabase.from('daily_reports').insert(payload).select('id').single()
      error = result.error
      const saved = result.data as { id?: string } | null
      if (saved?.id) setDraftId(saved.id)
    }
    setBusy(false)
    if (error) { notify(error.message); return }
    clearReportDraft(profile.id)
    notify(t('draftSaved'))
    setShow(false)
    await load()
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!isConfigured) { notify(t('configMissing')); return }
    setBusy(true)
    const shift = await latestShift()
    const payload = {
      ...counts,
      notes: notes.trim() || null,
      coach_id: profile.id,
      institution_id: profile.institution_id,
      coach_name_snapshot: profile.full_name,
      shift_id: shift?.id ?? null,
      report_date: reportDate,
      status: 'submitted',
      is_finalized: true,
      finalized_at: new Date().toISOString(),
      shift_start: shift?.started_at ?? null,
      shift_end: shift?.ended_at ?? new Date().toISOString(),
    }
    const result = draftId
      ? await supabase.from('daily_reports').update(payload).eq('id', draftId).eq('coach_id', profile.id)
      : await supabase.from('daily_reports').insert(payload)
    setBusy(false)
    if (result.error) { notify(result.error.message); return }
    clearReportDraft(profile.id)
    notify(t('savedOk'))
    setShow(false)
    await load()
  }

  async function review(id: string) {
    if (!admin) { notify(t('noPermission')); return }
    const { error } = await supabase
      .from('daily_reports')
      .update({ status: 'reviewed', reviewed_by: profile.id, reviewed_at: new Date().toISOString() })
      .eq('id', id)
    if (error) { notify(error.message); return }
    notify(t('savedOk'))
    await load()
  }
  return (
    <>
      <Heading
        title={t('reports')}
        action={profile.role === 'coach' && (
          <button className="primary action-btn" onClick={openReport}><Plus size={18} /> {t('newReport')}</button>
        )}
      />
      {loading ? <Empty t={t} /> : items.length === 0 ? <Empty t={t} /> : (
        <section className="panel">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t('name')}</th>
                  <th>{t('date')}</th>
                  <th>{t('present')}</th>
                  <th>{t('absent')}</th>
                  <th>{t('late')}</th>
                  <th>{t('injured')}</th>
                  <th>{t('excused')}</th>
                  <th>{t('status')}</th>
                  <th>{t('actions')}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((row) => (
                  <tr key={row.id}>
                    <td>{row.coach_name_snapshot}</td>
                    <td>{row.report_date}</td>
                    <td>{row.present_count}</td>
                    <td>{row.absent_count}</td>
                    <td>{row.late_count}</td>
                    <td>{row.injured_count}</td>
                    <td>{row.excused_count}</td>
                    <td>
                      <span className={`pill ${row.status === 'reviewed' ? 'success' : row.is_finalized ? 'success' : 'warning'}`}>
                        {row.status === 'reviewed' ? t('reviewed') : row.is_finalized ? t('finalized') : t('draft')}
                      </span>
                    </td>
                    <td>
                      {profile.role === 'coach' && !row.is_finalized && (
                        <button className="secondary" onClick={() => continueDraft(row)}>{t('continueDraft')}</button>
                      )}
                      {admin && row.is_finalized && row.status !== 'reviewed' && (
                        <button className="secondary" onClick={() => review(row.id)}>{t('approveReport')}</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {show && (
        <Modal title={t('newReport')} close={() => setShow(false)} closeLabel={t('close')}>
          <form onSubmit={submit}>
            <p className="muted">{t('countsAuto')}</p>
            <label>{t('date')}
              <input type="date" value={reportDate} onChange={(e) => setReportDate(e.target.value)} />
            </label>
            <div className="counter-grid">
              {(['present_count', 'absent_count', 'late_count', 'injured_count', 'excused_count'] as const).map((key) => (
                <label className="counter" key={key}>
                  <span>{t(key.replace('_count', ''))}</span>
                  <input type="number" min="0" value={counts[key]}
                    onChange={(e) => setCounts((current) => ({ ...current, [key]: Math.max(0, Number(e.target.value) || 0) }))} />
                </label>
              ))}
            </div>
            <label>{t('notes')}
              <DictateButton t={t} onText={setNotes} />
              <textarea rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </label>
            <small className="muted">{t('reportLocked')}</small>
            <div className="modal-actions">
              <button type="button" className="secondary" onClick={() => setShow(false)}>{t('cancel')}</button>
              <button type="button" className="secondary" disabled={busy} onClick={saveDraft}>
                {t('saveDraft')}
              </button>
              <button className="primary" disabled={busy}>{t('send')}</button>
            </div>
          </form>
        </Modal>
      )}
    </>
  )
}
function Notebook({ profile, t }: { profile: Profile; t: T }) {
  const [items, setItems] = useState<{ id: string; title: string; body: string; entry_date: string }[]>([])
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  async function load() {
    setLoading(true)
    if (!isConfigured) { setLoading(false); return }
    const { data, error } = await supabase
      .from('coach_notebooks')
      .select('id,title,body,entry_date')
      .eq('coach_id', profile.id)
      .order('entry_date', { ascending: false })
    if (error) notify(error.message)
    setItems((data ?? []) as { id: string; title: string; body: string; entry_date: string }[])
    setLoading(false)
  }

  useEffect(() => { void load() }, [profile.id])

  async function add(e: FormEvent) {
    e.preventDefault()
    if (!isConfigured) { notify(t('configMissing')); return }
    if (!title.trim() || !body.trim()) return
    setBusy(true)
    const { error } = await supabase.from('coach_notebooks').insert({
      institution_id: profile.institution_id,
      coach_id: profile.id,
      title: title.trim(),
      body: body.trim(),
      entry_date: localDate(),
    })
    setBusy(false)
    if (error) { notify(error.message); return }
    setTitle('')
    setBody('')
    notify(t('savedOk'))
    await load()
  }

  return (
    <>
      <Heading title={t('notebook')} subtitle={t('privateNote')} />
      <section className="panel">
        <form onSubmit={add}>
          <label>{t('title')}<input required value={title} onChange={(e) => setTitle(e.target.value)} /></label>
          <label>{t('notes')}
            <DictateButton t={t} onText={setBody} />
            <textarea required rows={4} value={body} onChange={(e) => setBody(e.target.value)} />
          </label>
          <button className="primary" disabled={busy}>{t('add')}</button>
        </form>
      </section>
      {loading ? <Empty t={t} /> : items.length === 0 ? <Empty t={t} /> : items.map((item) => (
        <article className="panel notice" key={item.id}>
          <h3>{item.title}</h3>
          <p>{item.body}</p>
          <small>{item.entry_date}</small>
        </article>
      ))}
    </>
  )
}

function Notices({ profile, t }: { profile: Profile; t: T }) {
  const [items, setItems] = useState<{ id: string; title: string; body: string; created_at: string }[]>([])
  const [show, setShow] = useState(false)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const canPublish = ['manager', 'admin'].includes(profile.role)

  async function load() {
    setLoading(true)
    if (!isConfigured) { setLoading(false); return }
    let query = supabase.from('admin_notices').select('id,title,body,created_at').order('created_at', { ascending: false })
    if (profile.institution_id) query = query.eq('institution_id', profile.institution_id)
    const { data, error } = await query
    if (error) notify(error.message)
    setItems((data ?? []) as { id: string; title: string; body: string; created_at: string }[])
    setLoading(false)
  }

  useEffect(() => { void load() }, [profile.institution_id])

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!isConfigured) { notify(t('configMissing')); return }
    setBusy(true)
    const { error } = await supabase.from('admin_notices').insert({
      title: title.trim(),
      body: body.trim(),
      author_id: profile.id,
      institution_id: profile.institution_id,
      is_published: true,
      published_at: new Date().toISOString(),
    })
    setBusy(false)
    if (error) { notify(error.message); return }
    setShow(false)
    setTitle('')
    setBody('')
    notify(t('savedOk'))
    await load()
  }

  return (
    <>
      <Heading
        title={t('notices')}
        action={canPublish && (
          <button className="primary action-btn" onClick={() => setShow(true)}><Plus size={18} /> {t('newNotice')}</button>
        )}
      />
      {loading ? <Empty t={t} /> : items.length === 0 ? <Empty t={t} /> : items.map((notice) => (
        <article className="panel notice" key={notice.id}>
          <div className="notice-head"><Bell size={18} /><small>{formatDateTime(notice.created_at)}</small></div>
          <h3>{notice.title}</h3>
          <p>{notice.body}</p>
        </article>
      ))}
      {show && (
        <Modal title={t('newNotice')} close={() => setShow(false)} closeLabel={t('close')}>
          <form onSubmit={save}>
            <label>{t('title')}<input required value={title} onChange={(e) => setTitle(e.target.value)} /></label>
            <label>{t('body')}<textarea required rows={5} value={body} onChange={(e) => setBody(e.target.value)} /></label>
            <div className="modal-actions">
              <button type="button" className="secondary" onClick={() => setShow(false)}>{t('cancel')}</button>
              <button className="primary" disabled={busy}>{t('save')}</button>
            </div>
          </form>
        </Modal>
      )}
    </>
  )
}
function Notifications({ profile, t }: { profile: Profile; t: T }) {
  const [items, setItems] = useState<{
    id: string; title: string; body: string; notification_type: string; read_at: string | null; created_at: string
  }[]>([])
  const [loading, setLoading] = useState(true)
  const [permission, setPermission] = useState<PushPermission>(() => pushEnv().permission)
  const nav = useNavigate()

  async function load() {
    setLoading(true)
    if (!isConfigured) { setLoading(false); return }
    const { data, error } = await supabase
      .from('notifications')
      .select('id,title,body,notification_type,read_at,created_at')
      .eq('recipient_id', profile.id)
      .order('created_at', { ascending: false })
      .limit(100)
    if (error) notify(error.message)
    setItems((data ?? []) as typeof items)
    setLoading(false)
  }

  useEffect(() => {
    void load()
    if (!isConfigured) return
    const channel = supabase
      .channel(`tt-notifications-${profile.id}`)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'notifications', filter: `recipient_id=eq.${profile.id}`,
      }, () => { void load() })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [profile.id])

  async function markRead(id: string) {
    const { error } = await supabase.from('notifications').update({ read_at: new Date().toISOString() }).eq('id', id)
    if (error) { notify(error.message); return }
    await load()
  }

  async function markAllRead() {
    const { error } = await supabase
      .from('notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('recipient_id', profile.id)
      .is('read_at', null)
    if (error) { notify(error.message); return }
    notify(t('savedOk'))
    await load()
  }

  async function enableNotifications() {
    const result = await requestPushPermission()
    setPermission(result)
    notify(result === 'granted' ? t('notificationsOn') : t('notificationsBlocked'))
  }

  async function open(item: typeof items[number]) {
    if (!item.read_at) {
      await supabase.from('notifications').update({ read_at: new Date().toISOString() }).eq('id', item.id)
    }
    const kind = item.notification_type || ''
    if (kind.includes('message')) nav('/messages')
    else if (kind.includes('notice')) nav('/notices')
    else if (kind.includes('report')) nav('/reports')
    else await load()
  }

  const env = pushEnv()
  const unreadCount = items.filter((x) => !x.read_at).length

  return (
    <>
      <Heading
        title={t('notifications')}
        action={(
          <div className="heading-actions">
            {env.supported && permission === 'default' && (
              <button className="secondary action-btn" onClick={enableNotifications}>{t('enableNotifications')}</button>
            )}
            {permission === 'granted' && <span className="pill success">{t('notificationsOn')}</span>}
            {(permission === 'denied' || !env.supported || permission === 'unsupported') && (
              <span className="pill warning">{t('notificationsBlocked')}</span>
            )}
            {unreadCount > 0 && <button className="secondary action-btn" onClick={markAllRead}>{t('markRead')}</button>}
          </div>
        )}
      />
      <p className="muted">{t('browserNotificationsHint')}</p>
      {loading ? <Empty t={t} /> : items.length === 0 ? <Empty t={t} /> : (
        <section className="panel">
          {items.map((item) => (
            <button className="student-row" key={item.id} onClick={() => { void open(item) }}
              style={{ width: '100%', background: 'transparent', textAlign: 'start' }}>
              <div className="report-icon"><Bell size={18} /></div>
              <div className="grow">
                <b>{item.title}</b>
                <small>{item.body}</small>
                <small>{formatDateTime(item.created_at)}</small>
              </div>
              {!item.read_at && <span className="unread-badge">{t('unread')}</span>}
            </button>
          ))}
        </section>
      )}
    </>
  )
}
type ConversationRow = {
  id: string
  title: string | null
  conversation_type: string
  created_by: string
  created_at: string
}

function Messages({ profile, t }: { profile: Profile; t: T }) {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [current, setCurrent] = useState<Conversation | null>(null)
  const [items, setItems] = useState<ChatMessage[]>([])
  const [people, setPeople] = useState<Person[]>([])
  const [unread, setUnread] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [createOpen, setCreateOpen] = useState(false)
  const [membersOpen, setMembersOpen] = useState(false)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [recording, setRecording] = useState(false)
  const [inviteName, setInviteName] = useState('')
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteBusy, setInviteBusy] = useState(false)
  const [memberPick, setMemberPick] = useState('')
  const [hasMore, setHasMore] = useState(false)
  const [olderBusy, setOlderBusy] = useState(false)
  const [mediaUrls, setMediaUrls] = useState<Record<string, string>>({})
  const recorder = useRef<MediaRecorder | null>(null)
  const chunks = useRef<Blob[]>([])
  const scrollRef = useRef<HTMLDivElement | null>(null)

  async function loadPeople() {
    if (!isConfigured || !profile.institution_id) { setPeople([]); return }
    const { data } = await supabase
      .from('profiles')
      .select('id,full_name,email,role')
      .eq('institution_id', profile.institution_id)
      .eq('account_status', 'active')
      .neq('id', profile.id)
      .order('full_name')
    setPeople((data ?? []) as Person[])
  }

  async function loadConversations() {
    setLoading(true)
    if (!isConfigured) { setLoading(false); return }
    const { data: mine, error: mineError } = await supabase
      .from('conversation_members')
      .select('conversation_id')
      .eq('profile_id', profile.id)
    if (mineError) { notify(mineError.message); setLoading(false); return }
    const ids = (mine ?? []).map((row: { conversation_id: string }) => row.conversation_id)
    if (!ids.length) {
      setConversations([])
      setUnread({})
      setCurrent(null)
      setLoading(false)
      return
    }
    const [conversationRes, memberRes, unreadRes] = await Promise.all([
      supabase.from('conversations').select('*').in('id', ids).order('created_at', { ascending: false }),
      supabase.from('conversation_members').select('conversation_id,profile_id').in('conversation_id', ids),
      supabase.rpc('unread_counts'),
    ])
    if (conversationRes.error || memberRes.error) {
      notify((conversationRes.error || memberRes.error)?.message || t('errorGeneric'))
      setLoading(false)
      return
    }
    const memberRows = (memberRes.data ?? []) as { conversation_id: string; profile_id: string }[]
    const profileIds = [...new Set(memberRows.map((row) => row.profile_id))]
    let profiles: Person[] = []
    if (profileIds.length) {
      const { data } = await supabase.from('profiles').select('id,full_name,email,role').in('id', profileIds)
      profiles = (data ?? []) as Person[]
    }
    const mapped = ((conversationRes.data ?? []) as ConversationRow[]).map((conversation) => {
      const members = memberRows
        .filter((row) => row.conversation_id === conversation.id)
        .flatMap((row) => {
          const person = profiles.find((p) => p.id === row.profile_id)
          return person ? [person] : []
        })
      const others = members.filter((person) => person.id !== profile.id)
      const names = members.map((person) => person.full_name || person.email).join(' · ')
      const label = conversation.title
        || (conversation.conversation_type === 'direct'
          ? (others[0]?.full_name || others[0]?.email || t('directConversation'))
          : (names || t('groupConversation')))
      return { ...conversation, label, people: members }
    })
    setConversations(mapped)
    const counts: Record<string, number> = {}
    if (!unreadRes.error) {
      for (const row of (unreadRes.data ?? []) as { conversation_id: string; unread: number | string }[]) {
        counts[row.conversation_id] = Number(row.unread) || 0
      }
    }
    setUnread(counts)
    setCurrent((prev) => {
      if (prev) {
        const found = mapped.find((conversation) => conversation.id === prev.id)
        if (found) return found
      }
      return mapped[0] ?? null
    })
    setLoading(false)
  }

  async function loadMessages(id: string, older = false) {
    if (!isConfigured) return
    let query = supabase
      .from('messages')
      .select('id,body,sender_id,created_at,message_type,media_path,profiles:profiles!messages_sender_id_fkey(full_name)')
      .eq('conversation_id',id)
      .order('created_at', { ascending: false })
      .limit(50)
    if (older && items.length) query = query.lt('created_at', items[0].created_at)
    const { data, error } = await query
    if (error) { notify(error.message); return }
    const rows = ((data ?? []) as ChatMessage[]).slice().reverse()
    const nextUrls = { ...mediaUrls }
    await Promise.all(rows.filter((row) => row.media_path).map(async (row) => {
      const { data: link } = await supabase.storage.from('trainer-media').createSignedUrl(row.media_path as string, 3600)
      if (link?.signedUrl) nextUrls[row.id] = link.signedUrl
    }))
    setMediaUrls(nextUrls)
    if (older) setItems((prev) => [...rows, ...prev])
    else setItems(rows)
    setHasMore(rows.length === 50)
  }

  useEffect(() => {
    void loadPeople()
    void loadConversations()
  }, [profile.id, profile.institution_id])

  useEffect(() => {
    if (!current) return
    void loadMessages(current.id)
    if (!isConfigured) return
    const channel = supabase
      .channel(`tt-chat-${current.id}`)
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'messages', filter: `conversation_id=eq.${current.id}`,
      }, () => {
        void loadMessages(current.id)
        // The conversation is on screen, so a new message is already read. When
        // the tab is hidden leave it unread so the badge is truthful on return.
        if (document.visibilityState === 'visible') void markConversationRead(current.id)
      })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [current?.id])

  useEffect(() => {
    const element = scrollRef.current
    if (element) element.scrollTop = element.scrollHeight
  }, [items, current?.id])

  async function markConversationRead(id: string) {
    if (!isConfigured) return
    const { error } = await supabase.rpc('mark_conversation_read', { p_conversation_id: id })
    if (!error) setUnread((prev) => ({ ...prev, [id]: 0 }))
  }

  async function openConversation(conversation: Conversation) {
    setCurrent(conversation)
    setItems([])
    await markConversationRead(conversation.id)
  }

  async function loadOlder() {
    if (!current || !hasMore || olderBusy) return
    setOlderBusy(true)
    await loadMessages(current.id, true)
    setOlderBusy(false)
  }
  async function createConversation(e: FormEvent) {
    e.preventDefault()
    if (!isConfigured) { notify(t('configMissing')); return }
    if (!selected.length) { notify(t('selectAtLeastOne')); return }
    setBusy(true)
    const { error } = await supabase.rpc('create_conversation', {
      p_title: title.trim() || null,
      p_member_ids: selected,
    })
    setBusy(false)
    if (error) { notify(error.message); return }
    setCreateOpen(false)
    setSelected([])
    setTitle('')
    await loadConversations()
  }

  async function send(e: FormEvent) {
    e.preventDefault()
    if (!current || (!body.trim() && !file)) return
    if (!isConfigured) { notify(t('configMissing')); return }
    setBusy(true)
    let media_path: string | null = null
    let message_type = 'text'
    if (file) {
      const extension = file.name.split('.').pop() || 'bin'
      media_path = `${profile.institution_id}/${current.id}/${profile.id}/${crypto.randomUUID()}.${extension}`
      const { error: uploadError } = await supabase.storage.from('trainer-media').upload(media_path, file, { upsert: false, contentType: file.type })
      if (uploadError) { notify(uploadError.message); setBusy(false); return }
      message_type = file.type.startsWith('image/') ? 'image' : file.type.startsWith('audio/') ? 'audio' : 'file'
    }
    const { error } = await supabase.from('messages').insert({
      sender_id: profile.id,
      institution_id: profile.institution_id,
      conversation_id:current.id,
      body: body.trim() || null,
      message_type,
      media_path,
    })
    setBusy(false)
    if (error) { notify(error.message); return }
    setBody('')
    setFile(null)
    await loadMessages(current.id)
  }

  async function startRecording() {
    if (!isConfigured) { notify(t('configMissing')); return }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      notify(t('micDenied'))
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const rec = new MediaRecorder(stream)
      recorder.current = rec
      chunks.current = []
      rec.ondataavailable = (event) => { if (event.data.size) chunks.current.push(event.data) }
      rec.onstop = () => {
        if (!chunks.current.length) notify(t('nothingRecorded'))
        else {
          const blob = new Blob(chunks.current, { type: rec.mimeType || 'audio/webm' })
          setFile(new File([blob], `voice-${Date.now()}.webm`, { type: blob.type }))
        }
        stream.getTracks().forEach((track) => track.stop())
      }
      rec.start()
      setRecording(true)
    } catch {
      notify(t('micDenied'))
    }
  }

  function stopRecording() {
    recorder.current?.stop()
    setRecording(false)
  }

  async function inviteCoach(e: FormEvent) {
    e.preventDefault()
    if (!isConfigured) { notify(t('configMissing')); return }
    setInviteBusy(true)
    const { data, error } = await supabase.functions.invoke('invite-user', {
      body: {
        email: inviteEmail.trim(),
        full_name: inviteName.trim(),
        role: 'coach',
        institution_id: profile.institution_id,
      },
    })
    setInviteBusy(false)
    const functionError = (data as { error?: string } | null)?.error
    if (error || functionError) { notify(error?.message || functionError || t('errorGeneric')); return }
    notify(t('inviteSent'))
    setInviteName('')
    setInviteEmail('')
    setInviteOpen(false)
    await loadPeople()
  }

  async function addMember() {
    if (!current || !memberPick) return
    if (!canManageMembers) { notify(t('noPermission')); return }
    const { error } = await supabase.from('conversation_members').insert({
      conversation_id: current.id,
      profile_id: memberPick,
    })
    if (error) { notify(error.message); return }
    notify(t('savedOk'))
    setMemberPick('')
    await loadConversations()
  }

  async function removeMember(profileId: string) {
    if (!current) return
    if (!canManageMembers) { notify(t('noPermission')); return }
    if (!window.confirm(t('removeMemberConfirm'))) return
    const { error } = await supabase.from('conversation_members')
      .delete()
      .eq('conversation_id', current.id)
      .eq('profile_id', profileId)
    if (error) { notify(error.message); return }
    notify(t('savedOk'))
    await loadConversations()
  }
  const memberCandidates = current
    ? people.filter((person) => !(current.people ?? []).some((member) => member.id === person.id))
    : []
  const canManageMembers = Boolean(current)
    && (current?.created_by === profile.id || ['owner', 'manager', 'admin'].includes(profile.role))

  return (
    <>
      <Heading
        title={t('messages')}
        action={(
          <div className="heading-actions">
            <button className="secondary action-btn" onClick={() => setInviteOpen(true)}>
              <UserPlus size={17} /> {t('inviteCoach')}
            </button>
            <button className="primary action-btn" onClick={() => setCreateOpen(true)}>
              <MessageCircle size={17} /> {t('newConversation')}
            </button>
          </div>
        )}
      />
      <section className="panel chat-workspace">
        <aside className="conversation-list">
          {loading ? <p className="muted">{t('loading')}</p> : conversations.length === 0 ? (
            <p className="muted">{t('noConversations')}</p>
          ) : conversations.map((conversation) => (
            <button key={conversation.id} className={`conversation-item ${current?.id === conversation.id ? 'selected' : ''}`}
              onClick={() => { void openConversation(conversation) }}>
              <span className="avatar"><Users size={17} /></span>
              <span className="grow">
                <b>{conversation.label}</b>
                <small>{conversation.conversation_type === 'direct' ? t('directConversation') : t('groupConversation')}</small>
              </span>
              {(unread[conversation.id] || 0) > 0 && <span className="unread-badge">{unread[conversation.id]}</span>}
            </button>
          ))}
        </aside>
        <div className="chat-panel-inner">
          {current ? (
            <>
              <div className="chat-title">
                <div className="grow">
                  <b>{current.label}</b>
                  <small>{current.conversation_type === 'direct' ? t('directConversation') : t('groupConversation')}</small>
                </div>
                {current.conversation_type === 'group' && (
                  <button className="secondary members-btn" onClick={() => setMembersOpen(true)}>
                    <Users size={15} /> {t('groupMembers')}
                  </button>
                )}
              </div>
              <div className="chat-messages" ref={scrollRef}>
                {hasMore && (
                  <button className="secondary load-older" disabled={olderBusy} onClick={() => { void loadOlder() }}>
                    {olderBusy ? t('loading') : t('loadOlder')}
                  </button>
                )}
                {items.length === 0 ? <p className="muted empty-chat">{t('noMessages')}</p> : items.map((message) => {
                  const url = mediaUrls[message.id] || message.media_url
                  return (
                    <div className={`chat-bubble ${message.sender_id === profile.id ? 'mine' : ''}`} key={message.id}>
                      <b>{message.profiles?.full_name || t('coach')}</b>
                      {message.body && <p>{message.body}</p>}
                      {url && (message.message_type === 'image'
                        ? <img className="chat-image" src={url} alt={t('attachment')} />
                        : message.message_type === 'audio'
                          ? <audio controls src={url} />
                          : <a href={url} target="_blank" rel="noreferrer">{t('openAttachment')}</a>)}
                      <small>{formatTime(message.created_at)}</small>
                    </div>
                  )
                })}
              </div>
              <form className="chat-compose" onSubmit={send}>
                <label className="attach-btn" title={t('attach')}>
                  <Paperclip size={19} />
                  <input type="file" accept="image/jpeg,image/png,image/webp,audio/webm,audio/mp4,application/pdf"
                    onChange={(e) => { setFile(e.target.files?.[0] ?? null); e.target.value = '' }} />
                </label>
                <button type="button" className={`icon-btn ${recording ? 'recording' : ''}`}
                  onClick={recording ? stopRecording : () => { void startRecording() }}
                  title={recording ? t('stopRecording') : t('recordVoice')}
                  aria-label={recording ? t('stopRecording') : t('recordVoice')}>
                  {recording ? <Square size={18} /> : <Mic size={18} />}
                </button>
                <input value={body} onChange={(e) => setBody(e.target.value)}
                  placeholder={file ? file.name : t('typeMessage')} />
                <button className="primary icon-send" disabled={busy || (!body.trim() && !file)} aria-label={t('send')}>
                  <Send size={18} />
                </button>
              </form>
            </>
          ) : <div className="empty-chat">{t('pickConversation')}</div>}
        </div>
      </section>

      {inviteOpen && (
        <Modal title={t('inviteCoachTitle')} close={() => setInviteOpen(false)} closeLabel={t('close')}>
          <form onSubmit={inviteCoach}>
            <p className="muted">{t('coachInviteHint')}</p>
            <label>{t('coachName')}<input required value={inviteName} onChange={(e) => setInviteName(e.target.value)} /></label>
            <label>{t('email')}<input required type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} /></label>
            <div className="modal-actions">
              <button type="button" className="secondary" onClick={() => setInviteOpen(false)}>{t('cancel')}</button>
              <button className="primary" disabled={inviteBusy}>{inviteBusy ? t('sendingInvite') : t('sendInvite')}</button>
            </div>
          </form>
        </Modal>
      )}

      {createOpen && (
        <Modal title={t('createConversationTitle')} close={() => setCreateOpen(false)} closeLabel={t('close')}>
          <form onSubmit={createConversation}>
            <p className="notice-box">{t('participantsHelp')}</p>
            <label>{t('groupNameOptional')}
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('groupNamePlaceholder')} />
            </label>
            <label>{t('selectParticipants')}
              <select multiple size={Math.min(6, Math.max(3, people.length))} value={selected}
                onChange={(e) => setSelected(Array.from(e.target.selectedOptions, (option) => option.value))}>
                {people.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.full_name || person.email} — {t(person.role || 'coach')}
                  </option>
                ))}
              </select>
            </label>
            <small className="muted">{t('selectOneCoach')}</small>
            <div className="modal-actions">
              <button type="button" className="secondary" onClick={() => setCreateOpen(false)}>{t('cancel')}</button>
              <button className="primary" disabled={busy || !selected.length}>{busy ? t('creating') : t('createConversation')}</button>
            </div>
          </form>
        </Modal>
      )}

      {membersOpen && current && (
        <Modal title={t('groupMembers')} close={() => setMembersOpen(false)} closeLabel={t('close')}>
          <p className="muted">{canManageMembers ? t('membersHelp') : t('membersManageHint')}</p>
          <div className="member-list">
            {(current.people ?? []).map((person) => (
              <div className="student-row" key={person.id}>
                <div className="avatar">{(person.full_name || person.email || '?').slice(0, 1)}</div>
                <div className="grow"><b>{person.full_name || person.email}</b><small>{person.email}</small></div>
                {canManageMembers && person.id !== profile.id && (
                  <button className="danger" onClick={() => { void removeMember(person.id) }}>
                    <Trash2 size={15} /> {t('removeMember')}
                  </button>
                )}
              </div>
            ))}
          </div>
          {canManageMembers && memberCandidates.length > 0 && (
            <div>
              <label>{t('addMember')}
                <select value={memberPick} onChange={(e) => setMemberPick(e.target.value)}>
                  <option value="">—</option>
                  {memberCandidates.map((person) => (
                    <option key={person.id} value={person.id}>{person.full_name || person.email}</option>
                  ))}
                </select>
              </label>
              <button className="primary" disabled={!memberPick} onClick={() => { void addMember() }}>
                <UserPlus size={16} /> {t('addMember')}
              </button>
            </div>
          )}
        </Modal>
      )}
    </>
  )
}
function OwnerConsole({ profile, t }: { profile: Profile; t: T }) {
  const [institutions, setInstitutions] = useState<{ id: string; name: string; is_active: boolean }[]>([])
  const [pending, setPending] = useState<{ id: string; full_name: string; email: string }[]>([])
  const [loading, setLoading] = useState(true)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [fullName, setFullName] = useState('')
  const [institution, setInstitution] = useState('')
  const [busy, setBusy] = useState(false)

  async function load() {
    setLoading(true)
    if (!isConfigured) { setLoading(false); return }
    const [institutionRes, pendingRes] = await Promise.all([
      supabase.from('institutions').select('id,name,is_active').order('created_at', { ascending: false }),
      supabase.from('profiles').select('id,full_name,email').eq('role', 'manager').eq('account_status', 'pending').order('created_at', { ascending: false }),
    ])
    if (institutionRes.error || pendingRes.error) notify((institutionRes.error || pendingRes.error)?.message || t('errorGeneric'))
    setInstitutions((institutionRes.data ?? []) as { id: string; name: string; is_active: boolean }[])
    setPending((pendingRes.data ?? []) as { id: string; full_name: string; email: string }[])
    setLoading(false)
  }

  useEffect(() => { void load() }, [])

  async function createInstitution(e: FormEvent) {
    e.preventDefault()
    if (!isConfigured) { notify(t('configMissing')); return }
    setBusy(true)
    const { error } = await supabase.from('institutions').insert({ name: name.trim(), default_language: 'ar' })
    setBusy(false)
    if (error) { notify(error.message); return }
    setName('')
    notify(t('savedOk'))
    await load()
  }

  async function appointManager(e: FormEvent) {
    e.preventDefault()
    if (!isConfigured) { notify(t('configMissing')); return }
    setBusy(true)
    const { data, error } = await supabase.functions.invoke('invite-user', {
      body: { email: email.trim(), full_name: fullName.trim(), role: 'manager', institution_id: institution },
    })
    setBusy(false)
    const functionError = (data as { error?: string } | null)?.error
    if (error || functionError) { notify(error?.message || functionError || t('errorGeneric')); return }
    notify(t('inviteSent'))
    setEmail('')
    setFullName('')
    await load()
  }

  async function approveManager(id: string) {
    const { error } = await supabase.from('profiles').update({
      account_status: 'active',
      approved_by: profile.id,
      approved_at: new Date().toISOString(),
    }).eq('id', id)
    if (error) { notify(error.message); return }
    notify(t('savedOk'))
    await load()
  }

  async function rejectManager(id: string) {
    const { error } = await supabase.from('profiles').update({ account_status: 'rejected' }).eq('id', id)
    if (error) { notify(error.message); return }
    notify(t('savedOk'))
    await load()
  }

  async function setInstitutionActive(item: { id: string; name: string; is_active: boolean }, next: boolean) {
    if (!isConfigured) { notify(t('configMissing')); return }
    if (!next && !window.confirm(t('deactivateInstitutionConfirm'))) return
    setBusy(true)
    const { error } = await supabase.from('institutions').update({ is_active: next }).eq('id', item.id)
    setBusy(false)
    if (error) { notify(error.message); return }
    notify(t('savedOk'))
    await load()
  }

  return (
    <>
      <Heading title={t('ownerConsole')} subtitle={t('platform')} />
      <section className="panel">
        <h3>{t('createInstitution')}</h3>
        <form onSubmit={createInstitution}>
          <label>{t('institution')}<input required value={name} onChange={(e) => setName(e.target.value)} /></label>
          <button className="primary" disabled={busy}>{t('save')}</button>
        </form>
      </section>
      <section className="panel">
        <h3>{t('appointManager')}</h3>
        <form onSubmit={appointManager}>
          <label>{t('institution')}
            <select required value={institution} onChange={(e) => setInstitution(e.target.value)}>
              <option value="">—</option>
              {institutions.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <label>{t('managerName')}<input required value={fullName} onChange={(e) => setFullName(e.target.value)} /></label>
          <label>{t('managerEmail')}<input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
          <button className="primary" disabled={busy}>{t('sendInvite')}</button>
        </form>
      </section>
      <section className="panel">
        <h3>{t('pendingAccounts')}</h3>
        {loading ? <Empty t={t} /> : pending.length === 0 ? <Empty t={t} /> : pending.map((person) => (
          <div className="student-row" key={person.id}>
            <div className="avatar">{(person.full_name || person.email || '?').slice(0, 1)}</div>
            <div className="grow"><b>{person.full_name || person.email}</b><small>{person.email}</small></div>
            <button className="secondary" onClick={() => { void approveManager(person.id) }}>{t('approve')}</button>
            <button className="danger" onClick={() => { void rejectManager(person.id) }}>{t('reject')}</button>
          </div>
        ))}
      </section>
      <section className="panel">
        <h3>{t('institutions')}</h3>
        {institutions.length === 0 ? <Empty t={t} /> : institutions.map((item) => (
          <div className="student-row" key={item.id}>
            <div className="avatar"><Building2 size={18} /></div>
            <div className="grow"><b>{item.name}</b><small>{item.id}</small></div>
            <span className={`pill ${item.is_active ? 'success' : 'warning'}`}>{item.is_active ? t('active') : t('inactive')}</span>
            <button
              className={item.is_active ? 'danger' : 'secondary'}
              disabled={busy}
              onClick={() => { void setInstitutionActive(item, !item.is_active) }}
            >
              {item.is_active ? t('deactivateInstitution') : t('activateInstitution')}
            </button>
          </div>
        ))}
      </section>
      <section className="panel">
        <h3>{t('manageClasses')}</h3>
        <ClassManagement profile={profile} t={t} />
      </section>
      <section className="panel">
        <h3>{t('absenceFollowups')}</h3>
        <FollowUpQueue profile={profile} t={t} />
      </section>
    </>
  )
}

function Team({ profile, t }: { profile: Profile; t: T }) {
  const [items, setItems] = useState<(Person & { created_at?: string })[]>([])
  const [email, setEmail] = useState('')
  const [fullName, setFullName] = useState('')
  const [role, setRole] = useState('coach')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const inviteRoles = profile.role === 'manager' ? ['coach', 'admin'] : ['coach']
  // Mirrors the profiles_admin_update RLS check: the owner and other managers
  // are not editable from an institution team screen. Showing the buttons for
  // them only produced a "permission denied" error from Postgres.
  const canManagePerson = (person: Person) =>
    person.id !== profile.id && person.role !== 'owner' && person.role !== 'manager'

  async function load() {
    setLoading(true)
    if (!isConfigured || !profile.institution_id) { setLoading(false); return }
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('institution_id', profile.institution_id)
      .order('created_at', { ascending: false })
    if (error) notify(error.message)
    setItems((data ?? []) as (Person & { created_at?: string })[])
    setLoading(false)
  }

  useEffect(() => { void load() }, [profile.institution_id])

  async function invite(e: FormEvent) {
    e.preventDefault()
    if (!isConfigured) { notify(t('configMissing')); return }
    setBusy(true)
    const { data, error } = await supabase.functions.invoke('invite-user', {
      body: { email: email.trim(), full_name: fullName.trim(), role, institution_id: profile.institution_id },
    })
    setBusy(false)
    const functionError = (data as { error?: string } | null)?.error
    if (error || functionError) { notify(error?.message || functionError || t('errorGeneric')); return }
    notify(t('inviteSent'))
    setEmail('')
    setFullName('')
    await load()
  }

  async function setStatus(person: Person, next: string) {
    if (person.id === profile.id) { notify(t('noPermission')); return }
    if (!canManagePerson(person)) { notify(t('noPermission')); return }
    const payload: Record<string, string | null> = { account_status: next }
    if (next === 'active') {
      payload.approved_by = profile.id
      payload.approved_at = new Date().toISOString()
    }
    const { error } = await supabase.from('profiles').update(payload).eq('id', person.id)
    if (error) { notify(error.message); return }
    notify(t('savedOk'))
    await load()
  }

  return (
    <>
      <Heading title={t('team')} />
      <section className="panel">
        <h3>{t('invite')}</h3>
        <p className="muted">{t('inviteHint')}</p>
        <form onSubmit={invite}>
          <label>{t('name')}<input required value={fullName} onChange={(e) => setFullName(e.target.value)} /></label>
          <label>{t('email')}<input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
          <label>{t('role')}
            <select value={role} onChange={(e) => setRole(e.target.value)}>
              {inviteRoles.map((item) => <option key={item} value={item}>{t(item)}</option>)}
            </select>
          </label>
          <button className="primary" disabled={busy}>{t('sendInvite')}</button>
        </form>
      </section>
      <section className="panel">
        <h3>{t('manageAccounts')}</h3>
        {loading ? <Empty t={t} /> : items.length === 0 ? <Empty t={t} /> : items.map((person) => (
          <div className="student-row" key={person.id}>
            <div className="avatar">{(person.full_name || person.email || '?').slice(0, 1)}</div>
            <div className="grow"><b>{person.full_name || person.email}</b><small>{person.email} · {t(person.role || 'coach')}</small></div>
            <span className={`pill ${person.account_status === 'active' ? 'success' : 'warning'}`}>
              {t(person.account_status || 'pending')}
            </span>
            {person.account_status === 'pending' && canManagePerson(person) && (
              <>
                <button className="secondary" onClick={() => { void setStatus(person, 'active') }}>{t('approve')}</button>
                <button className="danger" onClick={() => { void setStatus(person, 'rejected') }}>{t('reject')}</button>
              </>
            )}
            {person.account_status === 'active' && canManagePerson(person) && (
              <button className="danger" onClick={() => { void setStatus(person, 'suspended') }}>{t('suspend')}</button>
            )}
            {person.account_status === 'suspended' && canManagePerson(person) && (
              <button className="secondary" onClick={() => { void setStatus(person, 'active') }}>{t('reactivate')}</button>
            )}
          </div>
        ))}
      </section>
    </>
  )
}
function Medical({ profile, t }: { profile: Profile; t: T }) {
  const [students, setStudents] = useState<{ id: string; student_code: string; full_name: string }[]>([])
  const [records, setRecords] = useState<MedicalRecord[]>([])
  const [studentId, setStudentId] = useState('')
  const [kind, setKind] = useState('medical')
  const [details, setDetails] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  const typeLabels: Record<string, string> = {
    medical: t('medical'),
    injury: t('injured'),
    exemption: t('medicalExemption'),
    permission: t('permission'),
    other: t('other'),
  }

  async function load() {
    setLoading(true)
    if (!isConfigured || !profile.institution_id) { setLoading(false); return }
    const [studentRes, recordRes] = await Promise.all([
      supabase.from('students').select('id,student_code,full_name').eq('institution_id', profile.institution_id).order('full_name'),
      supabase.from('student_medical_records').select('*').eq('institution_id', profile.institution_id).order('created_at', { ascending: false }),
    ])
    if (studentRes.error || recordRes.error) notify((studentRes.error || recordRes.error)?.message || t('errorGeneric'))
    setStudents((studentRes.data ?? []) as { id: string; student_code: string; full_name: string }[])
    const mapped = await Promise.all(((recordRes.data ?? []) as MedicalRecord[]).map(async (record) => {
      if (!record.attachment_path) return record
      const { data } = await supabase.storage.from('trainer-medical').createSignedUrl(record.attachment_path, 3600)
      return { ...record, attachment_url: data?.signedUrl || '' }
    }))
    setRecords(mapped)
    setLoading(false)
  }

  useEffect(() => { void load() }, [profile.institution_id])

  async function add(e: FormEvent) {
    e.preventDefault()
    if (!isConfigured) { notify(t('configMissing')); return }
    if (!profile.institution_id || !studentId) { notify(t('noPermission')); return }
    setBusy(true)
    let attachment_path: string | null = null
    if (file) {
      const extension = file.name.split('.').pop() || 'bin'
      attachment_path = `${profile.institution_id}/${profile.id}/${crypto.randomUUID()}.${extension}`
      const { error: uploadError } = await supabase.storage
        .from('trainer-medical')
        .upload(attachment_path, file, { upsert: false, contentType: file.type })
      if (uploadError) { notify(uploadError.message); setBusy(false); return }
    }
    const { error } = await supabase.from('student_medical_records').insert({
      institution_id: profile.institution_id,
      student_id: studentId,
      record_type: kind,
      details: details.trim(),
      start_date: startDate || null,
      end_date: endDate || null,
      created_by: profile.id,
      attachment_path,
    })
    setBusy(false)
    if (error) { notify(error.message); return }
    notify(t('savedOk'))
    setStudentId('')
    setDetails('')
    setStartDate('')
    setEndDate('')
    setFile(null)
    await load()
  }

  return (
    <>
      <Heading title={t('medical')} subtitle={t('records')} />
      <section className="panel">
        <form onSubmit={add}>
          <label>{t('students')}
            <select required value={studentId} onChange={(e) => setStudentId(e.target.value)}>
              <option value="">—</option>
              {students.map((student) => (
                <option key={student.id} value={student.id}>{student.student_code} · {student.full_name}</option>
              ))}
            </select>
          </label>
          <label>{t('records')}
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              {Object.entries(typeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label>{t('notes')}
            <DictateButton t={t} onText={setDetails} />
            <textarea required rows={3} value={details} onChange={(e) => setDetails(e.target.value)} />
          </label>
          <label>{t('fromDate')}<input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></label>
          <label>{t('toDate')}<input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} /></label>
          <label>{t('medicalFile')}
            <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" onChange={(e) => { setFile(e.target.files?.[0] ?? null); e.target.value = '' }} />
          </label>
          <button className="primary" disabled={busy}>{t('save')}</button>
        </form>
      </section>
      {loading ? <Empty t={t} /> : records.length === 0 ? <Empty t={t} /> : records.map((record) => {
        const student = students.find((item) => item.id === record.student_id)
        return (
          <article className="panel notice" key={record.id}>
            <div className="notice-head">
              <b>{student ? `${student.student_code} · ${student.full_name}` : t('students')}</b>
              <span className="pill warning">{typeLabels[record.record_type] || t(record.record_type)}</span>
            </div>
            <p>{record.details}</p>
            {(record.start_date || record.end_date) && (
              <small>{record.start_date || '—'} → {record.end_date || '—'}</small>
            )}
            {record.attachment_url && (
              <a href={record.attachment_url} target="_blank" rel="noreferrer">{t('openAttachment')}</a>
            )}
            <small>{formatDateTime(record.created_at)}</small>
          </article>
        )
      })}
    </>
  )
}
function ClassManagement({ profile, t }: { profile: Profile; t: T }) {
  const [classes, setClasses] = useState<{ id: string; name: string; academic_year: string; description: string }[]>([])
  const [name, setName] = useState('')
  const [academicYear, setAcademicYear] = useState('')
  const [description, setDescription] = useState('')
  const [editingClass, setEditingClass] = useState<{ id: string; name: string; academic_year: string; description: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  async function load() {
    setLoading(true)
    if (!isConfigured || !profile.institution_id) { setLoading(false); return }
    const { data, error } = await supabase
      .from('classes')
      .select('id,name,academic_year,description')
      .order('name')
    if (error) notify(error.message)
    else setClasses(data ?? [])
    setLoading(false)
  }

  useEffect(() => { void load() }, [profile.institution_id])

  async function create(e: FormEvent) {
    e.preventDefault()
    if (!isConfigured || !profile.institution_id) { notify(t('configMissing')); return }
    setBusy(true)
    const { error } = await supabase.from('classes').insert({ name: name.trim(), academic_year: academicYear.trim(), description: description.trim() || null, institution_id: profile.institution_id })
    setBusy(false)
    if (error) { notify(error.message); return }
    notify(t('savedOk'))
    setName(''); setAcademicYear(''); setDescription('')
    await load()
  }

  async function update(e: FormEvent, classId: string) {
    e.preventDefault()
    if (!isConfigured || !profile.institution_id) { notify(t('configMissing')); return }
    setBusy(true)
    const { error } = await supabase.from('classes').update({ name: name.trim(), academic_year: academicYear.trim(), description: description.trim() || null }).eq('id', classId)
    setBusy(false)
    if (error) { notify(error.message); return }
    notify(t('savedOk'))
    setEditingClass(null)
    setName(''); setAcademicYear(''); setDescription('')
    await load()
  }

  async function remove(classId: string) {
    if (!window.confirm(t('deleteClassConfirm'))) return
    setBusy(true)
    const { error } = await supabase.from('classes').delete().eq('id', classId)
    setBusy(false)
    if (error) { notify(error.message); return }
    notify(t('deleted'))
    await load()
  }

  return (
    <>
      <Heading title={t('classes')} />
      <section className="panel">
        <h3>{t('addClass')}</h3>
        <form onSubmit={create}>
          <label>{t('className')}<input required value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label>{t('academicYear')}<input required value={academicYear} onChange={(e) => setAcademicYear(e.target.value)} /></label>
          <label>{t('description')}<textarea value={description} onChange={(e) => setDescription(e.target.value)} /></label>
          <button className="primary" disabled={busy}>{t('save')}</button>
        </form>
      </section>
      <section className="panel">
        <h3>{t('manageClasses')}</h3>
        {loading ? <Empty t={t} /> : classes.length === 0 ? (
          <p>{t('noClassesYet')}</p>
        ) : classes.map((c) => (
          <div key={c.id} className="student-row">
            <div className="grow"><b>{c.name}</b><small>{c.academic_year}</small></div>
            <span className={`pill warning`}>{c.description || t('noDescription')}</span>
            <div className="actions">
              <button className="secondary small" onClick={() => setEditingClass(c)}>{t('classEdit')}</button>
              <button className="danger small" onClick={() => remove(c.id)}>{t('deleteClass')}</button>
            </div>
          </div>
        ))}
      </section>
      {editingClass && (
        <section className="panel">
          <h3>{t('classEdit')}</h3>
          <form onSubmit={(e) => update(e, edittingClass.id)}>
            <input defaultValue={editingClass.name} readOnly />
            <label>{t('academicYear')}<input defaultValue={editingClass.academic_year} /></label>
            <label>{t('description')}<textarea defaultValue={editingClass.description} /></label>
            <button className="primary" disabled={busy}>{t('save')}</button>
            <button type="button" className="secondary" onClick={() => setEditingClass(null)}>{t('cancel')}</button>
          </form>
        </section>
      )}
    </>
  )
}

function FollowUpQueue({ profile, t }: { profile: Profile; t: T }) {
  const [items, setItems] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const admin = ['owner', 'manager', 'admin'].includes(profile.role)

  async function load() {
    setLoading(true)
    if (!isConfigured || !profile.institution_id || !admin) { setLoading(false); return }
    const { data, error } = await supabase
      .from('absence_followups')
      .select(`
        student_id,
        students!inner(student_code, full_name),
        streak,
        status,
        last_follow_up_at
      `)
      .eq('institution_id', profile.institution_id)
      .order('streak', { ascending: false })
    if (error) notify(error.message)
    else setItems(data ?? [])
    setLoading(false)
  }

  useEffect(() => { void load() }, [profile.institution_id])

  return (
    <>
      <Heading title={t('absenceFollowups')} />
      {loading ? <Empty t={t} /> : items.length === 0 ? (
        <p>{t('noFollowups')}</p>
      ) : (
        <section className="panel">
          <div className="attendance-summary">
            {items.map((item) => (
              <div key={item.student_id} className="attendance-row">
                <div className="grow"><b>{item.full_name}</b><small>#{item.student_code}</small></div>
                <span className={`pill ${item.status === 'open' ? 'warning' : 'success'}`}>
                  {t(item.status)}
                </span>
                <small>{item.streak} {t('absences')} · {t('lastFollowUp')}: {item.last_follow_up_at ? formatDateTime(item.last_follow_up_at) : t('never')}</small>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  )
}

function InstitutionSettings({ profile, t }: { profile: Profile; t: T }) {
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [address, setAddress] = useState('')
  const [language, setLanguage] = useState<Lang>('ar')
  const [logo, setLogo] = useState<File | null>(null)
  const [logoUrl, setLogoUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)

  async function load() {
    setLoading(true)
    if (!isConfigured || !profile.institution_id) { setLoading(false); return }
    const { data, error } = await supabase
      .from('institutions')
      .select('*')
      .eq('id', profile.institution_id)
      .maybeSingle()
    if (error) { notify(error.message); setLoading(false); return }
    const row = data as {
      name?: string; phone?: string; email?: string; address?: string
      default_language?: Lang; logo_path?: string | null
    } | null
    if (row) {
      setName(row.name || '')
      setPhone(row.phone || '')
      setEmail(row.email || '')
      setAddress(row.address || '')
      setLanguage(row.default_language || 'ar')
      if (row.logo_path) {
        const { data: link } = await supabase.storage.from('trainer-avatars').createSignedUrl(row.logo_path, 3600)
        setLogoUrl(link?.signedUrl || '')
      }
    }
    setLoading(false)
  }

  useEffect(() => { void load() }, [profile.institution_id])

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!isConfigured || !profile.institution_id) { notify(t('configMissing')); return }
    setBusy(true)
    let logo_path: string | undefined
    if (logo) {
      const extension = logo.name.split('.').pop() || 'png'
      logo_path = `${profile.institution_id}/${profile.id}/institution-logo-${Date.now()}.${extension}`
      const { error: uploadError } = await supabase.storage
        .from('trainer-avatars')
        .upload(logo_path, logo, { contentType: logo.type, upsert: false })
      if (uploadError) { notify(uploadError.message); setBusy(false); return }
    }
    const payload: Record<string, string> = {
      name: name.trim(),
      phone,
      email,
      address,
      default_language: language,
    }
    if (logo_path) payload.logo_path = logo_path
    const { error } = await supabase.from('institutions').update(payload).eq('id', profile.institution_id)
    setBusy(false)
    if (error) { notify(error.message); return }
    notify(t('savedOk'))
    setLogo(null)
    await load()
  }

  if (loading) return <Empty t={t} />

  return (
    <>
      <Heading title={t('settings')} />
      <section className="panel">
        <form onSubmit={save}>
          <label>{t('institution')}<input required value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label>{t('phone')}<input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} /></label>
          <label>{t('contactEmail')}<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
          <label>{t('address')}<input value={address} onChange={(e) => setAddress(e.target.value)} /></label>
          <label>{t('defaultLanguage')}
            <select value={language} onChange={(e) => setLanguage(e.target.value as Lang)}>
              <option value="ar">العربية</option>
              <option value="fr">Français</option>
              <option value="en">English</option>
            </select>
          </label>
          {logoUrl && <img className="institution-logo" src={logoUrl} alt={t('logo')} />}
          <label>{t('logo')}
            <input type="file" accept="image/png,image/jpeg,image/webp"
              onChange={(e) => { setLogo(e.target.files?.[0] ?? null); e.target.value = '' }} />
          </label>
          <button className="primary" disabled={busy}>{t('save')}</button>
        </form>
      </section>
    </>
  )
}
function Audit({ t }: { t: T }) {
  const [items, setItems] = useState<AuditRow[]>([])
  const [loading, setLoading] = useState(true)
  const [action, setAction] = useState('')
  const [tableName, setTableName] = useState('')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')

  async function load(filters?: { action: string; table: string; from: string; to: string }) {
    setLoading(true)
    if (!isConfigured) { setLoading(false); return }
    const actionValue = filters ? filters.action : action
    const tableValue = filters ? filters.table : tableName
    const fromValue = filters ? filters.from : fromDate
    const toValue = filters ? filters.to : toDate
    let query = supabase
      .from('audit_logs')
      .select('*,profiles(full_name)')
      .order('created_at', { ascending: false })
      .limit(100)
    if (actionValue.trim()) query = query.ilike('action', `%${actionValue.trim()}%`)
    if (tableValue.trim()) query = query.eq('table_name', tableValue.trim())
    if (fromValue) query = query.gte('created_at', `${fromValue}T00:00:00`)
    if (toValue) query = query.lte('created_at', `${toValue}T23:59:59`)
    const { data, error } = await query
    if (error) notify(error.message)
    setItems((data ?? []) as AuditRow[])
    setLoading(false)
  }

  useEffect(() => { void load() }, [])

  function clearFilters() {
    setAction('')
    setTableName('')
    setFromDate('')
    setToDate('')
    void load({ action: '', table: '', from: '', to: '' })
  }

  return (
    <>
      <Heading title={t('audit')} subtitle={t('activityLog')} />
      <section className="panel">
        <form onSubmit={(e) => { e.preventDefault(); void load() }}>
          <label>{t('action')}<input value={action} onChange={(e) => setAction(e.target.value)} placeholder={t('all')} /></label>
          <label>{t('entity')}<input value={tableName} onChange={(e) => setTableName(e.target.value)} placeholder={t('all')} /></label>
          <label>{t('fromDate')}<input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} /></label>
          <label>{t('toDate')}<input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} /></label>
          <div className="heading-actions">
            <button className="primary" disabled={loading}>{t('filter')}</button>
            <button type="button" className="secondary" onClick={clearFilters}>{t('clear')}</button>
          </div>
        </form>
      </section>
      {loading ? <Empty t={t} /> : items.length === 0 ? <Empty t={t} /> : (
        <section className="panel">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t('actor')}</th>
                  <th>{t('entity')}</th>
                  <th>{t('action')}</th>
                  <th>{t('records')}</th>
                  <th>{t('previousValue')}</th>
                  <th>{t('newValue')}</th>
                  <th>{t('date')}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((row) => (
                  <tr key={row.id}>
                    <td>{row.profiles?.full_name || row.actor_id || '—'}</td>
                    <td>{row.table_name}</td>
                    <td>{row.action}</td>
                    <td>{row.record_id || '—'}</td>
                    <td title={row.old_data ? JSON.stringify(row.old_data) : ''}>
                      {row.old_data ? JSON.stringify(row.old_data).slice(0, 60) : '—'}
                    </td>
                    <td title={row.new_data ? JSON.stringify(row.new_data) : ''}>
                      {row.new_data ? JSON.stringify(row.new_data).slice(0, 60) : '—'}
                    </td>
                    <td>{formatDateTime(row.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  )
}
type SpeechRecognitionLike = {
  lang: string
  interimResults: boolean
  maxAlternatives: number
  onresult: (event: { results?: { [index: number]: { [index: number]: { transcript?: string } } } }) => void
  onerror: () => void
  start: () => void
}

function DictateButton({ onText, t }: { onText: (text: string) => void; t: T }) {
  function start() {
    const scope = window as unknown as {
      SpeechRecognition?: new () => SpeechRecognitionLike
      webkitSpeechRecognition?: new () => SpeechRecognitionLike
    }
    const Recognition = scope.SpeechRecognition || scope.webkitSpeechRecognition
    if (!Recognition) { notify(t('errorGeneric')); return }
    try {
      const recognition = new Recognition()
      recognition.lang = document.documentElement.lang === 'ar'
        ? 'ar-TN'
        : document.documentElement.lang === 'fr' ? 'fr-FR' : 'en-US'
      recognition.interimResults = false
      recognition.maxAlternatives = 1
      recognition.onresult = (event) => {
        const text = event.results?.[0]?.[0]?.transcript
        if (text) onText(text)
      }
      recognition.onerror = () => notify(t('micError'))
      recognition.start()
    } catch {
      notify(t('micError'))
    }
  }
  return (
    <button type="button" className="secondary dictation-btn" onClick={start}>
      <Mic size={15} /> {t('recordVoice')}
    </button>
  )
}

function Modal({ title, close, children, closeLabel }: {
  title: string
  close: () => void
  children: ReactNode
  closeLabel?: string
}) {
  const dialogRef = useRef<HTMLElement | null>(null)
  const closeRef = useRef(close)
  closeRef.current = close

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    dialogRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      previous?.focus?.()
    }
  }, [])

  return (
    <div className="modal-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) closeRef.current()
    }}>
      <section className="modal" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={dialogRef}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="icon-btn" aria-label={closeLabel || 'Close'} onClick={() => closeRef.current()}>
            <X />
          </button>
        </div>
        {children}
      </section>
    </div>
  )
}
