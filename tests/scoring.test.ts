import { VendorScorer } from '../src/scoring/VendorScorer';
import { FraudDetector } from '../src/scoring/FraudDetector';
import { EngagementProxy } from '../src/scoring/EngagementProxy';
import { QualitySignals } from '../src/types';

function makeSignals(overrides: Partial<QualitySignals> = {}): QualitySignals {
  return {
    vendorId: 'vendor-1',
    campaignId: 'campaign-1',
    windowStart: new Date('2026-03-01'),
    windowEnd: new Date('2026-03-02'),
    totalClicks: 500,
    botRate: 0.02,
    ipConcentrationRate: 0.10,
    ipDiversityRatio: 0.90,
    geoMatchRate: 0.85,
    temporalEntropy: 0.70,
    deviceDiversityScore: 0.65,
    avgRedirectLatencyMs: 350,
    suspiciouslyFastRate: 0.02,
    clickTimingVariance: 1.2,
    ...overrides,
  };
}

describe('VendorScorer', () => {
  let scorer: VendorScorer;

  beforeEach(() => {
    scorer = new VendorScorer();
  });

  it('should produce a high composite score for premium traffic signals', () => {
    const signals = makeSignals();
    const score = scorer.scoreVendor(signals);

    expect(score.compositeScore).toBeGreaterThan(65);
    expect(score.engagementScore).toBeGreaterThan(60);
    expect(score.fraudRiskScore).toBeLessThan(30);
    expect(score.confidence).toBeGreaterThan(0.5);
  });

  it('should produce a low composite score for fraudulent traffic signals', () => {
    const signals = makeSignals({
      botRate: 0.50,
      ipDiversityRatio: 0.10,
      ipConcentrationRate: 0.60,
      geoMatchRate: 0.05,
      temporalEntropy: 0.98,
      suspiciouslyFastRate: 0.40,
      avgRedirectLatencyMs: 30,
      clickTimingVariance: 0.05,
    });
    const score = scorer.scoreVendor(signals);

    expect(score.compositeScore).toBeLessThan(40);
    expect(score.fraudRiskScore).toBeGreaterThan(50);
  });

  it('should update Bayesian posteriors when previous score exists', () => {
    const signals = makeSignals();
    const first = scorer.scoreVendor(signals);
    const second = scorer.scoreVendor(signals, first);

    expect(second.alpha).toBeGreaterThan(first.alpha);
    expect(second.sampleSize).toBe(first.sampleSize + signals.totalClicks);
  });

  it('should rank premium vendors above low-quality vendors', () => {
    const premium = scorer.scoreVendor(makeSignals());
    const low = scorer.scoreVendor(makeSignals({
      botRate: 0.30,
      geoMatchRate: 0.15,
      ipDiversityRatio: 0.20,
      suspiciouslyFastRate: 0.30,
    }));

    const ranked = scorer.rankVendors([low, premium]);
    expect(ranked[0].vendorId).toBe(premium.vendorId);
  });

  it('should identify top 20% correctly', () => {
    const scores = Array.from({ length: 10 }, (_, i) => {
      const signals = makeSignals({
        vendorId: `vendor-${i}`,
        geoMatchRate: 0.1 + i * 0.09,
      });
      return scorer.scoreVendor(signals);
    });

    const topTier = scorer.getTopTier(scores, 0.20);
    expect(topTier.length).toBe(2);
    expect(topTier[0].compositeScore).toBeGreaterThanOrEqual(topTier[1].compositeScore);
  });
});

describe('FraudDetector', () => {
  let detector: FraudDetector;

  beforeEach(() => {
    detector = new FraudDetector();
  });

  it('should assign low fraud risk to clean traffic', () => {
    const signals = makeSignals();
    const risk = detector.computeFraudRisk(signals);
    expect(risk).toBeLessThan(30);
  });

  it('should assign high fraud risk to bot-heavy traffic', () => {
    const signals = makeSignals({
      botRate: 0.50,
      suspiciouslyFastRate: 0.40,
      ipConcentrationRate: 0.60,
      ipDiversityRatio: 0.10,
      temporalEntropy: 0.98,
      clickTimingVariance: 0.05,
    });
    const risk = detector.computeFraudRisk(signals);
    expect(risk).toBeGreaterThan(50);
  });

  it('should return 0 for empty signals', () => {
    const signals = makeSignals({ totalClicks: 0 });
    const risk = detector.computeFraudRisk(signals);
    expect(risk).toBe(0);
  });
});

describe('EngagementProxy', () => {
  let proxy: EngagementProxy;

  beforeEach(() => {
    proxy = new EngagementProxy();
  });

  it('should score high for signals indicating genuine engagement', () => {
    const signals = makeSignals();
    const result = proxy.computeEngagementScore(signals);

    expect(result.score).toBeGreaterThan(60);
    expect(result.confidence).toBeGreaterThan(0.5);
    expect(result.dimensions.geoRelevance).toBeGreaterThan(50);
  });

  it('should score low for signals indicating fake traffic', () => {
    const signals = makeSignals({
      geoMatchRate: 0.05,
      ipDiversityRatio: 0.10,
      avgRedirectLatencyMs: 20,
      suspiciouslyFastRate: 0.50,
      clickTimingVariance: 0.05,
    });
    const result = proxy.computeEngagementScore(signals);

    expect(result.score).toBeLessThan(40);
  });

  it('should return 0 score and 0 confidence for empty signals', () => {
    const signals = makeSignals({ totalClicks: 0 });
    const result = proxy.computeEngagementScore(signals);

    expect(result.score).toBe(0);
    expect(result.confidence).toBe(0);
  });
});
