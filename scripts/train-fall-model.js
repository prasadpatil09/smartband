const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const datasetRoot = path.join(projectRoot, 'data', 'WEDA-FALL-main', 'dataset');
const sensorRoot = path.join(datasetRoot, '10Hz');
const impactSensorRoot = path.join(datasetRoot, '50Hz');
const labelsPath = path.join(datasetRoot, 'fall_timestamps.csv');
const outputPath = path.join(projectRoot, 'models', 'weda-fall-accelerometer.json');
const VALIDATION_USERS = new Set(['U09', 'U10', 'U11']);
const HOLDOUT_USERS = new Set(['U12', 'U13', 'U14']);
const WINDOW_SECONDS = 1.5;
const STRIDE_SECONDS = 0.25;
const GRAVITY = 9.80665;
const ONLINE_CADENCE_WINDOWS = 2;
const EARLIEST_IMPACT_LEAD_SECONDS = 0.3;
const LATEST_IMPACT_LEAD_SECONDS = 1.5;
const IMPACT_PEAK_MIN_MS2 = 2 * GRAVITY;

function parseCsvLine(line) {
  return line.split(',').map((value) => value.trim().replace(/^"|"$/g, ''));
}

function loadFallIntervals() {
  if (!fs.existsSync(labelsPath)) throw new Error(`Missing labels file: ${labelsPath}`);
  const lines = fs.readFileSync(labelsPath, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  const intervals = new Map();
  for (const line of lines.slice(1)) {
    const [filename, start, end] = parseCsvLine(line);
    const startSeconds = Number(start);
    const endSeconds = Number(end);
    if (filename && Number.isFinite(startSeconds) && Number.isFinite(endSeconds) && endSeconds > startSeconds) {
      intervals.set(filename, { start: startSeconds, end: endSeconds });
    }
  }
  return intervals;
}

function extractFeatures(samples) {
  const axes = [0, 1, 2].map((axis) => samples.map((sample) => sample[axis] / GRAVITY));
  const magnitudes = samples.map((sample) => Math.hypot(...sample.map((value) => value / GRAVITY)));
  const features = [];
  for (const values of axes) {
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
    features.push(mean, Math.sqrt(variance), Math.min(...values), Math.max(...values));
  }
  const magnitudeMean = magnitudes.reduce((sum, value) => sum + value, 0) / magnitudes.length;
  const magnitudeVariance = magnitudes.reduce((sum, value) => sum + (value - magnitudeMean) ** 2, 0) / magnitudes.length;
  let jerkEnergy = 0;
  for (let index = 1; index < magnitudes.length; index += 1) {
    const delta = (magnitudes[index] - magnitudes[index - 1]) * 10;
    jerkEnergy += delta * delta;
  }
  features.push(
    magnitudeMean,
    Math.sqrt(magnitudeVariance),
    Math.min(...magnitudes),
    Math.max(...magnitudes),
    Math.sqrt(jerkEnergy / Math.max(1, magnitudes.length - 1)),
  );
  // Preserve the order of the 15 samples so the classifier can learn a descent
  // or rotation pattern instead of only seeing whole-window averages.
  for (const values of axes) features.push(...values);
  return features;
}

function resampleWindow(samples, start, end) {
  const result = [];
  let right = 0;
  for (let index = 0; index < 15; index += 1) {
    const time = start + (index + 1) * 0.1;
    while (right < samples.length && samples[right].time < time) right += 1;
    const after = samples[right];
    const before = samples[right - 1];
    if (!after || !before || after.time - before.time > 0.45 || time < before.time || time > after.time) return null;
    const ratio = (time - before.time) / Math.max(1e-9, after.time - before.time);
    result.push(before.axes.map((value, axis) => value + (after.axes[axis] - value) * ratio));
  }
  return end - start >= 1.4 ? result : null;
}

function readSamples(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line).map(Number);
    return values.length >= 4 && values.slice(0, 4).every(Number.isFinite)
      ? { time: values[0], axes: values.slice(1, 4) }
      : null;
  }).filter(Boolean);
}

function findImpactProxy(activityName, userId, trial, interval) {
  const filePath = path.join(impactSensorRoot, activityName, `${userId}_R${trial}_accel.csv`);
  if (!fs.existsSync(filePath)) return null;
  const samples = readSamples(filePath).filter((sample) => sample.time >= interval.start && sample.time <= interval.end);
  if (!samples.length) return null;
  const peak = samples.reduce((best, sample) => {
    const magnitude = Math.hypot(...sample.axes);
    return magnitude > best.magnitude ? { time: sample.time, magnitude } : best;
  }, { time: 0, magnitude: -Infinity });
  return peak.magnitude >= IMPACT_PEAK_MIN_MS2 ? peak : null;
}

function collectRows(intervals) {
  const rows = [];
  const impactLags = [];
  let excludedFalls = 0;
  for (const activity of fs.readdirSync(sensorRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
    const isFall = /^F\d\d$/.test(activity.name);
    for (const filename of fs.readdirSync(path.join(sensorRoot, activity.name)).filter((entry) => entry.endsWith('_accel.csv'))) {
      const match = filename.match(/^(U\d+)_R(\d+)_accel\.csv$/);
      if (!match) continue;
      const userId = match[1];
      const samples = readSamples(path.join(sensorRoot, activity.name, filename));
      if (samples.length < 8) continue;
      const key = `${activity.name}/${userId}_R${match[2]}`;
      const interval = isFall ? intervals.get(key) : null;
      if (isFall && !interval) continue;
      const impactProxy = isFall ? findImpactProxy(activity.name, userId, match[2], interval) : null;
      if (isFall && !impactProxy) { excludedFalls += 1; continue; }
      if (impactProxy) impactLags.push(impactProxy.time - interval.start);
      const lastTime = samples[samples.length - 1].time;
      const lastCandidateEnd = isFall ? Math.min(lastTime, impactProxy.time - EARLIEST_IMPACT_LEAD_SECONDS) : lastTime;
      let windowIndex = 0;
      for (let end = samples[0].time + WINDOW_SECONDS; end <= lastCandidateEnd; end += STRIDE_SECONDS, windowIndex += 1) {
        const start = end - WINDOW_SECONDS;
        const window = resampleWindow(samples, start, end);
        if (!window) continue;
        const leadSeconds = isFall ? impactProxy.time - end : null;
        const label = isFall ? Number(leadSeconds >= EARLIEST_IMPACT_LEAD_SECONDS && leadSeconds <= LATEST_IMPACT_LEAD_SECONDS) : 0;
        rows.push({
          x: extractFeatures(window), y: label, userId,
          activity: activity.name, eventId: key, windowIndex,
          leadSeconds: label ? leadSeconds : null,
        });
      }
    }
  }
  return { rows, impactLags, excludedFalls };
}

function standardize(trainRows, rows) {
  const dimensions = trainRows[0].x.length;
  const means = Array.from({ length: dimensions }, (_, column) => trainRows.reduce((sum, row) => sum + row.x[column], 0) / trainRows.length);
  const scales = means.map((mean, column) => {
    const variance = trainRows.reduce((sum, row) => sum + (row.x[column] - mean) ** 2, 0) / trainRows.length;
    return Math.sqrt(variance) || 1;
  });
  for (const row of rows) row.x = row.x.map((value, index) => (value - means[index]) / scales[index]);
  return { means, scales };
}

function trainLogisticRegression(rows) {
  const dimensions = rows[0].x.length;
  const weights = Array(dimensions).fill(0);
  let bias = 0;
  const rate = 0.08;
  const regularization = 0.002;
  for (let epoch = 0; epoch < 600; epoch += 1) {
    const gradient = Array(dimensions).fill(0);
    let biasGradient = 0;
    for (const row of rows) {
      const score = bias + row.x.reduce((sum, value, index) => sum + value * weights[index], 0);
      const probability = 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, score))));
      const error = probability - row.y;
      biasGradient += error;
      for (let index = 0; index < dimensions; index += 1) gradient[index] += error * row.x[index];
    }
    const scale = 1 / rows.length;
    bias -= rate * biasGradient * scale;
    for (let index = 0; index < dimensions; index += 1) weights[index] -= rate * (gradient[index] * scale + regularization * weights[index]);
  }
  return { type: 'standardized-logistic-regression', weights, bias };
}

function seededRandom(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6D2B79F5;
    let next = value;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

function trainTree(rows, indices, random, depth = 0) {
  const positive = indices.reduce((sum, index) => sum + rows[index].y, 0);
  const probability = positive / indices.length;
  if (depth >= 9 || indices.length < 24 || positive === 0 || positive === indices.length) return { p: probability };
  const featureCount = rows[0].x.length;
  const featurePool = Array.from({ length: featureCount }, (_, index) => index);
  for (let index = 0; index < 5; index += 1) {
    const swapIndex = index + Math.floor(random() * (featureCount - index));
    [featurePool[index], featurePool[swapIndex]] = [featurePool[swapIndex], featurePool[index]];
  }
  const parentImpurity = 2 * probability * (1 - probability);
  let best = null;
  for (const feature of featurePool.slice(0, 5)) {
    const sorted = indices.map((index) => rows[index].x[feature]).sort((a, b) => a - b);
    const cuts = new Set([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9].map((q) => sorted[Math.floor(q * (sorted.length - 1))]));
    for (const threshold of cuts) {
      const left = [];
      const right = [];
      let leftPositive = 0;
      let rightPositive = 0;
      for (const index of indices) {
        if (rows[index].x[feature] <= threshold) {
          left.push(index);
          leftPositive += rows[index].y;
        } else {
          right.push(index);
          rightPositive += rows[index].y;
        }
      }
      if (left.length < 12 || right.length < 12) continue;
      const leftP = leftPositive / left.length;
      const rightP = rightPositive / right.length;
      const impurity = (left.length * 2 * leftP * (1 - leftP) + right.length * 2 * rightP * (1 - rightP)) / indices.length;
      const gain = parentImpurity - impurity;
      if (!best || gain > best.gain) best = { feature, threshold, left, right, gain };
    }
  }
  if (!best || best.gain < 0.002) return { p: probability };
  return {
    feature: best.feature,
    threshold: best.threshold,
    left: trainTree(rows, best.left, random, depth + 1),
    right: trainTree(rows, best.right, random, depth + 1),
  };
}

function trainBalancedForest(rows) {
  const positiveRows = [];
  const negativeRows = [];
  rows.forEach((row, index) => (row.y ? positiveRows : negativeRows).push(index));
  const random = seededRandom(20261026);
  const trees = [];
  const sampleCount = Math.min(positiveRows.length, negativeRows.length);
  for (let treeIndex = 0; treeIndex < 48; treeIndex += 1) {
    const indices = [];
    for (let index = 0; index < sampleCount; index += 1) {
      indices.push(positiveRows[Math.floor(random() * positiveRows.length)]);
      indices.push(negativeRows[Math.floor(random() * negativeRows.length)]);
    }
    trees.push(trainTree(rows, indices, random));
  }
  return { type: 'balanced-random-forest', trees };
}

function score(row, model) {
  if (model.type === 'standardized-logistic-regression') {
    const value = model.bias + row.x.reduce((sum, feature, index) => sum + feature * model.weights[index], 0);
    return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, value))));
  }
  let total = 0;
  for (const tree of model.trees) {
    let node = tree;
    while (node.feature !== undefined) node = row.x[node.feature] <= node.threshold ? node.left : node.right;
    total += node.p;
  }
  return total / model.trees.length;
}

function assess(rows, model, threshold) {
  const counts = { truePositive: 0, falsePositive: 0, trueNegative: 0, falseNegative: 0 };
  const fallEvents = new Set(rows.filter((row) => row.y === 1).map((row) => row.eventId));
  const detectedFallEvents = new Set();
  const activityEvents = new Set(rows.filter((row) => row.activity.startsWith('D')).map((row) => row.eventId));
  const flaggedActivityEvents = new Set();
  for (const row of rows) {
    const predicted = score(row, model) >= threshold;
    if (predicted && row.y) { counts.truePositive += 1; detectedFallEvents.add(row.eventId); }
    else if (predicted) { counts.falsePositive += 1; if (row.activity.startsWith('D')) flaggedActivityEvents.add(row.eventId); }
    else if (row.y) counts.falseNegative += 1;
    else counts.trueNegative += 1;
  }
  const precision = counts.truePositive / Math.max(1, counts.truePositive + counts.falsePositive);
  const recall = counts.truePositive / Math.max(1, counts.truePositive + counts.falseNegative);
  return {
    windows: rows.length,
    fallSequenceWindows: counts.truePositive + counts.falseNegative,
    activityWindows: counts.trueNegative + counts.falsePositive,
    accuracy: (counts.truePositive + counts.trueNegative) / Math.max(1, rows.length),
    precision,
    recall,
    f1: 2 * precision * recall / Math.max(1e-12, precision + recall),
    f2: 5 * precision * recall / Math.max(1e-12, 4 * precision + recall),
    fallEventRecall: detectedFallEvents.size / Math.max(1, fallEvents.size),
    activityTrialFalseAlarmRate: flaggedActivityEvents.size / Math.max(1, activityEvents.size),
    fallEvents: fallEvents.size,
    activityTrials: activityEvents.size,
    confusion: counts,
  };
}

function assessOnlineCadence(rows, model, threshold) {
  const phases = Array.from({ length: ONLINE_CADENCE_WINDOWS }, (_, phase) => assess(
    rows.filter((row) => row.windowIndex % ONLINE_CADENCE_WINDOWS === phase), model, threshold,
  ));
  const average = (key) => phases.reduce((sum, result) => sum + result[key], 0) / phases.length;
  return {
    windowsPerCadencePhase: Math.round(average('windows')),
    accuracy: average('accuracy'),
    precision: average('precision'),
    recall: average('recall'),
    f1: average('f1'),
    f2: average('f2'),
    fallEventRecall: average('fallEventRecall'),
    activityTrialFalseAlarmRate: average('activityTrialFalseAlarmRate'),
    fallEvents: Math.round(average('fallEvents')),
    activityTrials: Math.round(average('activityTrials')),
    cadenceHz: 1 / (STRIDE_SECONDS * ONLINE_CADENCE_WINDOWS),
  };
}

function chooseThreshold(rows, model) {
  let best = { threshold: 0.5, evaluation: null };
  for (let threshold = 0.02; threshold <= 0.98; threshold += 0.01) {
    const evaluation = assessOnlineCadence(rows, model, threshold);
    if (evaluation.f2 > (best.evaluation?.f2 ?? -1)) best = { threshold, evaluation };
  }
  return best;
}

function main() {
  if (!fs.existsSync(sensorRoot)) throw new Error(`Extract WEDA-FALL first. Expected ${sensorRoot}`);
  if (!fs.existsSync(impactSensorRoot)) throw new Error(`The 50 Hz accelerometer files are required to estimate impact times. Expected ${impactSensorRoot}`);
  const collected = collectRows(loadFallIntervals());
  const rows = collected.rows;
  const developmentRows = rows.filter((row) => !HOLDOUT_USERS.has(row.userId));
  const fitRows = developmentRows.filter((row) => !VALIDATION_USERS.has(row.userId));
  const validationRows = developmentRows.filter((row) => VALIDATION_USERS.has(row.userId));
  const testRows = rows.filter((row) => HOLDOUT_USERS.has(row.userId));
  if (!fitRows.length || !validationRows.length || !testRows.length) throw new Error('Could not form train, validation, and held-out participant sets.');

  const validationFit = fitRows.map((row) => ({ ...row, x: [...row.x] }));
  const validation = validationRows.map((row) => ({ ...row, x: [...row.x] }));
  const validationResults = [];
  for (const type of ['standardized-logistic-regression', 'balanced-random-forest']) {
    const validationTraining = validationFit.map((row) => ({ ...row, x: [...row.x] }));
    const validationEvaluation = validation.map((row) => ({ ...row, x: [...row.x] }));
    if (type === 'standardized-logistic-regression') standardize(validationTraining, [...validationTraining, ...validationEvaluation]);
    const validationModel = type === 'standardized-logistic-regression' ? trainLogisticRegression(validationTraining) : trainBalancedForest(validationTraining);
    const tuned = chooseThreshold(validationEvaluation, validationModel);

    const trainRows = developmentRows.map((row) => ({ ...row, x: [...row.x] }));
    const finalTestRows = testRows.map((row) => ({ ...row, x: [...row.x] }));
    const scaling = type === 'standardized-logistic-regression' ? standardize(trainRows, [...trainRows, ...finalTestRows]) : null;
    const model = type === 'standardized-logistic-regression' ? trainLogisticRegression(trainRows) : trainBalancedForest(trainRows);
    const metrics = assessOnlineCadence(finalTestRows, model, tuned.threshold);
    validationResults.push({ type, tuned, model, metrics, scaling });
  }
  validationResults.sort((left, right) => right.tuned.evaluation.f2 - left.tuned.evaluation.f2);
  const selected = validationResults[0];
  const { tuned, model, metrics } = selected;
  const artifact = {
    modelType: model.type,
    dataset: 'WEDA-FALL wrist accelerometer; 50 Hz peak-derived impact proxy with 10 Hz model inputs',
    source: 'https://github.com/joaojtmarques/WEDA-FALL',
    labels: { 0: 'no impact in prediction horizon', 1: `impact proxy in ${EARLIEST_IMPACT_LEAD_SECONDS}-${LATEST_IMPACT_LEAD_SECONDS} seconds` },
    input: { windowSeconds: WINDOW_SECONDS, trainingStrideSeconds: STRIDE_SECONDS, liveInferenceCadenceHz: 1 / (STRIDE_SECONDS * ONLINE_CADENCE_WINDOWS), predictionLeadSeconds: { minimum: EARLIEST_IMPACT_LEAD_SECONDS, maximum: LATEST_IMPACT_LEAD_SECONDS }, sampleRateHz: 10, axes: ['x', 'y', 'z'], accelerationUnit: 'g', featureCount: rows[0].x.length },
    impactProxy: {
      method: 'Within each manually timed fall interval, take the 50 Hz sample with the highest acceleration magnitude; retain peaks at or above 2 g.',
      includedFallTrials: collected.impactLags.length,
      excludedFallTrials: collected.excludedFalls,
      peakLeadFromAnnotatedFallStartSeconds: { minimum: Math.min(...collected.impactLags), median: collected.impactLags.slice().sort((a, b) => a - b)[Math.floor(collected.impactLags.length / 2)], maximum: Math.max(...collected.impactLags) },
      manuallyVerifiedAgainstVideo: false,
    },
    preprocessing: { featureMeans: selected.scaling?.means || null, featureScales: selected.scaling?.scales || null, gravityMetersPerSecondSquared: GRAVITY },
    ...(model.type === 'standardized-logistic-regression' ? { weights: model.weights, bias: model.bias } : { trees: model.trees }),
    scoreThreshold: tuned.threshold,
    validationParticipants: [...VALIDATION_USERS],
    heldOutParticipants: [...HOLDOUT_USERS],
    validation: tuned.evaluation,
    evaluation: metrics,
    limitations: 'Experimental pre-impact classifier: impact time is estimated from the largest 50 Hz acceleration magnitude inside each manually annotated WEDA-FALL fall interval, not verified against video. Fall simulations were onto mattresses. Test results are on held-out subjects from the same dataset; this is not a validated safety system and does not predict long-term fall risk.',
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(JSON.stringify({ trainingWindows: developmentRows.length, trainingPositiveWindows: developmentRows.filter((row) => row.y).length, derivedImpactTrials: collected.impactLags.length, excludedImpactTrials: collected.excludedFalls, impactProxyLagMedianSeconds: artifact.impactProxy.peakLeadFromAnnotatedFallStartSeconds.median, candidates: validationResults.map((candidate) => ({ model: candidate.type, validation: candidate.tuned.evaluation, heldOutTest: candidate.metrics })), selectedBy: 'highest subject-held-out validation F2 at simulated live cadence', selectedModel: model.type, validationThreshold: tuned.threshold, heldOutParticipants: [...HOLDOUT_USERS], modelPath: path.relative(projectRoot, outputPath) }, null, 2));
}

main();

