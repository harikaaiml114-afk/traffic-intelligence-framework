import { v4 as uuidv4 } from 'uuid';
import {
  Experiment,
  ExperimentConfig,
  ExperimentResult,
  ExperimentStatus,
  TrafficEvent,
  StatisticalTest,
} from '../types';
import { DataStore } from '../store/DataStore';
import { SignalCollector } from '../tracking/SignalCollector';
import { VendorScorer } from '../scoring/VendorScorer';
import { FraudDetector } from '../scoring/FraudDetector';
import { EngagementProxy } from '../scoring/EngagementProxy';
import { twoProportionZTest, wilsonInterval } from '../utils/statistics';

/**
 * ExperimentEngine is the core module that:
 *
 * 1. Schedules randomized traffic tests across vendors
 * 2. Distributes incoming traffic across active experiments
 * 3. Collects results and evaluates statistical significance
 * 4. Updates vendor scores based on experiment outcomes
 *
 * Design decisions:
 *
 * - Experiments are non-disruptive: they divert only a configurable fraction
 *   of total campaign traffic (default 10%), leaving the rest undisturbed.
 *   This directly addresses the constraint "must avoid disrupting live campaigns."
 *
 * - Each experiment compares 2+ vendors head-to-head on the same campaign,
 *   using random assignment to eliminate confounding variables.
 *
 * - We use a sequential testing approach: results are evaluated after each
 *   batch of traffic. If significance is reached early, the experiment
 *   completes without waiting for the full sample. This saves budget.
 *
 * - Vendor quality is measured via engagement proxy scores (since we cannot
 *   observe actual conversions). The engagement proxy is calibrated to
 *   signals that correlate with genuine human interest.
 */
export class ExperimentEngine {
  private store: DataStore;
  private signalCollector: SignalCollector;
  private vendorScorer: VendorScorer;
  private fraudDetector: FraudDetector;
  private engagementProxy: EngagementProxy;

  constructor(store: DataStore) {
    this.store = store;
    this.signalCollector = new SignalCollector();
    this.vendorScorer = new VendorScorer();
    this.fraudDetector = new FraudDetector();
    this.engagementProxy = new EngagementProxy();
  }

  /**
   * Create and schedule a new experiment.
   *
   * An experiment defines: which campaign, which vendors to compare,
   * how much traffic to allocate, and what threshold counts as "significant."
   */
  createExperiment(config: ExperimentConfig): Experiment {
    if (config.vendorIds.length < 2) {
      throw new Error('Experiment requires at least 2 vendors to compare');
    }

    const experiment: Experiment = {
      id: uuidv4(),
      name: config.name || `experiment-${Date.now()}`,
      campaignId: config.campaignId,
      status: 'scheduled',
      createdAt: new Date(),
      vendorIds: config.vendorIds,
      trafficAllocationPercent: config.trafficAllocationPercent ?? 10,
      minSampleSize: config.minSampleSize ?? 100,
      significanceLevel: config.significanceLevel ?? 0.05,
      results: new Map(
        config.vendorIds.map((vid) => [
          vid,
          {
            vendorId: vid,
            clicks: 0,
            qualitySignals: null,
            engagementScore: 0,
            fraudRiskScore: 0,
            isSignificant: false,
            pValue: null,
            confidenceInterval: null,
          },
        ]),
      ),
    };

    this.store.addExperiment(experiment);
    return experiment;
  }

  /**
   * Start a scheduled experiment. Marks it as running and records the start time.
   */
  startExperiment(experimentId: string): Experiment {
    const experiment = this.store.getExperiment(experimentId);
    if (!experiment) throw new Error(`Experiment ${experimentId} not found`);
    if (experiment.status !== 'scheduled') {
      throw new Error(`Cannot start experiment in status: ${experiment.status}`);
    }

    const updated = this.store.updateExperiment(experimentId, {
      status: 'running' as ExperimentStatus,
      startedAt: new Date(),
    });

    return updated!;
  }

  /**
   * Assign an incoming traffic event to an active experiment.
   * Returns the experiment ID if assigned, or null if no experiment needs this traffic.
   *
   * Assignment is random among running experiments for the same campaign,
   * weighted by each experiment's traffic allocation percentage.
   */
  assignToExperiment(event: TrafficEvent): string | null {
    const activeExperiments = this.store.getActiveExperiments().filter(
      (e) =>
        e.status === 'running' &&
        e.campaignId === event.campaignId &&
        e.vendorIds.includes(event.vendorId),
    );

    if (activeExperiments.length === 0) return null;

    // Roll dice to decide if this click goes to any experiment
    for (const exp of activeExperiments) {
      if (Math.random() * 100 < exp.trafficAllocationPercent) {
        return exp.id;
      }
    }

    return null;
  }

  /**
   * Process a batch of traffic events and update experiment results.
   * This is called periodically (e.g., every few minutes) to update
   * running experiments with new data.
   */
  processEvents(experimentId: string): ExperimentAnalysis {
    const experiment = this.store.getExperiment(experimentId);
    if (!experiment) throw new Error(`Experiment ${experimentId} not found`);

    const campaign = this.store.getCampaign(experiment.campaignId);
    const targetGeos = campaign?.targetGeos || [];

    const updatedResults = new Map<string, ExperimentResult>();

    for (const vendorId of experiment.vendorIds) {
      const events = this.store.getTrafficEvents({
        vendorId,
        campaignId: experiment.campaignId,
        experimentId: experiment.id,
      });

      const signals = this.signalCollector.computeSignals(
        vendorId,
        experiment.campaignId,
        events,
        experiment.startedAt || experiment.createdAt,
        new Date(),
        targetGeos,
      );

      const engagementResult = this.engagementProxy.computeEngagementScore(signals);
      const fraudRisk = this.fraudDetector.computeFraudRisk(signals);

      updatedResults.set(vendorId, {
        vendorId,
        clicks: events.length,
        qualitySignals: signals,
        engagementScore: engagementResult.score,
        fraudRiskScore: fraudRisk,
        isSignificant: false,
        pValue: null,
        confidenceInterval: null,
      });
    }

    // Run pairwise statistical tests
    const vendorIds = Array.from(updatedResults.keys());
    const significanceResults = this.runStatisticalTests(
      updatedResults,
      vendorIds,
      experiment.significanceLevel,
    );

    // Update results with significance info
    for (const [vendorId, result] of updatedResults) {
      const sigResult = significanceResults.get(vendorId);
      if (sigResult) {
        result.isSignificant = sigResult.significant;
        result.pValue = sigResult.pValue;
        result.confidenceInterval = sigResult.confidenceInterval;
      }
    }

    // Check if experiment should auto-complete
    const allHaveMinSample = vendorIds.every(
      (vid) => (updatedResults.get(vid)?.clicks || 0) >= experiment.minSampleSize,
    );
    const anySignificant = Array.from(updatedResults.values()).some((r) => r.isSignificant);
    const shouldComplete = allHaveMinSample && anySignificant;

    this.store.updateExperiment(experimentId, {
      results: updatedResults,
      ...(shouldComplete
        ? { status: 'completed' as ExperimentStatus, completedAt: new Date() }
        : {}),
    });

    // Update vendor scores in the store
    for (const [vendorId, result] of updatedResults) {
      if (result.qualitySignals) {
        const previousScore = this.store.getLatestVendorScore(vendorId);
        const newScore = this.vendorScorer.scoreVendor(result.qualitySignals, previousScore);
        this.store.addVendorScore(newScore);
      }
    }

    return {
      experimentId,
      status: shouldComplete ? 'completed' : experiment.status,
      results: Object.fromEntries(updatedResults),
      significanceTests: Object.fromEntries(significanceResults),
      recommendation: this.generateExperimentRecommendation(updatedResults),
    };
  }

  /**
   * Auto-schedule experiments for a campaign.
   * Creates experiments by pairing vendors that need evaluation.
   *
   * Strategy: prioritize vendors with lowest confidence scores (least data).
   */
  autoSchedule(
    campaignId: string,
    vendorIds: string[],
    options: { maxConcurrent?: number; groupSize?: number } = {},
  ): Experiment[] {
    const maxConcurrent = options.maxConcurrent ?? 3;
    const groupSize = options.groupSize ?? 3;

    const activeCount = this.store
      .getActiveExperiments()
      .filter((e) => e.campaignId === campaignId).length;

    if (activeCount >= maxConcurrent) return [];

    // Sort vendors by confidence (ascending) — test uncertain vendors first
    const scoredVendors = vendorIds.map((vid) => ({
      vendorId: vid,
      confidence: this.store.getLatestVendorScore(vid)?.confidence ?? 0,
    }));
    scoredVendors.sort((a, b) => a.confidence - b.confidence);

    const experiments: Experiment[] = [];
    const slotsAvailable = maxConcurrent - activeCount;

    for (let i = 0; i < slotsAvailable && i * groupSize < scoredVendors.length; i++) {
      const group = scoredVendors
        .slice(i * groupSize, (i + 1) * groupSize)
        .map((v) => v.vendorId);

      if (group.length < 2) continue;

      const exp = this.createExperiment({
        campaignId,
        vendorIds: group,
        name: `auto-${campaignId.slice(0, 8)}-batch-${i + 1}`,
      });
      const started = this.startExperiment(exp.id);
      experiments.push(started);
    }

    return experiments;
  }

  /**
   * Stop a running experiment. Useful when a vendor is clearly problematic
   * and continuing the test wastes budget.
   */
  stopExperiment(experimentId: string): Experiment {
    const experiment = this.store.getExperiment(experimentId);
    if (!experiment) throw new Error(`Experiment ${experimentId} not found`);

    const updated = this.store.updateExperiment(experimentId, {
      status: 'stopped' as ExperimentStatus,
      completedAt: new Date(),
    });

    return updated!;
  }

  /**
   * Get a summary of all experiments for a campaign.
   */
  getExperimentSummary(campaignId: string): ExperimentSummary {
    const experiments = this.store.getExperimentsByCampaign(campaignId);

    return {
      campaignId,
      total: experiments.length,
      running: experiments.filter((e) => e.status === 'running').length,
      completed: experiments.filter((e) => e.status === 'completed').length,
      scheduled: experiments.filter((e) => e.status === 'scheduled').length,
      stopped: experiments.filter((e) => e.status === 'stopped').length,
      experiments: experiments.map((e) => ({
        id: e.id,
        name: e.name,
        status: e.status,
        vendors: e.vendorIds.length,
        totalClicks: Array.from(e.results.values()).reduce((sum, r) => sum + r.clicks, 0),
      })),
    };
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Run pairwise z-tests comparing each vendor's "engagement rate" to the
   * pooled average. We treat engagement score / 100 as a binomial proportion.
   */
  private runStatisticalTests(
    results: Map<string, ExperimentResult>,
    vendorIds: string[],
    significanceLevel: number,
  ): Map<string, StatisticalTest> {
    const tests = new Map<string, StatisticalTest>();

    if (vendorIds.length < 2) return tests;

    // Calculate pooled engagement rate across all vendors
    let totalWeightedEngagement = 0;
    let totalClicks = 0;
    for (const result of results.values()) {
      totalWeightedEngagement += result.engagementScore * result.clicks;
      totalClicks += result.clicks;
    }
    const pooledRate = totalClicks > 0 ? totalWeightedEngagement / totalClicks / 100 : 0;

    for (const vendorId of vendorIds) {
      const result = results.get(vendorId)!;
      if (result.clicks < 10) {
        tests.set(vendorId, {
          testName: 'z-test vs pooled',
          statistic: 0,
          pValue: 1,
          significant: false,
          effectSize: 0,
          confidenceInterval: [0, 1],
        });
        continue;
      }

      const vendorSuccesses = Math.round((result.engagementScore / 100) * result.clicks);
      const otherClicks = totalClicks - result.clicks;
      const otherSuccesses = Math.round(pooledRate * otherClicks);

      if (otherClicks === 0) {
        tests.set(vendorId, {
          testName: 'z-test vs pooled',
          statistic: 0,
          pValue: 1,
          significant: false,
          effectSize: 0,
          confidenceInterval: [0, 1],
        });
        continue;
      }

      const { zStat, pValue } = twoProportionZTest(
        vendorSuccesses,
        result.clicks,
        otherSuccesses,
        otherClicks,
      );

      const ci = wilsonInterval(vendorSuccesses, result.clicks);
      const effectSize = (result.engagementScore / 100) - pooledRate;

      tests.set(vendorId, {
        testName: 'z-test vs pooled',
        statistic: zStat,
        pValue,
        significant: pValue < significanceLevel,
        effectSize,
        confidenceInterval: ci,
      });
    }

    return tests;
  }

  /**
   * Generate a human-readable recommendation from experiment results.
   */
  private generateExperimentRecommendation(
    results: Map<string, ExperimentResult>,
  ): string {
    const sorted = Array.from(results.values()).sort(
      (a, b) => b.engagementScore - a.engagementScore,
    );

    if (sorted.length === 0) return 'No data available yet.';

    const best = sorted[0];
    const worst = sorted[sorted.length - 1];
    const delta = best.engagementScore - worst.engagementScore;

    if (delta < 5) {
      return `Vendors are performing similarly (spread: ${delta} points). Continue testing for more data.`;
    }

    const highFraud = sorted.filter((r) => r.fraudRiskScore > 50);
    if (highFraud.length > 0) {
      const flagged = highFraud.map((r) => r.vendorId.slice(0, 8)).join(', ');
      return `WARNING: High fraud risk detected for vendor(s) ${flagged}. Recommend immediate review. Best performer: ${best.vendorId.slice(0, 8)} (engagement: ${best.engagementScore}).`;
    }

    return `Best vendor: ${best.vendorId.slice(0, 8)} (engagement: ${best.engagementScore}, fraud risk: ${best.fraudRiskScore}). Worst: ${worst.vendorId.slice(0, 8)} (engagement: ${worst.engagementScore}). Recommend shifting budget toward top performer.`;
  }
}

// -----------------------------------------------------------------------
// Supporting interfaces
// -----------------------------------------------------------------------

export interface ExperimentAnalysis {
  experimentId: string;
  status: ExperimentStatus | 'completed';
  results: Record<string, ExperimentResult>;
  significanceTests: Record<string, StatisticalTest>;
  recommendation: string;
}

export interface ExperimentSummary {
  campaignId: string;
  total: number;
  running: number;
  completed: number;
  scheduled: number;
  stopped: number;
  experiments: Array<{
    id: string;
    name: string;
    status: ExperimentStatus;
    vendors: number;
    totalClicks: number;
  }>;
}
