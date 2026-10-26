const express = require('express');
const mongoose = require('mongoose');
const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { loadModel, predictWindow } = require('./fall-model');

try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const app = express();
const port = Number(process.env.PORT) || 3000;
const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/iot_dashboard';
const distPath = path.join(__dirname, 'dist');
const dashboardKeyPath = path.join(__dirname, '.dashboard-access-code');
const DEFAULT_RULES = { heartRateLow: 40, heartRateHigh: 130, spo2Low: 92 };

function loadDashboardKey() {
  if (process.env.DASHBOARD_ACCESS_KEY) return process.env.DASHBOARD_ACCESS_KEY;
  try {
    return fs.readFileSync(dashboardKeyPath, 'utf8').trim();
  } catch {
    const key = crypto.randomBytes(32).toString('hex');
    try { fs.writeFileSync(dashboardKeyPath, key, { flag: 'wx' }); return key; }
    catch (error) { if (error.code !== 'EEXIST') throw error; return fs.readFileSync(dashboardKeyPath, 'utf8').trim(); }
  }
}
const dashboardKey = loadDashboardKey();
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
let lastReportRequestedAt = 0;
const whatsappConfigured = () => Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_WHATSAPP_FROM && process.env.TWILIO_WHATSAPP_CONTENT_SID);

const readingSchema = new mongoose.Schema({
  deviceId: { type: String, default: 'unknown', index: true },
  receivedAt: { type: Date, default: Date.now, index: true },
  method: { type: String, default: 'POST' },
  source: { type: String, enum: ['device', 'demo'], default: 'device', index: true },
  alertTypes: { type: [String], default: [] },
  whatsappStatus: { type: String, default: 'none' },
  data: { type: mongoose.Schema.Types.Mixed, required: true },
}, { collection: 'readings', versionKey: false });
const Reading = mongoose.models.Reading || mongoose.model('Reading', readingSchema);

const motionSampleSchema = new mongoose.Schema({
  tMs: { type: Number, required: true },
  x: { type: Number, required: true },
  y: { type: Number, required: true },
  z: { type: Number, required: true },
  magnitude: { type: Number, required: true },
}, { _id: false });
const motionWindowSchema = new mongoose.Schema({
  deviceId: { type: String, required: true, index: true },
  receivedAt: { type: Date, default: Date.now, index: true },
  sampleRateHz: { type: Number, required: true },
  accelUnit: { type: String, enum: ['g', 'm/s2'], default: 'g' },
  samples: { type: [motionSampleSchema], required: true },
  prediction: { type: mongoose.Schema.Types.Mixed, default: null },
}, { collection: 'motion_windows', versionKey: false });
motionWindowSchema.index({ deviceId: 1, receivedAt: -1 });
const MotionWindow = mongoose.models.MotionWindow || mongoose.model('MotionWindow', motionWindowSchema);
const fallModel = loadModel();
const liveMotionBuffers = new Map();

function analyzeLiveMotion(deviceId, sampleRateHz, accelUnit, samples, receivedAt) {
  if (!fallModel) return { state: 'model_unavailable', message: 'The WEDA-FALL model file is unavailable.' };
  if (sampleRateHz < 8 || sampleRateHz > 12) return { state: 'unsupported_sample_rate', message: 'This prototype was trained for 10 Hz motion batches.' };

  const currentTime = receivedAt.getTime();
  const finalOffset = samples.at(-1).tMs;
  const batch = samples.map((sample) => ({ time: currentTime - finalOffset + sample.tMs, x: sample.x, y: sample.y, z: sample.z }));
  let buffer = liveMotionBuffers.get(deviceId) || { sampleRateHz, accelUnit, samples: [] };
  const expectedGapMs = 2000 / sampleRateHz;
  if (buffer.sampleRateHz !== sampleRateHz || buffer.accelUnit !== accelUnit || (buffer.samples.length && batch[0].time - buffer.samples.at(-1).time > 2500)) {
    buffer = { sampleRateHz, accelUnit, samples: [] };
  }
  const lastBufferedTime = buffer.samples.at(-1)?.time ?? -1;
  buffer.samples.push(...batch.filter((sample) => sample.time > lastBufferedTime));
  buffer.samples = buffer.samples.filter((sample) => sample.time >= currentTime - 2500);
  buffer.updatedAt = currentTime;
  liveMotionBuffers.set(deviceId, buffer);
  if (liveMotionBuffers.size > 500) {
    const oldest = [...liveMotionBuffers.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0];
    if (oldest) liveMotionBuffers.delete(oldest[0]);
  }

  const windowSamples = buffer.samples.filter((sample) => sample.time > currentTime - 1500 && sample.time <= currentTime);
  if (windowSamples.length < 8 || currentTime - windowSamples[0].time < 1200 || expectedGapMs <= 0) {
    return { state: 'warming_up', message: 'Collecting a complete 1.5-second motion window.', sampleCount: windowSamples.length, observedAt: receivedAt };
  }
  return predictWindow(windowSamples, accelUnit, fallModel);
}

const guardianSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  relation: { type: String, default: 'Guardian', trim: true },
  phone: { type: String, required: true, unique: true },
  consent: { type: Boolean, required: true, default: false },
  consentAt: { type: Date, required: true },
  createdAt: { type: Date, default: Date.now },
}, { collection: 'guardian_contacts', versionKey: false });
const Guardian = mongoose.models.Guardian || mongoose.model('Guardian', guardianSchema);
const rulesSchema = new mongoose.Schema({
  key: { type: String, unique: true, default: 'default' },
  ...Object.fromEntries(Object.entries(DEFAULT_RULES).map(([key, value]) => [key, { type: Number, default: value }])),
  updatedAt: { type: Date, default: Date.now },
}, { collection: 'safety_settings', versionKey: false });
const SafetyRules = mongoose.models.SafetyRules || mongoose.model('SafetyRules', rulesSchema);
const episodeSchema = new mongoose.Schema({
  deviceId: String,
  alertType: String,
  active: { type: Boolean, default: false },
  deliveredTo: { type: [String], default: [] },
  updatedAt: { type: Date, default: Date.now },
}, { collection: 'alert_episodes', versionKey: false });
episodeSchema.index({ deviceId: 1, alertType: 1 }, { unique: true });
const AlertEpisode = mongoose.models.AlertEpisode || mongoose.model('AlertEpisode', episodeSchema);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

async function acceptData(req, res) {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const data = Object.keys(body).length ? body : req.query;
  const deviceId = String(req.params.deviceId || req.get('x-device-id') || data.deviceId || 'unknown');
  try {
    const source = req.body?.source === 'demo' ? 'demo' : 'device';
    const rules = await readSafetyRules();
    const alertTypes = source === 'device' ? detectAlerts(data, rules) : [];
    const saved = await Reading.create({ deviceId, method: req.method, data, receivedAt: new Date(), source, alertTypes, whatsappStatus: alertTypes.length ? 'pending' : 'none' });
    console.log(`\n[${saved.receivedAt.toISOString()}] ${saved.method} /api/data from ${saved.deviceId}`);
    console.log(JSON.stringify(saved.data, null, 2));
    res.status(202).json({ ok: true, message: 'Data received and saved', id: saved.id });
    if (source === 'device') dispatchAlerts(saved, alertTypes).catch((error) => console.error('WhatsApp alert processing failed:', error.message));
  } catch (error) {
    console.error('Could not save incoming device data:', error.message);
    res.status(503).json({ ok: false, message: 'Data could not be saved to MongoDB' });
  }
}

async function readSafetyRules() {
  const saved = await SafetyRules.findOne({ key: 'default' }).lean();
  return { ...DEFAULT_RULES, ...(saved || {}) };
}

function detectAlerts(data, rules) {
  const alerts = [];
  if (data.fallAlert === true || data.fall_alert === true || data.fallDetection === true || data.fallDetected === true || data.fall_detection === true) alerts.push('fall_detected');
  const heartRate = Number(data.heartRate ?? data.heartbeat);
  const spo2 = Number(data.spo2 ?? data.SpO2);
  if (Number.isFinite(heartRate) && heartRate > 0 && heartRate <= rules.heartRateLow) alerts.push('heart_rate_low');
  if (Number.isFinite(heartRate) && heartRate >= rules.heartRateHigh) alerts.push('heart_rate_high');
  if (Number.isFinite(spo2) && spo2 > 0 && spo2 <= rules.spo2Low) alerts.push('spo2_low');
  if (/^(critical|emergency)$/i.test(String(data.status || ''))) alerts.push('device_critical');
  return [...new Set(alerts)];
}

function alertDescription(type, data) {
  if (type === 'fall_detected') return 'a fall detection was triggered';
  if (type === 'heart_rate_low') return `heart rate ${data.heartRate ?? data.heartbeat} bpm`;
  if (type === 'heart_rate_high') return `heart rate ${data.heartRate ?? data.heartbeat} bpm`;
  if (type === 'spo2_low') return `blood oxygen ${data.spo2 ?? data.SpO2}%`;
  return 'the device marked a reading as critical';
}

async function sendWhatsapp(contact, reading, alertType) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const sender = String(process.env.TWILIO_WHATSAPP_FROM || '').replace(/^whatsapp:/, '');
  const to = `whatsapp:${contact.phone}`;
  const from = `whatsapp:${sender}`;
  const variables = {
    1: contact.name,
    2: reading.deviceId,
    3: alertDescription(alertType, reading.data),
    4: reading.receivedAt.toISOString(),
  };
  const body = new URLSearchParams({ To: to, From: from, ContentSid: process.env.TWILIO_WHATSAPP_CONTENT_SID, ContentVariables: JSON.stringify(variables) });
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Twilio returned ${response.status}: ${detail.slice(0, 300)}`);
  }
  return response.json();
}

async function dispatchAlerts(reading, alertTypes) {
  await AlertEpisode.updateMany(
    { deviceId: reading.deviceId, active: true, alertType: { $nin: alertTypes } },
    { $set: { active: false, deliveredTo: [], updatedAt: new Date() } },
  );
  if (!alertTypes.length) return;

  const contacts = await Guardian.find({ consent: true }).lean();
  let delivery = contacts.length ? (whatsappConfigured() ? 'failed' : 'not_configured') : 'no_contacts';
  for (const alertType of alertTypes) {
    const episode = await AlertEpisode.findOneAndUpdate(
      { deviceId: reading.deviceId, alertType },
      { $setOnInsert: { deviceId: reading.deviceId, alertType, active: false, deliveredTo: [] }, $set: { updatedAt: new Date() } },
      { upsert: true, new: true },
    );
    if (!episode.active) { episode.active = true; episode.deliveredTo = []; }
    episode.updatedAt = new Date();
    if (!whatsappConfigured() || !contacts.length) { await episode.save(); continue; }

    let sent = 0, failed = 0;
    for (const contact of contacts) {
      if (episode.deliveredTo.includes(contact.phone)) continue;
      try {
        await sendWhatsapp(contact, reading, alertType);
        episode.deliveredTo.push(contact.phone); sent += 1;
      } catch (error) {
        failed += 1;
        console.error(`WhatsApp delivery failed for guardian ending ${contact.phone.slice(-4)}: ${error.message}`);
      }
    }
    await episode.save();
    if (failed) delivery = sent ? 'partial' : 'failed';
    else if (sent || contacts.every((contact) => episode.deliveredTo.includes(contact.phone))) delivery = 'sent';
  }
  await Reading.updateOne({ _id: reading._id }, { $set: { whatsappStatus: delivery } });
}

function requireDashboardKey(req, res, next) {
  const supplied = Buffer.from(String(req.get('x-dashboard-key') || ''));
  const expected = Buffer.from(dashboardKey);
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
    return res.status(401).json({ ok: false, message: 'Open the dashboard on this computer to access private device data.' });
  }
  next();
}

app.post('/api/data', acceptData);
app.post('/webhook/:deviceId', acceptData);
app.post('/api/motion', async (req, res) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const deviceId = String(req.get('x-device-id') || body.deviceId || '').trim();
  const sampleRateHz = body.sampleRateHz;
  const accelUnit = String(body.accelUnit || body.unit || 'g').toLowerCase();
  const rows = body.samples;
  if (!deviceId || deviceId.length > 80) return res.status(400).json({ ok: false, message: 'Provide a deviceId no longer than 80 characters.' });
  if (typeof sampleRateHz !== 'number' || !Number.isFinite(sampleRateHz) || sampleRateHz < 1 || sampleRateHz > 200) {
    return res.status(400).json({ ok: false, message: 'sampleRateHz must be a number between 1 and 200.' });
  }
  if (!['g', 'm/s2'].includes(accelUnit)) return res.status(400).json({ ok: false, message: 'accelUnit must be g or m/s2.' });
  if (!Array.isArray(rows) || rows.length < 2 || rows.length > 500) return res.status(400).json({ ok: false, message: 'Send 2 to 500 motion samples in each batch.' });

  let previousTime = -1;
  const samples = [];
  for (const row of rows) {
    const tMs = row?.tMs, x = row?.x, y = row?.y, z = row?.z;
    if (![tMs, x, y, z].every((value) => typeof value === 'number' && Number.isFinite(value))) {
      return res.status(400).json({ ok: false, message: 'Each sample needs numeric tMs, x, y, and z values.' });
    }
    if (tMs < 0 || tMs <= previousTime || tMs > 10000 || [x, y, z].some((value) => Math.abs(value) > 100)) {
      return res.status(400).json({ ok: false, message: 'Sample times must increase within a 10-second batch and axis values must be within ±100.' });
    }
    const calculatedMagnitude = Math.sqrt(x * x + y * y + z * z);
    const magnitude = row.magnitude === undefined ? calculatedMagnitude : row.magnitude;
    if (typeof magnitude !== 'number' || !Number.isFinite(magnitude) || magnitude < 0 || magnitude > 200) {
      return res.status(400).json({ ok: false, message: 'magnitude must be a finite, non-negative number (or omit it to calculate from x/y/z).' });
    }
    samples.push({ tMs, x, y, z, magnitude });
    previousTime = tMs;
  }

  try {
    const receivedAt = new Date();
    const prediction = analyzeLiveMotion(deviceId, sampleRateHz, accelUnit, samples, receivedAt);
    const saved = await MotionWindow.create({ deviceId, receivedAt, sampleRateHz, accelUnit, samples, prediction });
    res.status(202).json({ ok: true, id: String(saved._id), deviceId, sampleCount: samples.length, sampleRateHz, receivedAt: saved.receivedAt, prediction });
  } catch (error) {
    console.error('Could not save MPU6050 motion window:', error.message);
    res.status(503).json({ ok: false, message: 'Motion data could not be saved to MongoDB.' });
  }
});
app.get('/api/motion', requireDashboardKey, async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
    const filter = req.query.deviceId ? { deviceId: String(req.query.deviceId).slice(0, 80) } : {};
    const windows = await MotionWindow.find(filter).sort({ receivedAt: -1 }).limit(limit).lean();
    res.json(windows.map((window) => ({ ...window, id: String(window._id) })));
  } catch (error) {
    console.error('Could not retrieve MPU6050 motion windows:', error.message);
    res.status(503).json({ ok: false, message: 'Motion data could not be retrieved from MongoDB.' });
  }
});
app.get('/api/motion/predictions', requireDashboardKey, async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 8, 1), 50);
    const filter = req.query.deviceId ? { deviceId: String(req.query.deviceId).slice(0, 80) } : {};
    const windows = await MotionWindow.find({ ...filter, prediction: { $exists: true, $ne: null } })
      .sort({ receivedAt: -1 }).limit(limit).select({ deviceId: 1, receivedAt: 1, sampleRateHz: 1, prediction: 1 }).lean();
    const deviceIds = [...new Set(windows.map((window) => window.deviceId))];
    const latestReadings = await Promise.all(deviceIds.map((deviceId) => Reading.findOne({ deviceId }).sort({ receivedAt: -1 }).lean()));
    const latestByDevice = new Map(deviceIds.map((deviceId, index) => [deviceId, latestReadings[index]]));
    const predictions = windows.map((window) => {
      const reading = latestByDevice.get(window.deviceId);
      const heartRate = Number(reading?.data?.heartRate ?? reading?.data?.heartbeat);
      const spo2 = Number(reading?.data?.spo2 ?? reading?.data?.SpO2);
      return {
        id: String(window._id), deviceId: window.deviceId, receivedAt: window.receivedAt,
        sampleRateHz: window.sampleRateHz, prediction: window.prediction,
        vitalsContext: {
          heartRate: Number.isFinite(heartRate) && heartRate > 0 ? heartRate : null,
          spo2: Number.isFinite(spo2) && spo2 > 0 ? spo2 : null,
          receivedAt: reading?.receivedAt || null,
          usedByModel: false,
        },
      };
    });
    res.json({
      model: fallModel ? {
        name: 'WEDA-FALL wrist accelerometer prototype',
        status: 'experimental',
        windowSeconds: fallModel.input.windowSeconds,
        sampleRateHz: fallModel.input.sampleRateHz,
        predictionLeadSeconds: fallModel.input.predictionLeadSeconds,
        holdoutEvaluation: fallModel.evaluation,
        limitation: 'Impact time is a peak-acceleration proxy inside a manually timed fall sequence, not video-verified ground impact. Scores are not calibrated probabilities. Heart rate and SpO2 are shown as context only and are not used by this model.',
      } : { status: 'unavailable', limitation: 'The local WEDA-FALL model artifact could not be loaded.' },
      predictions,
    });
  } catch (error) {
    console.error('Could not load live motion predictions:', error.message);
    res.status(503).json({ ok: false, message: 'Could not load motion predictions.' });
  }
});
app.get('/api/session-key', (req, res) => {
  const host = String(req.headers.host || '').split(':')[0].replace(/^\[|\]$/g, '');
  const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(':')[0];
  if (!['localhost', '127.0.0.1', '::1'].includes(host) || forwardedHost) return res.status(404).end();
  res.json({ key: dashboardKey });
});
app.get('/api/safety-center', requireDashboardKey, async (_req, res) => {
  try {
    const [contacts, rules] = await Promise.all([Guardian.find().sort({ createdAt: 1 }).lean(), readSafetyRules()]);
    res.json({ contacts: contacts.map(({ _id, name, relation, phone, consent }) => ({ id: String(_id), name, relation, phone, consent })), rules, whatsappConfigured: whatsappConfigured() });
  } catch (error) { res.status(503).json({ ok: false, message: error.message }); }
});
app.post('/api/guardians', requireDashboardKey, async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const relation = String(req.body?.relation || 'Guardian').trim();
  const phone = String(req.body?.phone || '').replace(/[\s()-]/g, '');
  if (!name || name.length > 80 || !/^\+[1-9]\d{7,14}$/.test(phone)) return res.status(400).json({ ok: false, message: 'Enter a name and WhatsApp number in international format, such as +919876543210.' });
  if (req.body?.consent !== true) return res.status(400).json({ ok: false, message: 'Confirm that this guardian agreed to receive safety alerts.' });
  try {
    const guardian = await Guardian.create({ name, relation, phone, consent: true, consentAt: new Date() });
    res.status(201).json({ id: String(guardian._id), name: guardian.name, relation: guardian.relation, phone: guardian.phone, consent: true });
  } catch (error) {
    const duplicate = error.code === 11000;
    res.status(duplicate ? 409 : 503).json({ ok: false, message: duplicate ? 'That WhatsApp number is already saved.' : 'Could not save this contact.' });
  }
});
app.delete('/api/guardians/:id', requireDashboardKey, async (req, res) => {
  try {
    const removed = await Guardian.findByIdAndDelete(req.params.id);
    if (removed) await AlertEpisode.updateMany({}, { $pull: { deliveredTo: removed.phone } });
    res.json({ ok: true });
  } catch { res.status(400).json({ ok: false, message: 'Could not remove this contact.' }); }
});
app.put('/api/safety-settings', requireDashboardKey, async (req, res) => {
  const rules = req.body || {};
  const heartRateLow = Number(rules.heartRateLow), heartRateHigh = Number(rules.heartRateHigh), spo2Low = Number(rules.spo2Low);
  if (!Number.isInteger(heartRateLow) || heartRateLow < 25 || heartRateLow > 70 || !Number.isInteger(heartRateHigh) || heartRateHigh < 100 || heartRateHigh > 250 || heartRateLow >= heartRateHigh || !Number.isInteger(spo2Low) || spo2Low < 70 || spo2Low > 95) {
    return res.status(400).json({ ok: false, message: 'Use valid alert limits and keep the low heart-rate limit below the high limit.' });
  }
  try {
    const saved = await SafetyRules.findOneAndUpdate({ key: 'default' }, { $set: { heartRateLow, heartRateHigh, spo2Low, updatedAt: new Date() } }, { upsert: true, new: true, setDefaultsOnInsert: true }).lean();
    res.json({ heartRateLow: saved.heartRateLow, heartRateHigh: saved.heartRateHigh, spo2Low: saved.spo2Low });
  } catch (error) { res.status(503).json({ ok: false, message: error.message }); }
});
app.get('/api/reports/status', (_req, res) => res.json({ configured: Boolean(process.env.GEMINI_API_KEY), model: GEMINI_MODEL }));
app.post('/api/reports/generate', requireDashboardKey, async (req, res) => {
  const period = req.body?.period;
  if (!['week', 'month'].includes(period)) return res.status(400).json({ ok: false, message: 'Choose a weekly or monthly report.' });
  if (!process.env.GEMINI_API_KEY) return res.status(503).json({ ok: false, code: 'gemini_not_configured', message: 'Add GEMINI_API_KEY to your local .env file, then restart the server.' });
  if (Date.now() - lastReportRequestedAt < 20000) return res.status(429).json({ ok: false, message: 'Please wait a few seconds before generating another report.' });
  lastReportRequestedAt = Date.now();

  const end = new Date();
  const daysInPeriod = period === 'week' ? 7 : 30;
  const indiaDateParts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(end);
  const indiaParts = Object.fromEntries(indiaDateParts.map(({ type, value }) => [type, value]));
  const todayIndiaUtc = Date.UTC(Number(indiaParts.year), Number(indiaParts.month) - 1, Number(indiaParts.day));
  const dayKeys = Array.from({ length: daysInPeriod }, (_, index) => new Date(todayIndiaUtc - (daysInPeriod - 1 - index) * 86400000).toISOString().slice(0, 10));
  const start = new Date(todayIndiaUtc - (daysInPeriod - 1) * 86400000 - 330 * 60000);
  try {
    const dailyRows = await Reading.aggregate([
      { $match: { source: { $ne: 'demo' }, receivedAt: { $gte: start, $lte: end } } },
      { $addFields: {
        hrValue: { $convert: { input: { $ifNull: ['$data.heartRate', '$data.heartbeat'] }, to: 'double', onError: null, onNull: null } },
        spo2Value: { $convert: { input: { $ifNull: ['$data.spo2', '$data.SpO2'] }, to: 'double', onError: null, onNull: null } },
        reportDay: { $dateToString: { format: '%Y-%m-%d', date: '$receivedAt', timezone: 'Asia/Kolkata' } },
        statusText: { $toLower: { $convert: { input: { $ifNull: ['$data.status', ''] }, to: 'string', onError: '', onNull: '' } } },
      } },
      { $addFields: {
        validHr: { $cond: [{ $and: [{ $gte: ['$hrValue', 20] }, { $lte: ['$hrValue', 250] }] }, '$hrValue', null] },
        validSpo2: { $cond: [{ $and: [{ $gte: ['$spo2Value', 50] }, { $lte: ['$spo2Value', 100] }] }, '$spo2Value', null] },
        isFall: { $or: ['$data.fallAlert', '$data.fall_alert', '$data.fallDetection', '$data.fallDetected', '$data.fall_detection'] },
        isCritical: { $or: [{ $in: ['$statusText', ['critical', 'emergency']] }, { $gt: [{ $size: { $ifNull: ['$alertTypes', []] } }, 0] }] },
      } },
      { $group: {
        _id: '$reportDay', readingCount: { $sum: 1 },
        hrCount: { $sum: { $cond: [{ $ne: ['$validHr', null] }, 1, 0] } }, hrSum: { $sum: { $ifNull: ['$validHr', 0] } }, hrMin: { $min: { $ifNull: ['$validHr', 9999] } }, hrMax: { $max: { $ifNull: ['$validHr', -1] } },
        spo2Count: { $sum: { $cond: [{ $ne: ['$validSpo2', null] }, 1, 0] } }, spo2Sum: { $sum: { $ifNull: ['$validSpo2', 0] } }, spo2Min: { $min: { $ifNull: ['$validSpo2', 9999] } }, spo2Max: { $max: { $ifNull: ['$validSpo2', -1] } },
        fallCount: { $sum: { $cond: ['$isFall', 1, 0] } }, criticalCount: { $sum: { $cond: ['$isCritical', 1, 0] } },
      } },
      { $sort: { _id: 1 } },
    ]);
    const totalReadings = dailyRows.reduce((sum, day) => sum + day.readingCount, 0);
    if (!totalReadings) return res.status(422).json({ ok: false, message: `No device readings were recorded in the last ${period === 'week' ? '7 days' : '30 days'}.` });
    const totals = dailyRows.reduce((all, day) => ({
      hrCount: all.hrCount + day.hrCount, hrSum: all.hrSum + day.hrSum, hrMin: Math.min(all.hrMin, day.hrMin), hrMax: Math.max(all.hrMax, day.hrMax),
      spo2Count: all.spo2Count + day.spo2Count, spo2Sum: all.spo2Sum + day.spo2Sum, spo2Min: Math.min(all.spo2Min, day.spo2Min), spo2Max: Math.max(all.spo2Max, day.spo2Max),
      fallCount: all.fallCount + day.fallCount, criticalCount: all.criticalCount + day.criticalCount,
    }), { hrCount: 0, hrSum: 0, hrMin: 9999, hrMax: -1, spo2Count: 0, spo2Sum: 0, spo2Min: 9999, spo2Max: -1, fallCount: 0, criticalCount: 0 });
    const reportData = {
      period: period === 'week' ? 'Last 7 days' : 'Last 30 days', start: start.toISOString(), end: end.toISOString(),
      totals: { readings: totalReadings, daysWithReadings: dailyRows.length, daysInPeriod, daysWithoutReadings: daysInPeriod - dailyRows.length, heartRate: { validSamples: totals.hrCount, missingOrInvalid: totalReadings - totals.hrCount, averageBpm: totals.hrCount ? Math.round(totals.hrSum / totals.hrCount * 10) / 10 : null, minBpm: totals.hrCount ? totals.hrMin : null, maxBpm: totals.hrCount ? totals.hrMax : null }, spo2: { validSamples: totals.spo2Count, missingOrInvalid: totalReadings - totals.spo2Count, averagePercent: totals.spo2Count ? Math.round(totals.spo2Sum / totals.spo2Count * 10) / 10 : null, minPercent: totals.spo2Count ? totals.spo2Min : null, maxPercent: totals.spo2Count ? totals.spo2Max : null }, fallFlags: totals.fallCount, readingsFlaggedCritical: totals.criticalCount },
      daily: dayKeys.map((date) => {
        const day = dailyRows.find((row) => row._id === date);
        const readingCount = day?.readingCount || 0, hrCount = day?.hrCount || 0, spo2Count = day?.spo2Count || 0;
        return { date, readingCount, heartRate: { validSamples: hrCount, missingOrInvalid: readingCount - hrCount, averageBpm: hrCount ? Math.round(day.hrSum / hrCount * 10) / 10 : null, minBpm: hrCount ? day.hrMin : null, maxBpm: hrCount ? day.hrMax : null }, spo2: { validSamples: spo2Count, missingOrInvalid: readingCount - spo2Count, averagePercent: spo2Count ? Math.round(day.spo2Sum / spo2Count * 10) / 10 : null, minPercent: spo2Count ? day.spo2Min : null, maxPercent: spo2Count ? day.spo2Max : null }, fallFlags: day?.fallCount || 0, readingsFlaggedCritical: day?.criticalCount || 0 };
      }),
    };

    const geminiOptions = {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: 'You write cautious, plain-language summaries of wearable-device readings for a personal dashboard. This is not medical advice. Do not diagnose, infer a condition, recommend treatment, or claim measurements are clinically accurate. Use only supplied aggregate values and the included daily breakdown to describe trends. Explicitly state when a metric is missing or sparse; never estimate missing values. Distinguish device flags from confirmed events. Mention that single readings and consumer wearable data have limitations. Return concise Markdown with headings: Period summary, Reading trends, Alerts and data gaps, Limitations.' }] }, contents: [{ role: 'user', parts: [{ text: `Create a ${reportData.period.toLowerCase()} health-data summary from these aggregate totals and daily readings. Point out relevant day-to-day changes without inventing causes. Keep it under 350 words. Do not identify a patient or device. Data: ${JSON.stringify(reportData)}` }] }], generationConfig: { maxOutputTokens: 900 } }),
    };
    const modelQueue = [...new Set([GEMINI_MODEL, 'gemini-3.7-flash'])];
    let response, modelUsed = GEMINI_MODEL;
    for (const model of modelQueue) {
      modelUsed = model;
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        response = await fetch(url, { ...geminiOptions, signal: AbortSignal.timeout(30000) });
        if (response.ok || response.status !== 503 || attempt === 2) break;
        const retryAfter = Number(response.headers.get('retry-after'));
        await response.arrayBuffer().catch(() => {});
        const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, 5000)
          : 700 * (2 ** attempt) + Math.floor(Math.random() * 400);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      if (response.ok || response.status !== 503) break;
      await response.arrayBuffer().catch(() => {});
    }
    if (!response.ok) {
      const status = response.status;
      console.error(`Gemini report request failed with status ${status}`);
      if (status === 503) {
        const metrics = reportData.totals;
        const localReport = [
          `## Period summary`,
          `${reportData.period}: ${metrics.readings} recorded readings across ${metrics.daysWithReadings} of ${metrics.daysInPeriod} days. ${metrics.daysWithoutReadings} days had no readings.`,
          `## Reading trends`,
          `Heart rate: ${metrics.heartRate.averageBpm ?? 'No valid samples'} bpm average, ${metrics.heartRate.minBpm ?? '—'} bpm minimum, ${metrics.heartRate.maxBpm ?? '—'} bpm maximum. ${metrics.heartRate.missingOrInvalid} readings were missing or invalid.`,
          `SpO₂: ${metrics.spo2.averagePercent ?? 'No valid samples'}% average, ${metrics.spo2.minPercent ?? '—'}% minimum, ${metrics.spo2.maxPercent ?? '—'}% maximum. ${metrics.spo2.missingOrInvalid} readings were missing or invalid.`,
          `## Alerts and data gaps`,
          `Device fall flags: ${metrics.fallFlags}. Critical flags: ${metrics.readingsFlaggedCritical}. See the daily table for each date’s readings and gaps.`,
          `## Limitations`,
          `Gemini was unavailable, so this summary was calculated directly from the recorded readings and contains no AI interpretation. Wearable readings can be inaccurate; this report is not a diagnosis or medical advice.`,
        ].join('\n\n');
        return res.json({ ok: true, period, start: start.toISOString(), end: end.toISOString(), generatedAt: new Date().toISOString(), metrics, daily: reportData.daily, report: localReport, reportSource: 'calculated-fallback', reportModel: null });
      }
      const message = status === 401 || status === 403
        ? 'Google rejected this Gemini API key or its permissions. In Google AI Studio, create an active Gemini API key or restrict the key to the Gemini API, replace GEMINI_API_KEY in .env, and restart the API server.'
        : status === 404
          ? 'Gemini could not find the configured model. Check GEMINI_MODEL in .env and restart the API server.'
          : status === 429
            ? 'Gemini rate limit or quota reached. Check the project quota and try again later.'
            : status === 400
              ? 'Gemini rejected the report request. Check the configured model and request settings.'
            : `Gemini is temporarily unavailable (HTTP ${status}). Please try again later.`;
      return res.status(status === 429 ? 429 : 502).json({ ok: false, code: status === 401 || status === 403 ? 'gemini_auth_error' : status === 404 ? 'gemini_model_error' : 'gemini_request_error', message });
    }
    const generated = await response.json();
    const report = (generated.candidates?.[0]?.content?.parts || []).map((part) => part.text || '').join('\n').trim();
    if (!report) return res.status(502).json({ ok: false, message: 'Gemini returned no report. Try again.' });
    res.json({ ok: true, period, start: start.toISOString(), end: end.toISOString(), generatedAt: new Date().toISOString(), metrics: reportData.totals, daily: reportData.daily, report, reportSource: 'gemini', reportModel: modelUsed });
  } catch (error) {
    console.error('Report generation failed:', error.name || 'Error');
    res.status(error.name === 'TimeoutError' ? 504 : 502).json({ ok: false, message: error.name === 'TimeoutError' ? 'Gemini took too long to respond. Please try again.' : 'Could not generate the report. Check the server connection and try again.' });
  }
});
app.get('/api/data', async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const readings = await Reading.find().sort({ receivedAt: -1 }).limit(limit).lean();
    res.json(readings.map((reading) => ({ ...reading, id: reading._id.toString() })));
  } catch (error) {
    console.error('Could not load readings:', error.message);
    res.status(503).json({ ok: false, message: 'Could not load readings from MongoDB' });
  }
});
app.get('/api/stats', async (_req, res) => {
  try {
    const totalReadings = await Reading.countDocuments();
    res.json({ totalReadings });
  } catch (error) {
    console.error('Could not load reading totals:', error.message);
    res.status(503).json({ ok: false, message: 'Could not load reading totals from MongoDB' });
  }
});
app.get('/health', (_req, res) => res.json({
  ok: mongoose.connection.readyState === 1,
  service: 'iot-data-receiver',
  database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
  whatsappConfigured: whatsappConfigured(),
}));

app.use(express.static(distPath));
app.get(/.*/, (_req, res) => res.sendFile(path.join(distPath, 'index.html')));

mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 5000 })
  .then(() => {
    console.log(`Connected to MongoDB at ${mongoUri}`);
    app.listen(port, '0.0.0.0', () => {
      console.log(`IoT dashboard and receiver listening on http://localhost:${port}`);
      console.log(`Device endpoint: POST http://localhost:${port}/api/data`);
      console.log(`Motion endpoint: POST http://localhost:${port}/api/motion`);
      console.log(`Live motion model: ${fallModel ? 'loaded' : 'unavailable'}`);
    });
  })
  .catch((error) => {
    console.error(`Could not connect to MongoDB at ${mongoUri}: ${error.message}`);
    process.exit(1);
  });
