/**
 * Statistical utilities for the Traffic Intelligence Framework.
 *
 * Implements lightweight versions of the statistical tests we need
 * without pulling in heavy external dependencies. This keeps the
 * framework self-contained and auditable.
 */

/**
 * Standard normal CDF approximation (Abramowitz & Stegun).
 * Accurate to ~1e-7 for the range we care about.
 */
export function normalCdf(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.sqrt(2);

  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

  return 0.5 * (1.0 + sign * y);
}

/**
 * Two-proportion z-test.
 * Tests whether two proportions (p1 = x1/n1, p2 = x2/n2) differ significantly.
 */
export function twoProportionZTest(
  x1: number, n1: number,
  x2: number, n2: number,
): { zStat: number; pValue: number } {
  const p1 = x1 / n1;
  const p2 = x2 / n2;
  const pPooled = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(pPooled * (1 - pPooled) * (1 / n1 + 1 / n2));

  if (se === 0) return { zStat: 0, pValue: 1 };

  const zStat = (p1 - p2) / se;
  const pValue = 2 * (1 - normalCdf(Math.abs(zStat)));

  return { zStat, pValue };
}

/**
 * Wilson score confidence interval for a proportion.
 * More robust than normal approximation for small samples / extreme proportions.
 */
export function wilsonInterval(
  successes: number,
  total: number,
  confidence: number = 0.95,
): [number, number] {
  if (total === 0) return [0, 1];

  const z = confidence === 0.95 ? 1.96 : confidence === 0.99 ? 2.576 : 1.645;
  const pHat = successes / total;
  const denominator = 1 + z * z / total;
  const centre = pHat + z * z / (2 * total);
  const margin = z * Math.sqrt((pHat * (1 - pHat) + z * z / (4 * total)) / total);

  return [
    Math.max(0, (centre - margin) / denominator),
    Math.min(1, (centre + margin) / denominator),
  ];
}

/**
 * Shannon entropy of a probability distribution.
 * Returns value in bits. Higher entropy = more uniform = less predictable.
 */
export function shannonEntropy(probabilities: number[]): number {
  return -probabilities
    .filter((p) => p > 0)
    .reduce((sum, p) => sum + p * Math.log2(p), 0);
}

/**
 * Normalized Shannon entropy (0-1 scale).
 * 1 = perfectly uniform, 0 = all mass on one outcome.
 */
export function normalizedEntropy(counts: number[]): number {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0 || counts.length <= 1) return 0;

  const probs = counts.map((c) => c / total);
  const maxEntropy = Math.log2(counts.length);
  if (maxEntropy === 0) return 0;

  return shannonEntropy(probs) / maxEntropy;
}

/**
 * Coefficient of variation (std / mean).
 * Measures relative variability. High CV in click timing = more human-like.
 */
export function coefficientOfVariation(values: number[]): number {
  if (values.length < 2) return 0;

  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean === 0) return 0;

  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance) / mean;
}

/**
 * Sample from a Beta distribution using the Jöhnk algorithm.
 * Used for Thompson Sampling in traffic allocation.
 */
export function sampleBeta(alpha: number, beta: number): number {
  if (alpha <= 0 || beta <= 0) return 0.5;

  const gammaA = sampleGamma(alpha);
  const gammaB = sampleGamma(beta);
  const sum = gammaA + gammaB;

  return sum === 0 ? 0.5 : gammaA / sum;
}

/**
 * Sample from Gamma distribution using Marsaglia & Tsang's method.
 */
function sampleGamma(shape: number): number {
  if (shape < 1) {
    return sampleGamma(shape + 1) * Math.pow(Math.random(), 1 / shape);
  }

  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);

  while (true) {
    let x: number;
    let v: number;

    do {
      x = randomNormal();
      v = 1 + c * x;
    } while (v <= 0);

    v = v * v * v;
    const u = Math.random();

    if (u < 1 - 0.0331 * (x * x) * (x * x)) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/** Box-Muller transform for standard normal samples */
function randomNormal(): number {
  const u1 = Math.random();
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Mean of Beta distribution. Used as point estimate for vendor quality.
 */
export function betaMean(alpha: number, beta: number): number {
  return alpha / (alpha + beta);
}

/**
 * Variance of Beta distribution. Used to assess confidence.
 */
export function betaVariance(alpha: number, beta: number): number {
  return (alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1));
}

/**
 * Clamp a value to [min, max].
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
