const mongoose = require('mongoose');

const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/iot_dashboard';
const readingSchema = new mongoose.Schema({
  deviceId: String,
  receivedAt: Date,
  method: String,
  source: { type: String, enum: ['device', 'demo'], default: 'device' },
  data: mongoose.Schema.Types.Mixed,
}, { collection: 'readings', versionKey: false });
const Reading = mongoose.models.Reading || mongoose.model('Reading', readingSchema);

async function seed() {
  await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 5000 });
  const existing = await Reading.countDocuments({ source: 'demo' });
  if (existing) {
    console.log(`Demo readings are already present (${existing}); nothing added.`);
    return;
  }

  const heartRates = [69, 72, 75, 71, 78, 82, 76, 73, 80, 74, 77, 71, 68, 72, 75, 79, 73, 70];
  const oxygen =    [ 98, 98, 97, 98, 97, 96, 97, 98, 96, 97, 98, 98, 99, 98, 97, 97, 98, 98];
  const now = Date.now();
  const rows = heartRates.map((heartRate, index) => ({
    deviceId: 'DEMO-BAND',
    receivedAt: new Date(now - (heartRates.length - index - 1) * 6 * 60 * 1000),
    method: 'SAMPLE',
    source: 'demo',
    data: {
      deviceId: 'DEMO-BAND',
      heartRate,
      spo2: oxygen[index],
      status: 'SAMPLE',
      fallAlert: false,
      sample: true,
    },
  }));
  await Reading.insertMany(rows);
  console.log(`Added ${rows.length} clearly labeled sample readings to ${mongoose.connection.name}.`);
}

seed()
  .catch((error) => {
    console.error(`Could not add demo readings: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => { await mongoose.disconnect(); });
