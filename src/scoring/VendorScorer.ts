import { QualitySignals, VendorScore, ScoreBreakdown } from '../types';
import { FraudDetector } from './FraudDetector';
import { EngagementProxy } from './EngagementProxy';
import { betaMean, clamp } from '../utils/statistics';

/**
 * VendorScorer maintains a Bayesian quality model for each traffic vendor.
 *
 * Design rationale: We use a Beta-Binomial model because it naturally handles
 * the key challenges of this domain:
 *
 * 1. Uncertainty with small samples — new vendors start with a wide prior
 *    (alpha=2, beta=2) that expresses "we don't know yet." As we observe
 *    traffic, the posterior tightens around the true quality.
 *
 * 2. Continuous updating — as vendor behavior changes (which the brief
 *    explicitly warns about), our posterior adapts. We use a decay factor
 *    to down-weight old observations, ensuring the model tracks changes.
 *
 * 3. Natural ranking — the posterior mean provides a principled way to
 *    rank vendors that accounts for both observed quality AND certainty.
 *    A vendor with 50 great clicks ranks below one with 5000 great clicks,
 *    even if the small-sample vendor has a higher raw score.
 *
 * The composite score combines engagement proxy, fraud risk, and consistency
 * into a single actionable metric.
 */
export class VendorScorer {
  private fraudDetector: FraudDetector;
  private engagementProxy: EngagementProxy;

  /** Prior parameters — weak prior expressing initial ignorance */
  private readonly priorAlpha = 2;
  private readonly priorBeta = 2;

  /** Decay factor for old observations (per scoring cycle) */
  private readonly decayFactor = 0.95;

  /** Weight of each component in the composite score */
  private readonly compositeWeights = {
    engagement: 0.50,
    fraudPenalty: 0.30,
    consistency: 0.20,
  };

  constructor() {
    this.fraudDetector = new FraudDetector();
    this.engagementProxy = new EngagementProxy();
  }

  /**
   * Score a vendor based on their latest quality signals.
   * If a previous score exists, we update the Bayesian posterior.
   */
  scoreVendor(
    signals: QualitySignals,
    previousScore?: VendorScore,
  ): VendorScore {
    const engagementResult = this.engagementProxy.computeEngagementScore(signals);
    const fraudRiskScore = this.fraudDetector.computeFraudRisk(signals);

    const breakdown = this.computeBreakdown(signals, engagementResult.score, fraudRiskScore);

    // Update Bayesian posterior
    let alpha: number;
    let beta: number;

    if (previousScore) {
      // Decay old observations to allow adaptation to behavior changes
      alpha = previousScore.alpha * this.decayFactor;
      beta = previousScore.beta * this.decayFactor;
    } else {
      alpha = this.priorAlpha;
      beta = this.priorBeta;
    }

    // Treat engagement score as a "success rate" — high engagement adds to alpha
    const effectiveSuccesses = (engagementResult.score / 100) * signals.totalClicks;
    const effectiveFailures = signals.totalClicks - effectiveSuccesses;

    // Scale updates to prevent any single batch from dominating
    const batchScale = Math.min(1, 100 / signals.totalClicks);
    alpha += effectiveSuccesses * batchScale;
    beta += effectiveFailures * batchScale;

    const consistencyScore = this.computeConsistency(previousScore, engagementResult.score);

    const compositeScore = this.computeComposite(
      engagementResult.score,
      fraudRiskScore,
      consistencyScore,
    );

    const sampleSize = (previousScore?.sampleSize || 0) + signals.totalClicks;
    const confidence = clamp(Math.log10(Math.max(1, sampleSize)) / 3, 0, 1);

    return {
      vendorId: signals.vendorId,
      timestamp: new Date(),
      engagementScore: engagementResult.score,
      fraudRiskScore,
      consistencyScore,
      compositeScore,
      confidence,
      sampleSize,
      alpha,
      beta,
      breakdown,
    };
  }

  /**
   * Get the Bayesian quality estimate for a vendor.
   * This is the posterior mean of the Beta distribution.
   */
  getQualityEstimate(score: VendorScore): number {
    return betaMean(score.alpha, score.beta) * 100;
  }

  /**
   * Rank multiple vendors by their composite scores, weighted by confidence.
   * Returns vendor IDs sorted best-to-worst.
   */
  rankVendors(scores: VendorScore[]): VendorScore[] {
    return [...scores].sort((a, b) => {
      const aWeighted = a.compositeScore * a.confidence;
      const bWeighted = b.compositeScore * b.confidence;
      return bWeighted - aWeighted;
    });
  }

  /**
   * Identify the top N% of vendors by quality.
   */
  getTopTier(scores: VendorScore[], percentile: number = 0.20): VendorScore[] {
    const ranked = this.rankVendors(scores);
    const count = Math.max(1, Math.ceil(ranked.length * percentile));
    return ranked.slice(0, count);
  }

  private computeBreakdown(
    signals: QualitySignals,
    engagementScore: number,
    fraudRiskScore: number,
  ): ScoreBreakdown {
    return {
      geoRelevance: clamp(Math.round(signals.geoMatchRate * 100), 0, 100),
      deviceDistribution: clamp(Math.round(signals.deviceDiversityScore * 100), 0, 100),
      temporalPattern: clamp(
        Math.round((1 - Math.abs(signals.temporalEntropy - 0.7) / 0.3) * 100),
        0,
        100,
      ),
      ipQuality: clamp(Math.round(signals.ipDiversityRatio * 100), 0, 100),
      latencyProfile: clamp(
        Math.round(
          ((signals.avgRedirectLatencyMs > 150 && signals.avgRedirectLatencyMs < 1000 ? 80 : 40) +
            (1 - signals.suspiciouslyFastRate) * 20),
        ),
        0,
        100,
      ),
      botRisk: clamp(100 - fraudRiskScore, 0, 100),
    };
  }

  /**
   * Consistency: how stable has this vendor's quality been?
   * Large swings between scoring cycles reduce confidence.
   */
  private computeConsistency(
    previousScore: VendorScore | undefined,
    currentEngagement: number,
  ): number {
    if (!previousScore) return 70; // neutral initial consistency

    const delta = Math.abs(currentEngagement - previousScore.engagementScore);
    if (delta < 5) return 95;
    if (delta < 10) return 85;
    if (delta < 20) return 65;
    if (delta < 30) return 45;
    return 25;
  }

  private computeComposite(
    engagement: number,
    fraudRisk: number,
    consistency: number,
  ): number {
    const w = this.compositeWeights;
    const score =
      engagement * w.engagement +
      (100 - fraudRisk) * w.fraudPenalty +
      consistency * w.consistency;

    return clamp(Math.round(score), 0, 100);
  }
}
