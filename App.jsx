import { useCallback, useEffect, useRef, useState } from 'react'
import './App.css'

const API = import.meta.env.VITE_API_URL || 'http://localhost:5000/api'
const BED_COLORS = ['red', 'yellow', 'green', 'black']
const CODES = [
  { name: 'Immediate', color: 'red', note: 'Life-threatening; immediate care' },
  { name: 'Delayed', color: 'yellow', note: 'Serious; treatment can be delayed' },
  { name: 'Minor', color: 'green', note: 'Walking wounded; minor injuries' },
  { name: 'Deceased', color: 'black', note: 'No signs of life' },
]
const INJURIES_BY_TRIAGE = {
  Immediate: [
    'High-risk internal hemorrhoids suspicion',
    'Tachycardia',
    'Unconscious / Unresponsive',
    'Severe Traumatic Brain Injury (TBI) / Active Posturing',
    'Penetrating Head or Neck Trauma',
    'Intubated / Acute Respiratory Failure',
    'Tension Pneumothorax / Open Chest Wound',
    'Severe Airway Obstruction / Facial Trauma',
    'Massive External Hemorrhage / Active Arterial Bleeding',
    'Emergency Unmatched O-Negative Blood Required',
    'Severe Hypovolemic / Traumatic Shock',
    'Pelvic Fracture / Crush Injury',
    'Cardiac Arrest / ACLS in Progress',
    'Acute Anaphylaxis / Severe Chemical Envenomation',
  ],
  Delayed: [
    'Rigid / Tender Abdomen',
    'Open / Compound Long Bone Fracture',
    'Major Closed Fracture / Multiple Skeletal Trauma',
    'Major Joint Dislocation with Compromised Pulse',
    'Spinal Injury / Stable Paraplegia / Rigid Collar',
    'Major Burn (>20% TBSA) (Scald / Flame / Chemical)',
    'Deep Laceration / Complex Soft Tissue Avulsion',
    'Crush Syndrome / Potential Rhabdomyolysis Risk',
  ],
  Minor: [
    'Minor lacerations',
    'Sprains/soft tissue damage',
    'Burns (<10% TBSA/minor scalds)',
    'Closed simple fracture',
    'Joint strain/minor dislocation',
    'Mild concussion/head strike (conscious)',
    'Minor eye injury /foreign body',
    'Stress or panic reactions',
  ],
  Deceased: [
    'No spontaneous Respiration',
    'Non survivable Lethal Trauma',
    'Catastrophic multi organ failure',
    'Extreme burns (>85%TBSA)',
    'Lethal radiation exposure/acute chemical lethality',
  ],
}

async function api(path, token, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers },
  })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(result.message || 'The request could not be completed.')
  return result
}

function App() {
  const [session, setSession] = useState(null)
  const [page, setPage] = useState('overview')
  const [patients, setPatients] = useState([])
  const [hospitals, setHospitals] = useState([])
  const [users, setUsers] = useState([])
  const [role, setRole] = useState('ambulance')
  const [credentials, setCredentials] = useState({ username: '', password: '' })
  const [caseCode, setCaseCode] = useState('')
  const [patient, setPatient] = useState(null)
  const [search, setSearch] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [loadingLabel, setLoadingLabel] = useState('')
  const [declining, setDeclining] = useState('')
  const [declineNote, setDeclineNote] = useState('')
  const [adminTab, setAdminTab] = useState('accounts')
  const knownStatuses = useRef(null)
  const [clock, setClock] = useState('')
  const [databaseStatus, setDatabaseStatus] = useState('checking')

  useEffect(() => {
    let active = true
    const checkDatabase = async () => {
      try {
        await api('/health')
        if (active) setDatabaseStatus('connected')
      } catch {
        if (active) setDatabaseStatus('offline')
      }
    }
    checkDatabase()
    const timer = window.setInterval(checkDatabase, 10000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [])

  const refresh = useCallback(async (quiet = false) => {
    if (!session) return
    try {
      const [nextPatients, nextHospitals] = await Promise.all([api('/patients', session.token), api('/hospitals', session.token)])
      if (knownStatuses.current) {
        const previous = knownStatuses.current
        const newlyPending = nextPatients.filter((item) => item.status === 'pending' && previous.get(item._id) !== 'pending')
        const decisions = nextPatients.filter((item) => ['accepted', 'declined'].includes(item.status) && previous.get(item._id) === 'pending' && previous.get(item._id) !== item.status)
        if (session.role === 'ambulance' && decisions.length) setMessage(`Hospital response received: ${decisions[0].status}${decisions.length > 1 ? ` (+${decisions.length - 1} more)` : ''}.`)
        if (session.role === 'hospital' && newlyPending.length) setMessage(`${newlyPending.length} new patient request${newlyPending.length === 1 ? '' : 's'} received.`)
        if (session.role === 'er' && nextPatients.some((item) => item.status === 'accepted' && !previous.has(item._id))) setMessage('A new accepted patient is on the ER arrivals board.')
      }
      knownStatuses.current = new Map(nextPatients.map((item) => [item._id, item.status]))
      setPatients(nextPatients)
      setHospitals(nextHospitals)
      if (session.role === 'admin') setUsers(await api('/users', session.token))
    } catch (issue) { if (!quiet) setError(issue.message) }
  }, [session])

  useEffect(() => {
    if (!session) return undefined
    refresh()
    const timer = window.setInterval(() => refresh(true), 5000)
    return () => window.clearInterval(timer)
  }, [refresh, session])

  useEffect(() => {
    const updateClock = () => setClock(new Intl.DateTimeFormat('en', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()))
    updateClock()
    const timer = window.setInterval(updateClock, 60000)
    return () => window.clearInterval(timer)
  }, [])

  const act = async (callback) => {
    setError('')
    try { await callback() } catch (issue) { setError(issue.message) }
  }
  const withLoader = async (label, callback) => {
    const minimumLoaderTime = new Promise((resolve) => window.setTimeout(resolve, 2000))
    setBusy(true)
    setLoadingLabel(label)
    try { await act(callback) }
    finally {
      await minimumLoaderTime
      setBusy(false)
      setLoadingLabel('')
    }
  }
  const login = async (event) => {
    event.preventDefault()
    await withLoader('Verifying your workspace…', async () => {
      const signedIn = await api('/auth/login', null, { method: 'POST', body: JSON.stringify({ ...credentials, role }) })
      knownStatuses.current = null
      setSession(signedIn)
      setCredentials({ username: '', password: '' })
      setPage('overview')
    })
  }
  const saveAssessment = async (event) => {
    event.preventDefault()
    await withLoader('Saving patient assessment…', async () => {
      const saved = await api('/patients', session.token, { method: 'POST', body: JSON.stringify({ ...patient, triage: caseCode, name: patient.name.trim() || 'Unknown', age: patient.age === '' ? null : Number(patient.age) }) })
      setPatient(saved)
      setPage('routing')
      setMessage('Patient details saved. Choose a receiving hospital.')
    })
  }
  const routePatient = (hospitalId) => withLoader('Sending hospital request…', async () => {
    await api(`/patients/${patient._id}/route`, session.token, { method: 'POST', body: JSON.stringify({ hospitalId }) })
    setPatient(null)
    setCaseCode('')
    setPage('overview')
    setMessage('Hospital request sent. You will be notified when it is reviewed.')
    await refresh(true)
  })
  const decide = (id, decision) => withLoader(decision === 'accepted' ? 'Confirming hospital acceptance…' : 'Recording decline decision…', async () => {
    await api(`/patients/${id}/decision`, session.token, { method: 'PATCH', body: JSON.stringify({ decision, note: decision === 'declined' ? declineNote : '' }) })
    setDeclining('')
    setDeclineNote('')
    setMessage(decision === 'accepted' ? 'Patient accepted. Ambulance and ER have been updated.' : 'Patient declined. The ambulance has been notified.')
    await refresh(true)
    setPage('overview')
  })
  const movePatientsToWard = (patientIds, ward) => withLoader('Moving patients to the selected ward…', async () => {
    for (const id of patientIds) await api(`/patients/${id}/ward`, session.token, { method: 'PATCH', body: JSON.stringify({ ward }) })
    setMessage(`${patientIds.length} patient${patientIds.length === 1 ? '' : 's'} moved to ${ward}.`)
    await refresh(true)
  })
  const dischargePatients = (patientIds) => {
    if (!window.confirm(`Discharge ${patientIds.length} selected patient${patientIds.length === 1 ? '' : 's'}? Any unreleased triage-code beds will be returned to availability.`)) return
    return withLoader('Updating discharge records…', async () => {
      for (const id of patientIds) await api(`/patients/${id}/discharge`, session.token, { method: 'PATCH' })
      setMessage(`${patientIds.length} patient${patientIds.length === 1 ? '' : 's'} discharged. Vacant beds have been updated.`)
      await refresh(true)
    })
  }

  if (!session) return <><Login role={role} setRole={setRole} credentials={credentials} setCredentials={setCredentials} login={login} busy={busy} error={error} databaseStatus={databaseStatus} /><LoadingOverlay active={busy} label={loadingLabel} /></>

  const roleTitle = { ambulance: 'Ambulance dispatch', hospital: 'Hospital management', er: 'Emergency room', admin: 'Administration' }[session.role]
  const pending = patients.filter((item) => item.status === 'pending' && (session.role === 'admin' || item.hospital?._id === session.hospitalId))
  const accepted = patients.filter((item) => item.status === 'accepted')
  const hospitalAdmissions = patients.filter((item) => item.status === 'accepted')
  const ownCases = patients.filter((item) => session.role === 'admin' || item.ambulance?._id === session.userId)
  const navigate = (next) => { setError(''); setMessage(''); setPage(next) }
  const goBack = () => {
    setError('')
    if (page === 'assessment') setPage('confirm')
    else if (page === 'routing') setPage(patient?.status === 'declined' ? 'overview' : 'assessment')
    else setPage('overview')
  }
  const logout = () => {
    knownStatuses.current = null
    setSession(null)
    setRole('ambulance')
    setPatients([])
    setHospitals([])
    setUsers([])
    setPage('overview')
    setCaseCode('')
    setPatient(null)
    setMessage('')
    setError('')
  }
  const heading = page === 'assessment' ? 'Patient assessment' : page === 'routing' ? 'Choose a hospital' : page === 'admin' ? 'Administration' : page === 'declines' ? 'Declined patients' : page === 'transfers' ? 'Ward transfers' : session.role === 'er' ? 'ER arrivals' : session.role === 'hospital' ? 'Incoming patients' : 'Dispatch overview'
  const currentPatients = session.role === 'hospital' ? pending : session.role === 'er' ? accepted : ownCases

  return <div className="shell">
    <aside className="sidebar"><button type="button" className="brand brand-button" aria-label="LifeQ home" onClick={() => navigate('overview')}><MedicalMark /><span>LifeQ<small>EMERGENCY NETWORK</small></span></button><p className="side-label">WORKSPACE</p><nav>{(session.role === 'admin' ? [['overview', 'Overview'], ['admin', 'Manage access'], ['declines', 'Declined patients'], ['transfers', 'Ward transfers']] : [['overview', session.role === 'er' ? 'Arrival board' : 'Overview']]).map(([key, label]) => <button key={key} className={page === key ? 'active' : ''} onClick={() => navigate(key)}><span>{key === 'admin' ? '⚙' : key === 'declines' ? '≋' : key === 'transfers' ? '↗' : '◫'}</span>{label}</button>)}</nav><div className="side-bottom"><div className="connected"><i /> Network connected</div><div className="profile"><b>{session.displayName?.[0] || 'U'}</b><span>{session.displayName}<small>{roleTitle}</small></span><button title="Sign out" onClick={logout}>↗</button></div></div></aside>
    <main className="main"><header className="topbar"><div className="topbar-identity"><button type="button" className="topbar-home" aria-label="LifeQ home" onClick={() => navigate('overview')}><MedicalMark compact /><span>LifeQ</span></button><i>/</i><span>{roleTitle}</span></div><div className="topbar-actions">{page !== 'overview' && <button type="button" className="topbar-action" onClick={goBack}><span aria-hidden="true">←</span> Back</button>}<button type="button" className="topbar-action logout-action" onClick={logout}><span aria-hidden="true">↗</span> Log out</button><span className="sync"><i /> SYNCED <time>{clock}</time></span></div></header><div className={`content ${session.role === 'er' ? 'er-mode' : ''}`}>
      {message && <Banner kind="success" message={message} close={() => setMessage('')} />}{error && <Banner kind="error" message={error} close={() => setError('')} />}
      {page === 'assessment' && <><Back title={heading} onClick={goBack} /><form className="assessment" onSubmit={saveAssessment}><div className="form-stack">
        <section className="surface"><Eyebrow>01 / INJURIES</Eyebrow><h2>Injury assessment</h2><p className="muted">Search and select all that apply.</p><input className="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search injuries…" /><div className="injury-list">{INJURIES_BY_TRIAGE[caseCode].filter((item) => item.toLowerCase().includes(search.toLowerCase())).map((item) => <label key={item} className={patient.injuries.includes(item) ? 'checked' : ''}><input type="checkbox" checked={patient.injuries.includes(item)} onChange={(event) => setPatient({ ...patient, injuries: event.target.checked ? [...patient.injuries, item] : patient.injuries.filter((injury) => injury !== item) })} />{item}</label>)}</div><Field label="Additional notes" value={patient.description} onChange={(value) => setPatient({ ...patient, description: value })} multiline placeholder="Relevant details for the receiving team (optional)" /></section>
        <section className="surface"><Eyebrow>02 / VITALS</Eyebrow><h2>Patient observations</h2><div className="fields three"><Field label="Blood pressure (mmHg)" value={patient.vitals.bloodPressure} onChange={(value) => setPatient({ ...patient, vitals: { ...patient.vitals, bloodPressure: value } })} placeholder="e.g. 120/80" /><Field label="Pulse / heart rate (bpm)" type="number" value={patient.vitals.pulse} onChange={(value) => setPatient({ ...patient, vitals: { ...patient.vitals, pulse: value } })} /><Field label="O₂ saturation (%)" type="number" value={patient.vitals.oxygen} onChange={(value) => setPatient({ ...patient, vitals: { ...patient.vitals, oxygen: value } })} /><Field label="Temperature (°C)" type="number" value={patient.vitals.temperature} onChange={(value) => setPatient({ ...patient, vitals: { ...patient.vitals, temperature: value } })} /></div></section>
        <section className="surface"><Eyebrow>03 / PATIENT</Eyebrow><h2>Patient details</h2><div className="fields"><Field label="Name" value={patient.name} onChange={(value) => setPatient({ ...patient, name: value })} placeholder="Unknown if not known" /><Field label="Age" type="number" value={patient.age} onChange={(value) => setPatient({ ...patient, age: value })} placeholder="Unknown if not known" /></div><label className="field">Gender<select value={patient.gender} onChange={(event) => setPatient({ ...patient, gender: event.target.value })}><option value="">Select if known</option><option>Female</option><option>Male</option><option>Other</option><option>Unknown</option></select></label><Field label="Expected arrival (24-hour time)" type="time" value={patient.arrivalTime} onChange={(value) => setPatient({ ...patient, arrivalTime: value })} /></section>
        <div className="actions"><button className="secondary" type="button" onClick={() => navigate('overview')}>Cancel</button><button className="primary" disabled={busy}>{busy ? 'Saving…' : 'Save and choose hospital'} <span>→</span></button></div>
      </div><aside className="summary"><span className={`code ${colorOf(caseCode)}`}>{caseCode}</span><h3>Assessment summary</h3><p>Selected injuries</p>{patient.injuries.length ? patient.injuries.map((item) => <span className="tag" key={item}>{item}</span>) : <span className="muted">None selected yet</span>}</aside></form></>}
      {page === 'routing' && <><Back title={heading} onClick={goBack} /><p className="muted">Showing availability for {patient?.triage} ({colorOf(patient?.triage)} code) only.</p><div className="hospital-grid">{hospitals.filter((item) => item.active !== false).map((item) => {
        const availableBeds = Number(item.bedsByCode?.[colorOf(patient?.triage)] || 0)
        const color = colorOf(patient?.triage)
        return <article className="hospital-card" key={item._id}><div className="hospital-top"><b>+</b><span><i /> RECEIVING</span></div><h2>{item.name}</h2><p>{item.location || 'Location not provided'}</p><div className={`beds ${color}`}><strong>{availableBeds}</strong><span>{color}-code beds available</span></div><button className="primary full" disabled={availableBeds < 1} onClick={() => routePatient(item._id)}>{availableBeds > 0 ? 'Request admission →' : 'No beds available'}</button></article>
      })}{!hospitals.length && <Empty title="No hospitals registered" detail="Ask an administrator to add a receiving hospital." />}</div></>}
      {page.startsWith('review:') && <Review patient={patients.find((item) => item._id === page.slice(7))} declining={declining} setDeclining={setDeclining} declineNote={declineNote} setDeclineNote={setDeclineNote} decide={decide} back={() => navigate('overview')} />}
      {page === 'admin' && session.role === 'admin' && <Admin tab={adminTab} setTab={setAdminTab} users={users} hospitals={hospitals} token={session.token} refresh={refresh} setError={setError} setMessage={setMessage} />}
      {page === 'admin' && session.role === 'admin' && <PasswordResetPanel users={users} token={session.token} refresh={refresh} setError={setError} setMessage={setMessage} />}
      {page === 'declines' && session.role === 'admin' && <DeclinesPanel patients={patients} />}
      {page === 'transfers' && session.role === 'admin' && <TransfersPanel patients={patients} />}
      {page === 'overview' && <><div className="page-head"><div><Eyebrow>LIVE OPERATIONS</Eyebrow><h1>{heading}</h1></div><span className="live"><i /> LIVE UPDATES</span></div><div className="stats"><Stat label="Awaiting decision" value={pending.length} detail="Requires hospital review" tone="amber" /><Stat label="Accepted for transfer" value={accepted.length} detail="En route to emergency care" tone="green" /><Stat label="Hospitals online" value={hospitals.filter((item) => item.active !== false).length} detail={`${hospitals.reduce((sum, item) => sum + Number(item.vacantBeds || 0), 0)} vacant beds network-wide`} tone="blue" /></div>
        {session.role === 'ambulance' && <section className="work-section"><div className="section-head"><div><Eyebrow>NEW CASE</Eyebrow><h2>Start patient assessment</h2></div><span className="muted">Triage and route a patient</span></div><div className="triage-grid">{CODES.map((item) => <button key={item.name} className={`triage ${item.color}`} onClick={() => { setCaseCode(item.name); setPatient({ name: '', age: '', gender: '', injuries: [], description: '', arrivalTime: '', vitals: { bloodPressure: '', pulse: '', oxygen: '', temperature: '' } }); setPage('confirm') }}><i /><strong>{item.name}</strong><small>{item.note}</small><span>→</span></button>)}</div></section>}
        <section className="work-section"><div className="section-head"><div><Eyebrow>{session.role === 'hospital' ? 'REVIEW QUEUE' : 'PATIENT TRACKER'}</Eyebrow><h2>{session.role === 'hospital' ? 'Requests awaiting review' : session.role === 'er' ? 'Accepted arrivals' : 'Recent patient activity'}</h2></div><span className="muted">{currentPatients.length} records</span></div><PatientTable patients={currentPatients} mode={session.role} onReview={(id) => navigate(`review:${id}`)} onRoute={(record) => { setPatient(record); setPage('routing') }} /></section></>}
      {page === 'confirm' && <><Back title="Confirm triage category" onClick={() => setPage('overview')} /><div className="confirm-card"><span className={`code ${colorOf(caseCode)}`}>{caseCode}</span><h2>Continue with this triage category?</h2><p>Confirm to enter the patient's assessment, injuries, and vital signs.</p><div className="actions"><button className="secondary" onClick={() => { setCaseCode(''); setPage('overview') }}>Cancel</button><button className="primary" onClick={() => setPage('assessment')}>Confirm and continue →</button></div></div></>}
    </div>{page === 'overview' && session.role === 'hospital' && <div className="content hospital-admissions-content"><HospitalAdmissions patients={hospitalAdmissions} onMoveWard={movePatientsToWard} onDischarge={dischargePatients} /></div>}</main>
    <LoadingOverlay active={busy} label={loadingLabel} />
  </div>
}

function Login({ role, setRole, credentials, setCredentials, login, busy, error, databaseStatus }) {
  const statusText = { checking: 'Checking MongoDB connection…', connected: 'MongoDB connected', offline: 'Database unavailable' }[databaseStatus]
  return <main className="login-screen"><div className="login-brand"><MedicalMark /><span>LifeQ<small>EMERGENCY NETWORK</small></span></div><div className="login-layout"><section className="login-intro"><Eyebrow>CONNECTED EMERGENCY CARE</Eyebrow><h1>Every minute.<br /><em>One clear picture.</em></h1><p>A shared view of the road, the receiving hospital, and the emergency room.</p><div className={`network ${databaseStatus}`}><i /> {statusText} <span>·</span> Secure sign-in</div></section><section className="login-panel"><Eyebrow>SIGN IN TO YOUR WORKSPACE</Eyebrow><h2>Welcome back</h2><div className="role-tabs">{[['ambulance', 'Ambulance'], ['hospital', 'Hospital'], ['er', 'ER display']].map(([key, text]) => <button key={key} className={role === key ? 'selected' : ''} onClick={() => setRole(key)}>{text}</button>)}</div><form onSubmit={login}><Field label="Login ID" value={credentials.username} onChange={(value) => setCredentials({ ...credentials, username: value })} placeholder="Enter your login ID" /><Field label="Password" value={credentials.password} onChange={(value) => setCredentials({ ...credentials, password: value })} type="password" placeholder="Enter your password" />{error && <p className="error-text">{error}</p>}<button disabled={busy} className="primary full">{busy ? 'Signing in…' : 'Sign in'} →</button></form><button className="admin-entry" onClick={() => setRole('admin')}>Administrator access <span>↗</span></button></section></div><footer><span>LifeQ · Emergency coordination</span><span>Authorized personnel only</span></footer></main>
}

function MedicalMark({ compact = false }) {
  return <span className={`medical-mark ${compact ? 'compact' : ''}`} aria-hidden="true"><svg className="medical-mark-svg" viewBox="0 0 48 48"><path className="medical-mark-shield" d="M24 4.5 40 10v11.2c0 10.1-6.2 17.4-16 22.3C14.2 38.6 8 31.3 8 21.2V10L24 4.5Z" /><path className="medical-mark-signal" pathLength="100" d="M11.5 24h7l4-8 6 16 5-9h3.5" /></svg></span>
}

function LoadingOverlay({ active, label }) {
  if (!active) return null
  return <div className="loading-overlay" role="status" aria-live="polite"><div className="loading-card"><div className="loading-emblem"><span className="loading-orbit" aria-hidden="true" /><MedicalMark /></div><div className="loading-copy"><strong>{label || 'Working…'}</strong><span>Syncing securely with the emergency network</span></div><div className="loading-pulse" aria-hidden="true"><i /><i /><i /></div></div></div>
}

function Eyebrow({ children }) { return <p className="eyebrow">{children}</p> }
function Back({ title, onClick }) { return <div className="back-head"><button onClick={onClick}>← Back</button><Eyebrow>PATIENT WORKFLOW</Eyebrow><h1>{title}</h1></div> }
function Banner({ kind, message, close }) { return <div className={`banner ${kind}`}>{message}<button onClick={close}>×</button></div> }
function Field({ label, value, onChange, type = 'text', placeholder, multiline = false, step }) { return <label className="field">{label}{multiline ? <textarea rows="3" value={value || ''} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} /> : <input type={type} min={type === 'number' ? 0 : undefined} step={step} minLength={label === 'Temporary password' ? 8 : undefined} value={value ?? ''} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />}{label === 'Temporary password' && <small className="field-hint">Use at least 8 characters.</small>}</label> }
function Stat({ label, value, detail, tone }) { return <article className={`stat ${tone}`}><div>{label}<i /></div><strong>{value}</strong><p>{detail}</p></article> }
function colorOf(code) { return CODES.find((item) => item.name === code)?.color || 'black' }
function Empty({ title, detail }) { return <div className="empty"><span>—</span><h2>{title}</h2><p>{detail}</p></div> }

function PatientTable({ patients, mode, onReview, onRoute }) {
  if (!patients.length) return <div className="empty-row"><strong>Nothing to show right now</strong><p>New patient activity will appear here.</p></div>
  if (mode === 'er') return <div className="er-arrivals">{patients.map((item) => <article className="er-arrival" key={item._id}><div className="er-arrival-head"><div><Eyebrow>ACCEPTED ARRIVAL</Eyebrow><h2>{item.name || 'Unknown patient'}</h2><p>{item.age == null ? 'Age unknown' : `${item.age} years`} · {item.gender || 'Gender unknown'}</p></div><div className="er-arrival-status"><span className={`pill ${colorOf(item.triage)}`}>{item.triage}</span><strong>{item.arrivalTime || 'Not provided'}</strong><small>Arrival time · 24-hour</small></div></div><div className="er-vitals"><div><span>Blood pressure</span><strong>{item.vitals?.bloodPressure || '—'}</strong><small>mmHg</small></div><div><span>Heart rate</span><strong>{item.vitals?.pulse ?? '—'}</strong><small>bpm</small></div><div><span>O₂ saturation</span><strong>{item.vitals?.oxygen ?? '—'}</strong><small>%</small></div><div><span>Temperature</span><strong>{item.vitals?.temperature ?? '—'}</strong><small>°C</small></div></div><div className="er-details"><div><span>Injuries</span><strong>{item.injuries?.join(', ') || 'Not specified'}</strong></div><div><span>Receiving hospital</span><strong>{item.hospital?.name || 'Not assigned'}</strong></div><div><span>Ambulance</span><strong>{item.ambulance?.displayName || 'Not specified'}</strong></div></div>{item.description && <div className="er-notes"><span>Additional notes</span><p>{item.description}</p></div>}</article>)}</div>
  return <div className="table-wrap"><table><thead><tr><th>Patient</th><th>Triage</th><th>Injuries</th><th>Hospital</th>{mode === 'er' && <th>ETA</th>}<th>Status</th>{mode === 'hospital' && <th />}</tr></thead><tbody>{patients.map((item) => <tr key={item._id} className={mode === 'hospital' && item.status === 'pending' ? `incoming-request ${colorOf(item.triage)}` : ''} aria-label={mode === 'hospital' && item.status === 'pending' ? `New ${item.triage} patient request` : undefined}><td><strong>{item.name || 'Unknown'}</strong><small>{item.age == null ? 'Age unknown' : `${item.age} years`} · {item.gender || 'Gender unknown'}</small></td><td><span className={`pill ${colorOf(item.triage)}`}>{item.triage}</span></td><td>{item.injuries?.slice(0, 2).join(', ') || 'Not specified'}{item.injuries?.length > 2 ? ` +${item.injuries.length - 2}` : ''}</td><td>{item.hospital?.name || 'Not assigned'}</td>{mode === 'er' && <td className="eta-cell">{item.arrivalTime || 'Not provided'}</td>}<td><span className={`status ${item.status}`}>{item.status}</span>{item.declineNote && <small className="decline-note">Reason: {item.declineNote}</small>}{mode === 'ambulance' && item.status === 'declined' && <button className="table-action reroute" onClick={() => onRoute(item)}>Choose another hospital →</button>}</td>{mode === 'hospital' && <td><button className="table-action" onClick={() => onReview(item._id)}>Review →</button></td>}</tr>)}</tbody></table></div>
}

const HOSPITAL_WARDS = ['Emergency', 'ICU', 'Surgery', 'General', 'Observation', 'Pediatrics']

function HospitalAdmissions({ patients, onMoveWard, onDischarge }) {
  const [selectedIds, setSelectedIds] = useState([])
  const [targetWard, setTargetWard] = useState('General')
  const allSelected = patients.length > 0 && patients.every((patient) => selectedIds.includes(patient._id))

  const togglePatient = (patientId) => setSelectedIds((current) => current.includes(patientId) ? current.filter((id) => id !== patientId) : [...current, patientId])
  const toggleAll = () => setSelectedIds(allSelected ? [] : patients.map((patient) => patient._id))
  const moveSelected = async () => {
    if (!selectedIds.length) return
    await onMoveWard(selectedIds, targetWard)
    setSelectedIds([])
  }
  const dischargeSelected = async () => {
    if (!selectedIds.length) return
    await onDischarge(selectedIds)
    setSelectedIds([])
  }

  return <section className="work-section hospital-admissions"><div className="section-head"><div><Eyebrow>ADMITTED PATIENTS</Eyebrow><h2>Ward management</h2></div><span className="muted">{patients.length} in care</span></div>{!patients.length ? <div className="empty-row"><strong>No admitted patients</strong><p>Patients appear here after hospital acceptance.</p></div> : <><div className="admissions-toolbar"><span>{selectedIds.length} selected</span><label className="field">Destination ward<select value={targetWard} onChange={(event) => setTargetWard(event.target.value)}>{HOSPITAL_WARDS.map((ward) => <option value={ward} key={ward}>{ward}</option>)}</select></label><button className="secondary" disabled={!selectedIds.length} onClick={moveSelected}>Move selected</button><button className="danger" disabled={!selectedIds.length} onClick={dischargeSelected}>Discharge selected</button></div><div className="table-wrap"><table><thead><tr><th><input type="checkbox" aria-label="Select all admitted patients" checked={allSelected} onChange={toggleAll} /></th><th>Patient</th><th>Triage</th><th>Injuries</th><th>Ward</th><th>Heart rate</th><th>Blood pressure</th></tr></thead><tbody>{patients.map((patient) => <tr key={patient._id}><td><input type="checkbox" aria-label={`Select ${patient.name || 'unknown patient'}`} checked={selectedIds.includes(patient._id)} onChange={() => togglePatient(patient._id)} /></td><td><strong>{patient.name || 'Unknown'}</strong><small>{patient.age == null ? 'Age unknown' : `${patient.age} years`} · {patient.gender || 'Gender unknown'}</small></td><td><span className={`pill ${colorOf(patient.triage)}`}>{patient.triage}</span></td><td>{patient.injuries?.join(', ') || 'Not specified'}</td><td><span className="ward-label">{patient.ward || 'Emergency'}</span></td><td>{patient.vitals?.pulse ?? '—'} bpm</td><td>{patient.vitals?.bloodPressure || '—'}</td></tr>)}</tbody></table></div></>}</section>
}

function Review({ patient, declining, setDeclining, declineNote, setDeclineNote, decide, back }) {
  if (!patient) return <Empty title="Request not found" detail="This request may already have been reviewed." />
  return <><Back title="Review admission request" onClick={back} /><div className="review-grid"><section className="surface"><Eyebrow>INCOMING PATIENT</Eyebrow><div className="review-title"><div><h2>{patient.name || 'Unknown patient'}</h2><p>{patient.age == null ? 'Age unknown' : `${patient.age} years`} · {patient.gender || 'Gender unknown'}</p></div><span className={`pill ${colorOf(patient.triage)}`}>{patient.triage}</span></div><div className="details"><div><span>Injuries</span><strong>{patient.injuries?.join(', ') || 'Not specified'}</strong></div><div><span>Pulse</span><strong>{patient.vitals?.pulse || '—'} bpm</strong></div><div><span>O₂ saturation</span><strong>{patient.vitals?.oxygen || '—'}%</strong></div><div><span>Temperature</span><strong>{patient.vitals?.temperature || '—'} °C</strong></div><div><span>Ambulance</span><strong>{patient.ambulance?.name || 'Ambulance team'}</strong></div></div>{patient.description && <p className="patient-note">{patient.description}</p>}</section><section className="surface decision"><Eyebrow>HOSPITAL DECISION</Eyebrow><h2>Can your team receive this patient?</h2><p className="muted">The ambulance and ER display will be updated.</p>{declining === patient._id ? <><Field label="Reason for declining" value={declineNote} onChange={setDeclineNote} multiline placeholder="Explain why the patient cannot be received." /><button className="danger full" disabled={!declineNote.trim()} onClick={() => decide(patient._id, 'declined')}>Confirm decline</button><button className="secondary full" onClick={() => setDeclining('')}>Go back</button></> : <><button className="accept full" onClick={() => decide(patient._id, 'accepted')}>Accept patient →</button><button className="decline full" onClick={() => { setDeclining(patient._id); setDeclineNote('') }}>Decline with a reason</button></>}</section></div></>
}

function Admin({ tab, setTab, users, hospitals, token, refresh, setError, setMessage }) {
  const [account, setAccount] = useState({ displayName: '', username: '', password: '', role: 'ambulance', hospitalId: '' })
  const [hospital, setHospital] = useState({ name: '', location: '', bedsByCode: Object.fromEntries(BED_COLORS.map((color) => [color, ''])) })
  const [editingHospitalId, setEditingHospitalId] = useState('')
  const [busy, setBusy] = useState(false)
  const mutate = async (path, method, body) => {
    if (path === '/users' && method === 'POST') {
      const username = String(body?.username || '').trim().toLowerCase()
      const existing = users.find((user) => user.username.toLowerCase() === username)
      if (existing) {
        setError(`This login ID already belongs to ${existing.displayName} (${existing.role}). Use Account recovery to change its password, or choose another ID.`)
        return
      }
    }
    setBusy(true)
    setError('')
    try {
      const result = await api(path, token, { method, body: body ? JSON.stringify(body) : undefined })
      if (path === '/users' && method === 'POST') {
        setAccount({ displayName: '', username: '', password: '', role: 'ambulance', hospitalId: '' })
        setMessage(result.reactivated ? 'Access account reactivated.' : 'Access account created.')
      } else if (path === '/hospitals' && method === 'POST') {
        setHospital({ name: '', location: '', bedsByCode: Object.fromEntries(BED_COLORS.map((color) => [color, ''])) })
        setMessage('Hospital registered.')
      } else if (method === 'PATCH' && path.endsWith('/beds')) {
        setEditingHospitalId('')
        setHospital({ name: '', location: '', bedsByCode: Object.fromEntries(BED_COLORS.map((color) => [color, ''])) })
        setMessage('Available beds updated.')
      } else {
        setMessage(method === 'DELETE' ? 'Record removed.' : 'Changes saved.')
      }
      await refresh(true)
    }
    catch (issue) { setError(issue.message) }
    finally { setBusy(false) }
  }
  const bedsAreValid = BED_COLORS.every((color) => hospital.bedsByCode[color] !== '' && Number.isInteger(Number(hospital.bedsByCode[color])) && Number(hospital.bedsByCode[color]) >= 0)
  const editHospitalBeds = (item) => {
    setEditingHospitalId(item._id)
    setHospital({
      name: item.name,
      location: item.location || '',
      bedsByCode: Object.fromEntries(BED_COLORS.map((color) => [color, String(item.bedsByCode?.[color] ?? 0)])),
    })
  }
  return <>
    <div className="page-head"><div><Eyebrow>NETWORK CONTROL</Eyebrow><h1>Administration</h1></div><span className="admin-badge">ADMINISTRATOR</span></div>
    <div className="admin-tabs"><button className={tab === 'accounts' ? 'selected' : ''} onClick={() => setTab('accounts')}>Accounts <span>{users.length}</span></button><button className={tab === 'hospitals' ? 'selected' : ''} onClick={() => setTab('hospitals')}>Hospitals <span>{hospitals.length}</span></button></div>
    <div className="admin-grid">
      <section className="surface">
        <Eyebrow>{tab === 'accounts' ? 'REGISTERED USERS' : 'RECEIVING LOCATIONS'}</Eyebrow><h2>{tab === 'accounts' ? 'Access accounts' : 'Hospital network'}</h2>
        <div className="records">{(tab === 'accounts' ? users : hospitals).map((item) => {
          const bedsByCode = item.bedsByCode || {}
          const summary = tab === 'accounts'
            ? `${item.username} · ${item.role}${item.hospital?.name ? ` · ${item.hospital.name}` : ''}`
            : `${item.location || 'Location not provided'} · Red ${bedsByCode.red ?? 0}, Yellow ${bedsByCode.yellow ?? 0}, Green ${bedsByCode.green ?? 0}, Black ${bedsByCode.black ?? 0}`
          return <div className="record" key={item._id}><b>{tab === 'accounts' ? item.displayName?.[0] || 'U' : '+'}</b><span><strong>{tab === 'accounts' ? item.displayName : item.name}</strong><small>{summary}</small></span>{tab === 'hospitals' && <button className="record-edit" onClick={() => editHospitalBeds(item)}>Edit beds</button>}<button onClick={() => mutate(`/${tab === 'accounts' ? 'users' : 'hospitals'}/${item._id}`, 'DELETE')}>Remove</button></div>
        })}</div>
      </section>
      <section className="surface admin-form">
        <Eyebrow>{tab === 'accounts' ? 'CREATE ACCOUNT' : editingHospitalId ? 'UPDATE AVAILABILITY' : 'REGISTER LOCATION'}</Eyebrow><h2>{tab === 'accounts' ? 'Add access' : editingHospitalId ? `Edit ${hospital.name} beds` : 'Add hospital'}</h2>
        {tab === 'accounts' ? <>
          <Field label="Display name" value={account.displayName} onChange={(value) => setAccount({ ...account, displayName: value })} />
          <Field label="Login ID" value={account.username} onChange={(value) => setAccount({ ...account, username: value })} />
          <Field label="Temporary password" value={account.password} onChange={(value) => setAccount({ ...account, password: value })} type="password" />
          <label className="field">Workspace<select value={account.role} onChange={(event) => setAccount({ ...account, role: event.target.value })}><option value="ambulance">Ambulance</option><option value="hospital">Hospital management</option><option value="er">ER display</option><option value="admin">Administrator</option></select></label>
          {['hospital', 'er'].includes(account.role) && <label className="field">{account.role === 'er' ? 'ER hospital' : 'Hospital'}<select required value={account.hospitalId} onChange={(event) => setAccount({ ...account, hospitalId: event.target.value })}><option value="">Select hospital</option>{hospitals.map((item) => <option key={item._id} value={item._id}>{item.name}</option>)}</select></label>}
          <button className="primary full" disabled={busy || !account.displayName || !account.username || account.password.length < 8} onClick={() => mutate('/users', 'POST', account)}>Create account →</button>
        </> : <>
          {!editingHospitalId && <>
            <Field label="Hospital name" value={hospital.name} onChange={(value) => setHospital({ ...hospital, name: value })} />
            <Field label="Location" value={hospital.location} onChange={(value) => setHospital({ ...hospital, location: value })} />
          </>}
          <p className="muted">{editingHospitalId ? 'Set the currently available beds for each code.' : 'Enter the available beds for each triage code.'}</p>
          <div className="bed-count-fields">{BED_COLORS.map((color) => <Field key={color} label={`${color[0].toUpperCase()}${color.slice(1)}-code beds`} type="number" step="1" value={hospital.bedsByCode[color]} onChange={(value) => setHospital({ ...hospital, bedsByCode: { ...hospital.bedsByCode, [color]: value } })} />)}</div>
          <button className="primary full" disabled={busy || (!editingHospitalId && !hospital.name) || !bedsAreValid} onClick={() => mutate(editingHospitalId ? `/hospitals/${editingHospitalId}/beds` : '/hospitals', editingHospitalId ? 'PATCH' : 'POST', { bedsByCode: Object.fromEntries(BED_COLORS.map((color) => [color, Number(hospital.bedsByCode[color])])), ...(editingHospitalId ? {} : { name: hospital.name, location: hospital.location }) })}>{editingHospitalId ? 'Save bed counts' : 'Add hospital →'}</button>
          {editingHospitalId && <button className="secondary full" disabled={busy} onClick={() => { setEditingHospitalId(''); setHospital({ name: '', location: '', bedsByCode: Object.fromEntries(BED_COLORS.map((color) => [color, ''])) }) }}>Cancel edit</button>}
        </>}
      </section>
    </div>
  </>
}

function TransfersPanel({ patients }) {
  const [search, setSearch] = useState('')
  const [hospitalFilter, setHospitalFilter] = useState('all')
  const [sortBy, setSortBy] = useState('date')
  const [sortDirection, setSortDirection] = useState('desc')
  const events = patients.flatMap((patient) => (patient.wardHistory || []).map((transfer, index) => ({
    ...transfer,
    id: `${patient._id}-${index}`,
    patient,
    hospitalName: transfer.hospital?.name || patient.hospital?.name || 'Unknown hospital',
    movedByName: transfer.movedBy?.displayName || 'Unknown staff',
  })))
  const hospitals = [...new Set(events.map((event) => event.hospitalName))].sort((left, right) => left.localeCompare(right))
  const query = search.trim().toLowerCase()
  const visibleEvents = events
    .filter((event) => hospitalFilter === 'all' || event.hospitalName === hospitalFilter)
    .filter((event) => !query || [event.patient.name, event.hospitalName, event.fromWard, event.toWard, event.movedByName].some((value) => String(value || '').toLowerCase().includes(query)))
    .sort((left, right) => {
      let comparison = 0
      if (sortBy === 'date') comparison = Date.parse(left.movedAt || 0) - Date.parse(right.movedAt || 0)
      if (sortBy === 'hospital') comparison = left.hospitalName.localeCompare(right.hospitalName)
      if (sortBy === 'patient') comparison = String(left.patient.name || 'Unknown').localeCompare(String(right.patient.name || 'Unknown'))
      if (sortBy === 'from') comparison = left.fromWard.localeCompare(right.fromWard)
      if (sortBy === 'to') comparison = left.toWard.localeCompare(right.toWard)
      if (sortBy === 'staff') comparison = left.movedByName.localeCompare(right.movedByName)
      return sortDirection === 'asc' ? comparison : -comparison
    })

  return <><div className="page-head"><div><Eyebrow>NETWORK AUDIT</Eyebrow><h1>Ward transfers</h1></div><span className="count-label">{events.length} transfer records</span></div><div className="decline-controls"><label className="field">Search<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Patient, hospital, ward, or staff" /></label><label className="field">Hospital<select value={hospitalFilter} onChange={(event) => setHospitalFilter(event.target.value)}><option value="all">All hospitals</option>{hospitals.map((hospital) => <option value={hospital} key={hospital}>{hospital}</option>)}</select></label><label className="field">Sort by<select value={sortBy} onChange={(event) => setSortBy(event.target.value)}><option value="date">Transfer date</option><option value="hospital">Hospital</option><option value="patient">Patient name</option><option value="from">Source ward</option><option value="to">Destination ward</option><option value="staff">Moved by</option></select></label><label className="field">Order<select value={sortDirection} onChange={(event) => setSortDirection(event.target.value)}><option value="desc">Descending</option><option value="asc">Ascending</option></select></label></div>{visibleEvents.length ? <div className="table-wrap"><table><thead><tr><th>Patient</th><th>Hospital</th><th>From ward</th><th>To ward</th><th>Moved by</th><th>Date and time</th></tr></thead><tbody>{visibleEvents.map((event) => <tr key={event.id}><td><strong>{event.patient.name || 'Unknown'}</strong><small>{event.patient.age == null ? 'Age unknown' : `${event.patient.age} years`} · {event.patient.gender || 'Gender unknown'}</small></td><td>{event.hospitalName}</td><td><span className="ward-label">{event.fromWard}</span></td><td><span className="ward-label">{event.toWard}</span></td><td>{event.movedByName}</td><td>{formatDeclineDate(event.movedAt)}</td></tr>)}</tbody></table></div> : <Empty title={events.length ? 'No matching transfers' : 'No ward transfers recorded'} detail={events.length ? 'Try another search or hospital filter.' : 'Hospital ward changes will be recorded here.'} />}</>
}

function DeclinesPanel({ patients }) {
  const [search, setSearch] = useState('')
  const [triageFilter, setTriageFilter] = useState('all')
  const [sortBy, setSortBy] = useState('date')
  const [sortDirection, setSortDirection] = useState('desc')

  const declineEvents = patients.flatMap((patient) => {
    const history = patient.declineHistory?.length
      ? patient.declineHistory
      : patient.status === 'declined' && patient.declineNote
        ? [{ hospital: patient.hospital, note: patient.declineNote, declinedAt: patient.updatedAt || patient.createdAt }]
        : []
    return history.map((event, index) => ({
      ...event,
      id: `${patient._id}-${index}`,
      patient,
      hospitalName: event.hospital?.name || patient.hospital?.name || 'Unknown hospital',
    }))
  })

  const query = search.trim().toLowerCase()
  const visibleEvents = declineEvents
    .filter((event) => triageFilter === 'all' || event.patient.triage === triageFilter)
    .filter((event) => !query || [
      event.patient.name,
      event.hospitalName,
      event.note,
      event.patient.ambulance?.displayName,
      ...(event.patient.injuries || []),
    ].some((value) => String(value || '').toLowerCase().includes(query)))
    .sort((left, right) => {
      let comparison = 0
      if (sortBy === 'date') comparison = Date.parse(left.declinedAt || 0) - Date.parse(right.declinedAt || 0)
      if (sortBy === 'triage') {
        const order = { Immediate: 0, Delayed: 1, Minor: 2, Deceased: 3 }
        comparison = (order[left.patient.triage] ?? 4) - (order[right.patient.triage] ?? 4)
      }
      if (sortBy === 'hospital') comparison = left.hospitalName.localeCompare(right.hospitalName)
      if (sortBy === 'patient') comparison = String(left.patient.name || 'Unknown').localeCompare(String(right.patient.name || 'Unknown'))
      return sortDirection === 'asc' ? comparison : -comparison
    })

  return <><div className="page-head"><div><Eyebrow>HOSPITAL DECISION HISTORY</Eyebrow><h1>Declined patients</h1></div><span className="count-label">{declineEvents.length} decline events</span></div><div className="decline-controls"><label className="field">Search<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Patient, hospital, injury, or reason" /></label><label className="field">Triage<select value={triageFilter} onChange={(event) => setTriageFilter(event.target.value)}><option value="all">All triage codes</option>{CODES.map((item) => <option value={item.name} key={item.name}>{item.name}</option>)}</select></label><label className="field">Sort by<select value={sortBy} onChange={(event) => setSortBy(event.target.value)}><option value="date">Decline date</option><option value="triage">Triage priority</option><option value="hospital">Hospital</option><option value="patient">Patient name</option></select></label><label className="field">Order<select value={sortDirection} onChange={(event) => setSortDirection(event.target.value)}><option value="desc">Descending</option><option value="asc">Ascending</option></select></label></div>{visibleEvents.length ? <div className="table-wrap"><table><thead><tr><th>Patient</th><th>Triage</th><th>Injuries</th><th>Declined by</th><th>Reason</th><th>Date and time</th></tr></thead><tbody>{visibleEvents.map((event) => <tr key={event.id}><td><strong>{event.patient.name || 'Unknown'}</strong><small>{event.patient.age == null ? 'Age unknown' : `${event.patient.age} years`} · {event.patient.gender || 'Gender unknown'}</small></td><td><span className={`pill ${colorOf(event.patient.triage)}`}>{event.patient.triage}</span></td><td>{event.patient.injuries?.join(', ') || 'Not specified'}</td><td>{event.hospitalName}</td><td className="decline-reason-cell">{event.note || 'No reason recorded'}</td><td>{formatDeclineDate(event.declinedAt)}</td></tr>)}</tbody></table></div> : <Empty title={declineEvents.length ? 'No matching declines' : 'No declines recorded'} detail={declineEvents.length ? 'Try changing the search or triage filter.' : 'Hospital decline decisions will appear here.'} />}</>
}

function formatDeclineDate(value) {
  if (!value) return 'Unknown date'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Unknown date'
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short', hour12: false }).format(date)
}

function PasswordResetPanel({ users, token, refresh, setError, setMessage }) {
  const [userId, setUserId] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)

  const resetPassword = async (event) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await api(`/users/${userId}/password`, token, { method: 'PATCH', body: JSON.stringify({ password }) })
      setPassword('')
      setMessage('Account password updated.')
      await refresh(true)
    } catch (issue) {
      setError(issue.message)
    } finally {
      setBusy(false)
    }
  }

  return <section className="surface password-reset"><Eyebrow>ACCOUNT RECOVERY</Eyebrow><h2>Reset an account password</h2><p className="muted">The new password replaces the old one and must be at least 8 characters.</p><form className="reset-form" onSubmit={resetPassword}><label className="field">Account<select required value={userId} onChange={(event) => setUserId(event.target.value)}><option value="">Select an account</option>{users.map((user) => <option key={user._id} value={user._id}>{user.displayName} · {user.username} · {user.role}</option>)}</select></label><label className="field">New password<input required minLength={8} type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label><button className="primary" disabled={busy || !userId || password.length < 8}>{busy ? 'Updating…' : 'Set password'}</button></form></section>
}

export default App
