const fs = require('node:fs');
const path = require('node:path');

const MODEL_PATH = path.join(__dirname, 'models', 'weda-fall-accelerometer.json');
const GRAVITY = 9.80665;

function loadModel() {
  try {
    const model = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf8'));
    const randomForest = model.modelType === 'balanced-random-forest' && Array.isArray(model.trees);
    const logistic = model.modelType === 'standardized-logistic-regression' && Array.isArray(model.weights);
    return randomForest || logistic ? model : null;
  } catch {
    return null;
  }
}

function makeFeatures(samples, unit) {
  const ordered = samples.slice().sort((left, right) => left.time - right.time);
  if (ordered.length < 8) return null;
  const start = ordered.at(-1).time - 1400;
  const uniform = [];
  let right = 0;
  for (let index = 0; index < 15; index += 1) {
    const target = start + (index + 1) * 100;
    while (right < ordered.length && ordered[right].time < target) right += 1;
    const after = ordered[right];
    const before = ordered[right - 1];
    if (!after || !before || after.time - before.time > 450 || target < before.time || target > after.time) return null;
    const ratio = (target - before.time) / Math.max(1, after.time - before.time);
    uniform.push({
      x: before.x + (after.x - before.x) * ratio,
      y: before.y + (after.y - before.y) * ratio,
      z: before.z + (after.z - before.z) * ratio,
    });
  }
  const divisor = unit === 'm/s2' ? GRAVITY : 1;
  const axes = [0, 1, 2].map((axis) => uniform.map((sample) => sample[['x', 'y', 'z'][axis]] / divisor));
  const magnitudes = uniform.map((sample) => Math.hypot(sample.x / divisor, sample.y / divisor, sample.z / divisor));
  const features = [];
  for (const values of axes) {
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
    features.push(mean, Math.sqrt(variance), Math.min(...values), Math.max(...values));
  }
  const mean = magnitudes.reduce((sum, value) => sum + value, 0) / magnitudes.length;
  const variance = magnitudes.reduce((sum, value) => sum + (value - mean) ** 2, 0) / magnitudes.length;
  let jerkEnergy = 0;
  for (let index = 1; index < magnitudes.length; index += 1) jerkEnergy += ((magnitudes[index] - magnitudes[index - 1]) * 10) ** 2;
  features.push(mean, Math.sqrt(variance), Math.min(...magnitudes), Math.max(...magnitudes), Math.sqrt(jerkEnergy / Math.max(1, magnitudes.length - 1)));
  for (const values of axes) features.push(...values);
  return features;
}

function scoreTree(features, root) {
  let node = root;
  while (node.feature !== undefined) node = features[node.feature] <= node.threshold ? node.left : node.right;
  return node.p;
}

function predictWindow(samples, unit, model) {
  if (!model || !Array.isArray(samples) || samples.length < 8) return null;
  const features = makeFeatures(samples, unit);
  if (!features) return { state: 'sampling_gap', message: 'The motion samples contain a gap too large for a reliable window.' };
  let score;
  if (model.modelType === 'standardized-logistic-regression') {
    const normalized = features.map((value, index) => (value - model.preprocessing.featureMeans[index]) / model.preprocessing.featureScales[index]);
    const value = model.bias + normalized.reduce((sum, feature, index) => sum + feature * model.weights[index], 0);
    score = 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, value))));
  } else {
    score = model.trees.reduce((sum, tree) => sum + scoreTree(features, tree), 0) / model.trees.length;
  }
  const threshold = Number(model.scoreThreshold) || 0.41;
  return {
    state: 'analyzed',
    label: score >= threshold ? 'fall_predicted' : 'no_fall_predicted',
    score: Number(score.toFixed(4)),
    threshold,
    sampleCount: samples.length,
    windowSeconds: model.input.windowSeconds,
    predictionLeadSeconds: model.input.predictionLeadSeconds,
    model: model.modelType,
    modelVersion: 'weda-fall-10hz-v1',
    observedAt: new Date(),
  };
}

module.exports = { loadModel, predictWindow, MODEL_PATH };
