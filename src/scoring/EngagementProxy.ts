import { QualitySignals } from '../types';
import { clamp } from '../utils/statistics';

/**
 * EngagementProxy computes a proxy engagement score when direct
 * conversion data is unavailable.
 *
 * Core insight: we cannot see if a visitor fills out a lead form,
 * but we CAN evaluate whether the traffic LOOKS like it comes from
 * real humans who would plausibly engage with an automotive VDP.
 *
 * Proxy engagement is built from five dimensions:
 *
 * 1. Geographic relevance — does the visitor's location match the
 *    dealership's market area? Out-of-geo traffic rarely converts.
 *
 * 2. Device profile — automotive shoppers overwhelmingly use mobile
 *    devices. A realistic device mix signals genuine consumer traffic.
 *
 * 3. Behavioral authenticity — human click patterns have natural
 *    variance in timing and latency. Uniform patterns suggest automation.
 *
 * 4. IP quality — diverse, non-repeating IPs from residential ranges
 *    correlate with genuine consumer sessions.
 *
 * 5. Latency profile — real users on real devices have measurable
 *    network latency. Near-zero latency indicates server-to-server traffic.
 */
export class EngagementProxy {
  private readonly dimensionWeights = {
    geoRelevance: 0.30,
    deviceProfile: 0.15,
    behavioralAuthenticity: 0.20,
    ipQuality: 0.20,
    latencyProfile: 0.15,
  };

  /**
   * Compute engagement proxy score (0-100) from quality signals.
   * Higher = more likely to produce genuine engagement on landing pages.
   */
  computeEngagementScore(signals: QualitySignals): EngagementResult {
    if (signals.totalClicks === 0) {
      return { score: 0, dimensions: this.zeroDimensions(), confidence: 0 };
    }

    const dimensions = {
      geoRelevance: this.scoreGeoRelevance(signals.geoMatchRate),
      deviceProfile: this.scoreDeviceProfile(signals.deviceDiversityScore),
      behavioralAuthenticity: this.scoreBehavioralAuthenticity(
        signals.temporalEntropy,
        signals.clickTimingVariance,
      ),
      ipQuality: this.scoreIpQuality(
        signals.ipDiversityRatio,
        signals.ipConcentrationRate,
      ),
      latencyProfile: this.scoreLatencyProfile(
        signals.avgRedirectLatencyMs,
        signals.suspiciouslyFastRate,
      ),
    };

    let weighted = 0;
    for (const [key, weight] of Object.entries(this.dimensionWeights)) {
      weighted += (dimensions[key as keyof typeof dimensions] || 0) * weight;
    }

    const confidence = this.computeConfidence(signals.totalClicks);

    return {
      score: clamp(Math.round(weighted), 0, 100),
      dimensions,
      confidence,
    };
  }

  /**
   * Geo relevance: traffic from the target market area is exponentially
   * more valuable than out-of-area traffic for automotive lead gen.
   */
  private scoreGeoRelevance(geoMatchRate: number): number {
    return clamp(Math.round(geoMatchRate * 100), 0, 100);
  }

  /**
   * Device profile: a healthy automotive audience is ~60% mobile,
   * ~30% desktop, ~10% tablet. We score based on diversity.
   *
   * Pure desktop or pure mobile traffic is less suspicious than
   * zero diversity (all one type) but still gets penalized slightly.
   */
  private scoreDeviceProfile(diversityScore: number): number {
    if (diversityScore >= 0.6 && diversityScore <= 0.9) return 95;
    if (diversityScore >= 0.4) return 80;
    if (diversityScore >= 0.2) return 50;
    return 20;
  }

  /**
   * Behavioral authenticity: real humans produce irregular click patterns.
   * We want moderate temporal entropy (not too uniform, not too concentrated)
   * and high click timing variance.
   */
  private scoreBehavioralAuthenticity(
    temporalEntropy: number,
    clickTimingVariance: number,
  ): number {
    let score = 50;

    // Temporal pattern: moderate entropy is ideal (0.5-0.8)
    if (temporalEntropy >= 0.5 && temporalEntropy <= 0.85) {
      score += 25;
    } else if (temporalEntropy > 0.85) {
      score -= 15; // too uniform = suspicious
    } else if (temporalEntropy < 0.3) {
      score -= 10; // too concentrated = burst traffic
    }

    // Click timing variance: higher is more human-like
    if (clickTimingVariance > 1.0) {
      score += 25;
    } else if (clickTimingVariance > 0.5) {
      score += 15;
    } else if (clickTimingVariance < 0.2) {
      score -= 20; // very regular = automated
    }

    return clamp(score, 0, 100);
  }

  /**
   * IP quality: high diversity (many unique IPs) and low concentration
   * (no IP dominates) indicates a broad, genuine audience.
   */
  private scoreIpQuality(
    ipDiversityRatio: number,
    ipConcentrationRate: number,
  ): number {
    const diversityScore = ipDiversityRatio * 60;
    const concentrationPenalty = ipConcentrationRate * 40;

    return clamp(Math.round(diversityScore + (40 - concentrationPenalty)), 0, 100);
  }

  /**
   * Latency profile: genuine user clicks go through real network hops.
   * Average latency of 200-800ms is normal. Very low latency or very
   * high rates of sub-100ms clicks indicate server-side traffic.
   */
  private scoreLatencyProfile(
    avgLatencyMs: number,
    suspiciouslyFastRate: number,
  ): number {
    let score = 50;

    if (avgLatencyMs >= 150 && avgLatencyMs <= 1000) {
      score += 30;
    } else if (avgLatencyMs < 100) {
      score -= 30;
    } else if (avgLatencyMs > 2000) {
      score -= 10; // very slow could indicate VPN/proxy chains
    }

    score -= suspiciouslyFastRate * 40;

    return clamp(Math.round(score), 0, 100);
  }

  /**
   * Confidence increases with sample size, following a log curve
   * that saturates around 1000 clicks.
   */
  private computeConfidence(sampleSize: number): number {
    if (sampleSize === 0) return 0;
    return clamp(Math.log10(sampleSize) / 3, 0, 1);
  }

  private zeroDimensions() {
    return {
      geoRelevance: 0,
      deviceProfile: 0,
      behavioralAuthenticity: 0,
      ipQuality: 0,
      latencyProfile: 0,
    };
  }
}

export interface EngagementResult {
  score: number;
  dimensions: {
    geoRelevance: number;
    deviceProfile: number;
    behavioralAuthenticity: number;
    ipQuality: number;
    latencyProfile: number;
  };
  confidence: number;
}
