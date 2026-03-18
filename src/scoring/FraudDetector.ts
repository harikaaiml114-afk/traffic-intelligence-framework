import { QualitySignals, TrafficEvent } from '../types';
import { clamp } from '../utils/statistics';

/**
 * FraudDetector evaluates traffic for signs of non-human or fraudulent activity.
 *
 * Since we can't inspect landing page behavior, we rely on pre-click signals
 * that correlate with fraudulent traffic:
 *
 * 1. Known bot user-agent signatures
 * 2. Suspiciously low redirect latency (< 100ms suggests automated clicking)
 * 3. Low IP diversity (traffic funneled through few IPs = proxy/botnet)
 * 4. Unnaturally uniform temporal distribution (bots don't follow human rhythms)
 * 5. Low click timing variance (regular intervals = automated)
 * 6. High IP concentration (same IPs hitting repeatedly)
 *
 * The fraud risk score is a weighted composite of these signals, normalized to 0-100.
 */
export class FraudDetector {
  private readonly weights = {
    botSignature: 0.25,
    fastClicks: 0.20,
    ipConcentration: 0.15,
    lowIpDiversity: 0.15,
    uniformTiming: 0.10,
    lowClickVariance: 0.10,
    abnormalDeviceMix: 0.05,
  };

  /**
   * Compute fraud risk score from aggregate quality signals.
   * Returns 0-100 where higher = more likely fraudulent.
   */
  computeFraudRisk(signals: QualitySignals): number {
    if (signals.totalClicks === 0) return 0;

    const scores = {
      botSignature: signals.botRate * 100,
      fastClicks: signals.suspiciouslyFastRate * 100,
      ipConcentration: signals.ipConcentrationRate * 100,
      lowIpDiversity: (1 - signals.ipDiversityRatio) * 100,
      uniformTiming: this.uniformTimingScore(signals.temporalEntropy),
      lowClickVariance: this.lowVarianceScore(signals.clickTimingVariance),
      abnormalDeviceMix: this.abnormalDeviceScore(signals.deviceDiversityScore),
    };

    let weighted = 0;
    for (const [key, weight] of Object.entries(this.weights)) {
      weighted += (scores[key as keyof typeof scores] || 0) * weight;
    }

    return clamp(Math.round(weighted), 0, 100);
  }

  /**
   * Run detailed fraud analysis on raw events for a vendor.
   * Returns individual fraud indicators for deeper investigation.
   */
  analyzeEvents(events: TrafficEvent[]): FraudAnalysis {
    if (events.length === 0) {
      return {
        totalEvents: 0,
        knownBots: 0,
        suspiciousFastClicks: 0,
        rapidFireClusters: 0,
        topIpConcentration: 0,
        datacenterIpEstimate: 0,
        overallRisk: 'low',
      };
    }

    const knownBots = events.filter((e) => e.knownBotSignature).length;
    const suspiciousFastClicks = events.filter((e) => e.redirectLatencyMs < 100).length;
    const rapidFireClusters = this.detectRapidFireClusters(events);
    const topIpConcentration = this.topIpConcentration(events);
    const datacenterIpEstimate = this.estimateDatacenterTraffic(events);

    const riskScore =
      (knownBots / events.length) * 30 +
      (suspiciousFastClicks / events.length) * 25 +
      (rapidFireClusters / events.length) * 20 +
      topIpConcentration * 15 +
      datacenterIpEstimate * 10;

    const overallRisk: RiskLevel =
      riskScore > 50 ? 'critical' : riskScore > 30 ? 'high' : riskScore > 15 ? 'medium' : 'low';

    return {
      totalEvents: events.length,
      knownBots,
      suspiciousFastClicks,
      rapidFireClusters,
      topIpConcentration,
      datacenterIpEstimate,
      overallRisk,
    };
  }

  /**
   * Detect clusters of rapid-fire clicks from the same IP.
   * Genuine users don't click 10 times in 2 seconds.
   */
  private detectRapidFireClusters(events: TrafficEvent[]): number {
    const byIp = new Map<string, number[]>();
    for (const e of events) {
      const timestamps = byIp.get(e.ip) || [];
      timestamps.push(e.timestamp.getTime());
      byIp.set(e.ip, timestamps);
    }

    let clusterCount = 0;
    for (const timestamps of byIp.values()) {
      if (timestamps.length < 3) continue;
      timestamps.sort((a, b) => a - b);

      for (let i = 0; i < timestamps.length - 2; i++) {
        if (timestamps[i + 2] - timestamps[i] < 5000) {
          clusterCount++;
        }
      }
    }

    return clusterCount;
  }

  /**
   * What fraction of traffic comes from the top 5 IPs?
   * High concentration suggests bot farms or proxy abuse.
   */
  private topIpConcentration(events: TrafficEvent[]): number {
    const ipCounts = new Map<string, number>();
    for (const e of events) {
      ipCounts.set(e.ip, (ipCounts.get(e.ip) || 0) + 1);
    }

    const sorted = Array.from(ipCounts.values()).sort((a, b) => b - a);
    const topN = sorted.slice(0, 5).reduce((a, b) => a + b, 0);

    return topN / events.length;
  }

  /**
   * Heuristic: IPs with suspiciously fast and uniform latency patterns
   * are likely datacenter/hosting provider IPs, not real users.
   */
  private estimateDatacenterTraffic(events: TrafficEvent[]): number {
    const suspicious = events.filter(
      (e) => e.redirectLatencyMs < 50 && !e.knownBotSignature,
    ).length;
    return suspicious / events.length;
  }

  /**
   * Very high temporal entropy (near-uniform distribution across hours)
   * is suspicious — real traffic has peaks during waking/business hours.
   */
  private uniformTimingScore(entropy: number): number {
    if (entropy > 0.95) return 80;
    if (entropy > 0.90) return 50;
    if (entropy > 0.80) return 20;
    return 0;
  }

  /**
   * Low coefficient of variation in inter-click timing is suspicious.
   * Humans are irregular; bots are clockwork.
   */
  private lowVarianceScore(cv: number): number {
    if (cv < 0.1) return 90;
    if (cv < 0.3) return 60;
    if (cv < 0.5) return 30;
    return 0;
  }

  /**
   * Extreme skew in device distribution (e.g., 100% desktop) is suspicious
   * for consumer automotive traffic where mobile share is typically 60%+.
   */
  private abnormalDeviceScore(diversityScore: number): number {
    if (diversityScore < 0.2) return 70;
    if (diversityScore < 0.4) return 40;
    return 0;
  }
}

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface FraudAnalysis {
  totalEvents: number;
  knownBots: number;
  suspiciousFastClicks: number;
  rapidFireClusters: number;
  topIpConcentration: number;
  datacenterIpEstimate: number;
  overallRisk: RiskLevel;
}
