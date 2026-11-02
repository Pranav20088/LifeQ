const crypto = require('node:crypto')
const { promisify } = require('node:util')
const express = require('express')
const cors = require('cors')
const mongoose = require('mongoose')
require('dotenv').config()

const app = express()
const scrypt = promisify(crypto.scrypt)
const PORT = process.env.PORT || 5000
const JWT_SECRET = process.env.JWT_SECRET
const HOSPITAL_WARDS = ['Emergency', 'ICU', 'Surgery', 'General', 'Observation', 'Pediatrics']
const BED_COLORS = ['red', 'yellow', 'green', 'black']
const TRIAGE_COLORS = { Immediate: 'red', Delayed: 'yellow', Minor: 'green', Deceased: 'black' }

app.use(cors({ origin: process.env.CORS_ORIGIN || 'http://localhost:5173' }))
app.use(express.json({ limit: '1mb' }))

const userSchema = new mongoose.Schema({
  displayName: { type: String, required: true, trim: true },
  username: { type: String, required: true, unique: true, trim: true, lowercase: true },
  passwordHash: { type: String, required: true },
  role: { type: String, enum: ['ambulance', 'hospital', 'er', 'admin'], required: true },
  hospital: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', default: null },
  active: { type: Boolean, default: true },
}, { timestamps: true })
const hospitalSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  location: { type: String, trim: true, default: '' },
  vacantBeds: { type: Number, min: 0, required: true, default: 0 },
  bedsByCode: {
    red: { type: Number, min: 0, default: 0 },
    yellow: { type: Number, min: 0, default: 0 },
    green: { type: Number, min: 0, default: 0 },
    black: { type: Number, min: 0, default: 0 },
  },
  active: { type: Boolean, default: true },
}, { timestamps: true })
const patientSchema = new mongoose.Schema({
  name: { type: String, default: 'Unknown', trim: true },
  age: { type: Number, min: 0, default: null },
  gender: { type: String, default: '' },
  triage: { type: String, enum: ['Immediate', 'Delayed', 'Minor', 'Deceased'], required: true },
  injuries: { type: [String], default: [] },
  description: { type: String, maxlength: 3000, default: '' },
  vitals: {
    bloodPressure: { type: String, maxlength: 20, default: '' },
    pulse: { type: Number, min: 0, default: null },
    oxygen: { type: Number, min: 0, max: 100, default: null },
    temperature: { type: Number, min: 0, default: null },
  },
  ambulance: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  hospital: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', default: null },
  status: { type: String, enum: ['unrouted', 'pending', 'accepted', 'declined', 'discharged'], default: 'unrouted' },
  triageBedReleased: { type: Boolean, default: false },
  ward: { type: String, enum: HOSPITAL_WARDS, default: 'Emergency' },
  wardHistory: [{
    hospital: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true },
    fromWard: { type: String, enum: HOSPITAL_WARDS, required: true },
    toWard: { type: String, enum: HOSPITAL_WARDS, required: true },
    movedAt: { type: Date, default: Date.now },
    movedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  }],
  dischargedAt: { type: Date, default: null },
  declineNote: { type: String, default: '' },
  declineHistory: [{
    hospital: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true },
    note: { type: String, required: true, maxlength: 1000 },
    declinedAt: { type: Date, default: Date.now },
  }],
  arrivalTime: { type: String, default: '' },
  acceptedAt: { type: Date, default: null },
}, { timestamps: true })

const User = mongoose.model('User', userSchema)
const Hospital = mongoose.model('Hospital', hospitalSchema)
const Patient = mongoose.model('Patient', patientSchema)

function splitBedsEvenly(total) {
  const base = Math.floor(total / BED_COLORS.length)
  const remainder = total % BED_COLORS.length
  return Object.fromEntries(BED_COLORS.map((color, index) => [color, base + (index < remainder ? 1 : 0)]))
}
async function migrateHospitalBeds() {
  const legacyHospitals = await Hospital.collection.find({ bedsByCode: { $exists: false } }).toArray()
  for (const hospital of legacyHospitals) {
    const total = Number.isInteger(hospital.vacantBeds) && hospital.vacantBeds >= 0 ? hospital.vacantBeds : 0
    await Hospital.collection.updateOne(
      { _id: hospital._id, bedsByCode: { $exists: false } },
      { $set: { bedsByCode: splitBedsEvenly(total) } },
    )
  }
}
function bedCountTotal(bedsByCode) {
  return BED_COLORS.reduce((total, color) => total + bedsByCode[color], 0)
}
async function releaseTriageBed(patient) {
  await migrateHospitalBeds()
  const color = TRIAGE_COLORS[patient.triage]
  const hospital = await Hospital.findByIdAndUpdate(patient.hospital, {
    $inc: { [`bedsByCode.${color}`]: 1, vacantBeds: 1 },
  })
  if (!hospital) throw new Error('The patient’s hospital could not be found while releasing a bed.')
}

function passwordRecord(password, salt = crypto.randomBytes(16).toString('hex')) {
  return scrypt(password, salt, 64).then((derived) => `${salt}:${derived.toString('hex')}`)
}
async function verifyPassword(password, record) {
  const [salt, stored] = record.split(':')
  const actual = await scrypt(password, salt, 64)
  const expected = Buffer.from(stored, 'hex')
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual)
}
function issueToken(user) {
  const payload = Buffer.from(JSON.stringify({ sub: user.id, role: user.role, exp: Date.now() + 8 * 60 * 60 * 1000 })).toString('base64url')
  const signature = crypto.createHmac('sha256', JWT_SECRET).update(payload).digest('base64url')
  return `${payload}.${signature}`
}
function authenticate(req, res, next) {
  const [scheme, token] = (req.get('authorization') || '').split(' ')
  if (scheme !== 'Bearer' || !token) return res.status(401).json({ message: 'Sign in to continue.' })
  const [payload, signature] = token.split('.')
  const expected = crypto.createHmac('sha256', JWT_SECRET).update(payload || '').digest()
  let received
  try { received = Buffer.from(signature || '', 'base64url') } catch { return res.status(401).json({ message: 'Invalid session.' }) }
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) return res.status(401).json({ message: 'Invalid session.' })
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString())
    if (claims.exp < Date.now()) return res.status(401).json({ message: 'Your session has expired.' })
    req.auth = claims
    next()
  } catch { return res.status(401).json({ message: 'Invalid session.' }) }
}
function allow(...roles) {
  return (req, res, next) => roles.includes(req.auth.role) ? next() : res.status(403).json({ message: 'You do not have access to this action.' })
}
async function currentUser(req, res, next) {
  try {
    const user = await User.findById(req.auth.sub).populate('hospital')
    if (!user || !user.active || (['hospital', 'er'].includes(user.role) && !user.hospital?.active)) return res.status(401).json({ message: 'This account is no longer active or is not linked to an active hospital.' })
    req.user = user
    next()
  } catch (error) { next(error) }
}
app.use('/api', (req, res, next) => {
  if (req.path === '/auth/login' || req.path === '/health') return next()
  authenticate(req, res, (error) => error ? next(error) : currentUser(req, res, next))
})

app.post('/api/auth/login', async (req, res, next) => {
  try {
    const { username, password, role } = req.body
    if (!username || !password || !['ambulance', 'hospital', 'er', 'admin'].includes(role)) return res.status(400).json({ message: 'Enter a login ID, password, and workspace.' })
    const user = await User.findOne({ username: String(username).trim().toLowerCase(), active: true }).populate('hospital')
    if (!user || !await verifyPassword(String(password), user.passwordHash)) return res.status(401).json({ message: 'Login ID or password is incorrect.' })
    if (user.role !== role) {
      const workspace = { ambulance: 'Ambulance', hospital: 'Hospital', er: 'ER display', admin: 'Administrator' }[user.role]
      return res.status(403).json({ message: `This account is registered for ${workspace}. Select that workspace to sign in.` })
    }
    if (['hospital', 'er'].includes(user.role) && !user.hospital?.active) return res.status(401).json({ message: `This ${user.role === 'er' ? 'ER' : 'hospital'} account is not linked to an active hospital. Contact an administrator.` })
    res.json({ token: issueToken(user), userId: user.id, role: user.role, displayName: user.displayName, hospitalId: user.hospital?.id || null })
  } catch (error) { next(error) }
})

app.get('/api/hospitals', async (req, res, next) => {
  try {
    await migrateHospitalBeds()
    res.json(await Hospital.find({ active: true }).sort({ name: 1 }).lean())
  } catch (error) { next(error) }
})
app.post('/api/hospitals', allow('admin'), async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim()
    const bedsByCode = Object.fromEntries(BED_COLORS.map((color) => [color, Number(req.body.bedsByCode?.[color])]))
    if (!name || BED_COLORS.some((color) => !Number.isInteger(bedsByCode[color]) || bedsByCode[color] < 0)) {
      return res.status(400).json({ message: 'Hospital name and a valid non-negative bed count for each color code are required.' })
    }
    res.status(201).json(await Hospital.create({ name, location: req.body.location || '', bedsByCode, vacantBeds: bedCountTotal(bedsByCode) }))
  } catch (error) { next(error) }
})
app.patch('/api/hospitals/:id/beds', allow('admin'), async (req, res, next) => {
  try {
    const bedsByCode = Object.fromEntries(BED_COLORS.map((color) => [color, Number(req.body.bedsByCode?.[color])]))
    if (BED_COLORS.some((color) => !Number.isInteger(bedsByCode[color]) || bedsByCode[color] < 0)) {
      return res.status(400).json({ message: 'Enter a valid non-negative available bed count for each color code.' })
    }
    const hospital = await Hospital.findOneAndUpdate(
      { _id: req.params.id, active: true },
      { $set: { bedsByCode, vacantBeds: bedCountTotal(bedsByCode) } },
      { new: true },
    )
    if (!hospital) return res.status(404).json({ message: 'Active hospital not found.' })
    res.json(hospital)
  } catch (error) { next(error) }
})
app.delete('/api/hospitals/:id', allow('admin'), async (req, res, next) => {
  try {
    const hospital = await Hospital.findByIdAndUpdate(req.params.id, { active: false })
    if (!hospital) return res.status(404).json({ message: 'Hospital not found.' })
    res.json({ message: 'Hospital removed.' })
  } catch (error) { next(error) }
})

app.get('/api/users', allow('admin'), async (req, res, next) => {
  try { res.json(await User.find({ active: true }).select('-passwordHash').populate('hospital', 'name').sort({ displayName: 1 }).lean()) } catch (error) { next(error) }
})
app.post('/api/users', allow('admin'), async (req, res, next) => {
  try {
    const { displayName, username, password, role, hospitalId } = req.body
    if (!String(displayName || '').trim() || !String(username || '').trim() || String(password || '').length < 8 || !['ambulance', 'hospital', 'er', 'admin'].includes(role)) return res.status(400).json({ message: 'Enter a name, login ID, valid workspace, and password with at least 8 characters.' })
    const normalizedUsername = String(username).trim().toLowerCase()
    let hospital = null
    if (['hospital', 'er'].includes(role)) {
      hospital = await Hospital.findOne({ _id: hospitalId, active: true })
      if (!hospital) return res.status(400).json({ message: `Select an active hospital for this ${role === 'er' ? 'ER' : 'hospital'} account.` })
    }
    const passwordHash = await passwordRecord(String(password))
    const existing = await User.findOne({ username: normalizedUsername })
    if (existing?.active) {
      const workspace = { ambulance: 'Ambulance', hospital: 'Hospital', er: 'ER display', admin: 'Administrator' }[existing.role]
      return res.status(409).json({ message: `This login ID already belongs to an active ${workspace} account. Use a different ID or reset that account's password.` })
    }
    if (existing && existing.role !== role) {
      const workspace = { ambulance: 'Ambulance', hospital: 'Hospital', er: 'ER display', admin: 'Administrator' }[existing.role]
      return res.status(409).json({ message: `This ID is reserved by a removed ${workspace} account. Select the ${workspace} workspace to reactivate it, or use a different ID.` })
    }
    const user = existing || new User({ username: normalizedUsername })
    user.displayName = String(displayName).trim()
    user.passwordHash = passwordHash
    user.role = role
    user.hospital = hospital?._id || null
    user.active = true
    await user.save()
    res.status(existing ? 200 : 201).json({ id: user.id, displayName: user.displayName, username: user.username, role: user.role, reactivated: Boolean(existing) })
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ message: 'That login ID is already in use.' })
    next(error)
  }
})
app.delete('/api/users/:id', allow('admin'), async (req, res, next) => {
  try {
    if (req.params.id === req.user.id) return res.status(400).json({ message: 'You cannot remove your own administrator account.' })
    const user = await User.findByIdAndUpdate(req.params.id, { active: false })
    if (!user) return res.status(404).json({ message: 'Account not found.' })
    res.json({ message: 'Account removed.' })
  } catch (error) { next(error) }
})
app.patch('/api/users/:id/password', allow('admin'), async (req, res, next) => {
  try {
    const password = String(req.body.password || '')
    if (password.length < 8) return res.status(400).json({ message: 'Password must be at least 8 characters.' })
    const user = await User.findOne({ _id: req.params.id, active: true })
    if (!user) return res.status(404).json({ message: 'Active account not found.' })
    user.passwordHash = await passwordRecord(password)
    await user.save()
    res.json({ message: 'Password updated.' })
  } catch (error) { next(error) }
})

app.get('/api/patients', async (req, res, next) => {
  try {
    const filter = req.user.role === 'ambulance' ? { ambulance: req.user._id }
      : ['hospital', 'er'].includes(req.user.role) ? { hospital: req.user.hospital._id, ...(req.user.role === 'er' ? { status: 'accepted' } : {}) }
        : {}
    const patients = await Patient.find(filter).populate('ambulance', 'displayName').populate('hospital', 'name').populate('declineHistory.hospital', 'name').populate('wardHistory.hospital', 'name').populate('wardHistory.movedBy', 'displayName').sort({ updatedAt: -1 }).lean()
    res.json(patients)
  } catch (error) { next(error) }
})
app.post('/api/patients', allow('ambulance'), async (req, res, next) => {
  try {
    const { triage, injuries, vitals = {} } = req.body
    if (!['Immediate', 'Delayed', 'Minor', 'Deceased'].includes(triage)) return res.status(400).json({ message: 'Choose a valid triage category.' })
    const patient = await Patient.create({
      triage,
      name: String(req.body.name || '').trim() || 'Unknown',
      age: req.body.age === null || req.body.age === '' ? null : Number(req.body.age),
      gender: req.body.gender || '',
      injuries: Array.isArray(injuries) ? injuries.map((item) => String(item).slice(0, 100)) : [],
      description: String(req.body.description || '').slice(0, 3000),
      arrivalTime: /^([01]\d|2[0-3]):[0-5]\d$/.test(req.body.arrivalTime || '') ? req.body.arrivalTime : '',
      vitals: { bloodPressure: String(vitals.bloodPressure || '').trim().slice(0, 20), pulse: numberOrNull(vitals.pulse), oxygen: numberOrNull(vitals.oxygen), temperature: numberOrNull(vitals.temperature) },
      ambulance: req.user._id,
    })
    res.status(201).json(patient)
  } catch (error) { next(error) }
})
app.post('/api/patients/:id/route', allow('ambulance'), async (req, res, next) => {
  try {
    await migrateHospitalBeds()
    const patient = await Patient.findOne({ _id: req.params.id, ambulance: req.user._id, status: { $in: ['unrouted', 'declined'] } })
    if (!patient) return res.status(404).json({ message: 'Patient not found or no longer available for routing.' })
    const hospital = await Hospital.findOne({ _id: req.body.hospitalId, active: true })
    if (!hospital) return res.status(404).json({ message: 'Choose an active hospital.' })
    const color = TRIAGE_COLORS[patient.triage]
    if (hospital.bedsByCode[color] < 1) return res.status(409).json({ message: `This hospital has no vacant ${color}-code beds. Choose another hospital.` })
    patient.hospital = hospital._id
    patient.status = 'pending'
    patient.declineNote = ''
    await patient.save()
    res.json(patient)
  } catch (error) { next(error) }
})
app.patch('/api/patients/:id/decision', allow('hospital', 'admin'), async (req, res, next) => {
  try {
    const { decision, note = '' } = req.body
    if (!['accepted', 'declined'].includes(decision)) return res.status(400).json({ message: 'Choose accept or decline.' })
    if (decision === 'declined' && !String(note).trim()) return res.status(400).json({ message: 'A reason is required when declining a patient.' })
    const patient = await Patient.findOne({ _id: req.params.id, status: 'pending' })
    if (!patient) return res.status(404).json({ message: 'This request has already been reviewed or was not found.' })
    if (req.user.role === 'hospital' && String(patient.hospital) !== req.user.hospital.id) return res.status(403).json({ message: 'This request belongs to another hospital.' })
    if (decision === 'accepted') {
      await migrateHospitalBeds()
      const color = TRIAGE_COLORS[patient.triage]
      const bedPath = `bedsByCode.${color}`
      const available = await Hospital.findOneAndUpdate(
        { _id: patient.hospital, active: true, [bedPath]: { $gt: 0 } },
        { $inc: { [bedPath]: -1, vacantBeds: -1 } },
        { new: true },
      )
      if (!available) return res.status(409).json({ message: `No ${color}-code beds remain available at this hospital.` })
      try {
        const accepted = await Patient.findOneAndUpdate(
          { _id: req.params.id, status: 'pending', hospital: patient.hospital },
          { $set: { status: 'accepted', acceptedAt: new Date(), triageBedReleased: false, declineNote: '' } },
          { new: true },
        )
        if (!accepted) {
          await Hospital.findByIdAndUpdate(patient.hospital, { $inc: { [bedPath]: 1, vacantBeds: 1 } })
          return res.status(404).json({ message: 'This request has already been reviewed or was not found.' })
        }
        return res.json(accepted)
      } catch (error) {
        await Hospital.findByIdAndUpdate(patient.hospital, { $inc: { [bedPath]: 1, vacantBeds: 1 } })
        throw error
      }
    }
    const declineNote = String(note).trim().slice(0, 1000)
    const declined = await Patient.findOneAndUpdate(
      { _id: req.params.id, status: 'pending', hospital: patient.hospital },
      {
        $set: { status: 'declined', declineNote, acceptedAt: null },
        $push: { declineHistory: { hospital: patient.hospital, note: declineNote, declinedAt: new Date() } },
      },
      { new: true },
    )
    if (!declined) return res.status(404).json({ message: 'This request has already been reviewed or was not found.' })
    res.json(declined)
  } catch (error) { next(error) }
})
app.patch('/api/patients/:id/ward', allow('hospital', 'admin'), async (req, res, next) => {
  try {
    const ward = String(req.body.ward || '')
    if (!HOSPITAL_WARDS.includes(ward)) return res.status(400).json({ message: 'Select a valid ward.' })
    const filter = { _id: req.params.id, status: 'accepted' }
    if (req.user.role === 'hospital') filter.hospital = req.user.hospital._id
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const patient = await Patient.findOne(filter)
      if (!patient) return res.status(404).json({ message: 'Admitted patient not found in your hospital.' })
      if (patient.ward === ward) return res.json(patient)
      const released = patient.triageBedReleased === true
      const updated = await Patient.findOneAndUpdate(
        { ...filter, ward: patient.ward, triageBedReleased: released ? true : { $ne: true } },
        {
          $set: { ward, triageBedReleased: true },
          $push: { wardHistory: { hospital: patient.hospital, fromWard: patient.ward, toWard: ward, movedAt: new Date(), movedBy: req.user._id } },
        },
        { new: true },
      )
      if (updated) {
        if (!released) await releaseTriageBed(updated)
        return res.json(updated)
      }
    }
    return res.status(409).json({ message: 'The patient ward changed at the same time. Refresh and try again.' })
  } catch (error) { next(error) }
})
app.patch('/api/patients/:id/discharge', allow('hospital', 'admin'), async (req, res, next) => {
  try {
    const filter = { _id: req.params.id, status: 'accepted' }
    if (req.user.role === 'hospital') filter.hospital = req.user.hospital._id
    let patient = await Patient.findOneAndUpdate(
      { ...filter, triageBedReleased: { $ne: true } },
      { $set: { status: 'discharged', dischargedAt: new Date(), triageBedReleased: true } },
      { new: true },
    )
    const releasesBed = Boolean(patient)
    if (!patient) {
      patient = await Patient.findOneAndUpdate(
        { ...filter, triageBedReleased: true },
        { $set: { status: 'discharged', dischargedAt: new Date() } },
        { new: true },
      )
    }
    if (!patient) return res.status(404).json({ message: 'Admitted patient not found in your hospital.' })
    if (releasesBed) await releaseTriageBed(patient)
    res.json(patient)
  } catch (error) { next(error) }
})

function numberOrNull(value) {
  if (value === '' || value === null || value === undefined) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

app.get('/api/health', (req, res) => {
  const connected = mongoose.connection.readyState === 1
  res.status(connected ? 200 : 503).json({ status: connected ? 'ok' : 'unavailable', database: connected ? 'connected' : 'disconnected' })
})
app.use((error, req, res, next) => {
  console.error(error)
  if (error.name === 'ValidationError') return res.status(400).json({ message: 'Some submitted details are invalid.' })
  if (error.name === 'CastError') return res.status(400).json({ message: 'The requested record is invalid.' })
  res.status(500).json({ message: 'An unexpected server error occurred.' })
})

async function start() {
  if (!process.env.MONGO_URI || !JWT_SECRET || JWT_SECRET.length < 32) throw new Error('Set MONGO_URI and a JWT_SECRET of at least 32 characters.')
  await mongoose.connect(process.env.MONGO_URI)
  if (process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD) {
    const exists = await User.exists({ role: 'admin' })
    if (!exists) {
      await User.create({
        displayName: 'Network administrator',
        username: process.env.ADMIN_USERNAME.trim().toLowerCase(),
        passwordHash: await passwordRecord(process.env.ADMIN_PASSWORD),
        role: 'admin',
      })
      console.log('Initial administrator account created from environment settings.')
    }
  }
  app.listen(PORT, '127.0.0.1', () => console.log(`LifeQ API listening on http://127.0.0.1:${PORT}`))
}

start().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
