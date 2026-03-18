import { TrafficEvent, QualitySignals } from '../types';
import {
  normalizedEntropy,
  coefficientOfVariation,
} from '../utils/statistics';

/**
 * SignalCollector processes raw TrafficEvents and extracts aggregate
 * quality signals per vendor per campaign per time window.
 *
 * This is the critical translation layer between raw click data
 * (which we CAN observe) and engagement quality indicators
 * (which approximate what we CANNOT directly observe on landing pages).
 *
 * Key insight: since we don't have access to landing page behavior,
 * we derive quality signals from the traffic itself — patterns that
 * correlate with genuine human intent vs. low-quality or fraudulent traffic.
 */
export class SignalCollector {
  /**
   * Compute quality signals for a batch of traffic events from a single vendor+campaign.
   * The events should be pre-filtered to the desired time window.
   */
  computeSignals(
    vendorId: string,
    campaignId: string,
    events: TrafficEvent[],
    windowStart: Date,
    windowEnd: Date,
    targetGeos: string[] = [],
  ): QualitySignals {
    if (events.length === 0) {
      return this.emptySignals(vendorId, campaignId, windowStart, windowEnd);
    }

    const totalClicks = events.length;

    const botRate = events.filter((e) => e.knownBotSignature).length / totalClicks;

    const uniqueIps = new Set(events.map((e) => e.ip)).size;
    const ipDiversityRatio = uniqueIps / totalClicks;
    const repeatIpCount = events.filter((e) => e.repeatIp).length;
    const ipConcentrationRate = repeatIpCount / totalClicks;

    const geoMatchRate =
      targetGeos.length > 0
        ? events.filter((e) => targetGeos.includes(e.geo.region) || targetGeos.includes(e.geo.city)).length / totalClicks
        : 1;

    const temporalEntropy = this.computeTemporalEntropy(events);

    const deviceCounts = this.countByField(events, 'deviceType');
    const deviceDiversityScore = normalizedEntropy(Object.values(deviceCounts));

    const latencies = events.map((e) => e.redirectLatencyMs);
    const avgRedirectLatencyMs = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    const suspiciouslyFastRate = events.filter((e) => e.redirectLatencyMs < 100).length / totalClicks;

    const clickTimingVariance = this.computeClickTimingVariance(events);

    return {
      vendorId,
      campaignId,
      windowStart,
      windowEnd,
      totalClicks,
      botRate,
      ipConcentrationRate,
      ipDiversityRatio,
      geoMatchRate,
      temporalEntropy,
      deviceDiversityScore,
      avgRedirectLatencyMs,
      suspiciouslyFastRate,
      clickTimingVariance,
    };
  }

  /**
   * Temporal entropy: how evenly distributed are clicks across time buckets?
   * Legitimate traffic follows natural patterns (peaks during business hours).
   * Bot traffic is often suspiciously uniform or concentrated in bursts.
   *
   * We bucket clicks into hourly bins and measure distribution entropy.
   */
  private computeTemporalEntropy(events: TrafficEvent[]): number {
    const hourBuckets = new Array(24).fill(0);
    for (const event of events) {
      const hour = event.timestamp.getHours();
      hourBuckets[hour]++;
    }
    return normalizedEntropy(hourBuckets);
  }

  /**
   * Click timing variance: measures how variable the intervals between clicks are.
   * Human traffic has high variance (people click at irregular intervals).
   * Bot traffic often has low variance (clicks at regular intervals).
   */
  private computeClickTimingVariance(events: TrafficEvent[]): number {
    if (events.length < 3) return 0;

    const sorted = [...events].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    const intervals: number[] = [];

    for (let i = 1; i < sorted.length; i++) {
      intervals.push(sorted[i].timestamp.getTime() - sorted[i - 1].timestamp.getTime());
    }

    return coefficientOfVariation(intervals);
  }

  private countByField(events: TrafficEvent[], field: keyof TrafficEvent): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const event of events) {
      const value = String(event[field]);
      counts[value] = (counts[value] || 0) + 1;
    }
    return counts;
  }

  private emptySignals(
    vendorId: string,
    campaignId: string,
    windowStart: Date,
    windowEnd: Date,
  ): QualitySignals {
    return {
      vendorId,
      campaignId,
      windowStart,
      windowEnd,
      totalClicks: 0,
      botRate: 0,
      ipConcentrationRate: 0,
      ipDiversityRatio: 0,
      geoMatchRate: 0,
      temporalEntropy: 0,
      deviceDiversityScore: 0,
      avgRedirectLatencyMs: 0,
      suspiciouslyFastRate: 0,
      clickTimingVariance: 0,
    };
  }
}
