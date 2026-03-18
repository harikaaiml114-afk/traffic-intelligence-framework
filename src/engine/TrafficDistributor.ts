import { AllocationWeights, VendorScore } from '../types';
import { DataStore } from '../store/DataStore';
import { sampleBeta, clamp } from '../utils/statistics';

/**
 * TrafficDistributor uses Thompson Sampling to allocate traffic across vendors.
 *
 * Why Thompson Sampling over simpler approaches?
 *
 * 1. Explore-exploit balance: With many vendors whose quality can change,
 *    we need to keep testing underperforming vendors (they might improve)
 *    while mostly sending traffic to known good vendors. Thompson Sampling
 *    does this optimally — it explores in proportion to uncertainty.
 *
 * 2. Natural adaptation: When a vendor's quality drops, their Beta posterior
 *    shifts, and Thompson Sampling automatically reduces their allocation.
 *    No manual threshold tuning required.
 *
 * 3. Regret minimization: Thompson Sampling is provably near-optimal for
 *    the multi-armed bandit problem, minimizing the total "quality lost"
 *    by sending traffic to suboptimal vendors.
 *
 * Practical constraints:
 * - Minimum allocation floor (2%) prevents completely starving any vendor,
 *   ensuring we maintain data flow for scoring.
 * - Maximum allocation cap (40%) prevents over-concentration on one vendor,
 *   protecting against sudden quality drops.
 * - Fraud-flagged vendors get forced minimum allocation.
 */
export class TrafficDistributor {
  private store: DataStore;

  private readonly minAllocation = 0.02;
  private readonly maxAllocation = 0.40;
  private readonly fraudThreshold = 60;

  constructor(store: DataStore) {
    this.store = store;
  }

  /**
   * Compute traffic allocation weights for a set of vendors.
   * Uses Thompson Sampling from the Bayesian posteriors maintained by VendorScorer.
   */
  computeAllocations(vendorIds: string[]): AllocationWeights[] {
    if (vendorIds.length === 0) return [];
    if (vendorIds.length === 1) {
      return [{ vendorId: vendorIds[0], weight: 1.0, explorationBonus: 0 }];
    }

    const samples: Array<{ vendorId: string; sample: number; score: VendorScore | undefined }> = [];

    for (const vendorId of vendorIds) {
      const score = this.store.getLatestVendorScore(vendorId);

      // Sample from the vendor's Beta posterior
      const alpha = score?.alpha ?? 2;
      const beta = score?.beta ?? 2;
      const sample = sampleBeta(alpha, beta);

      samples.push({ vendorId, sample, score });
    }

    // Apply fraud penalty: vendors with high fraud risk get suppressed
    for (const s of samples) {
      if (s.score && s.score.fraudRiskScore > this.fraudThreshold) {
        s.sample *= 0.1; // drastically reduce allocation for fraudulent vendors
      }
    }

    // Normalize samples to get allocation weights
    const totalSample = samples.reduce((sum, s) => sum + s.sample, 0);
    if (totalSample === 0) {
      const equalWeight = 1 / vendorIds.length;
      return vendorIds.map((vid) => ({
        vendorId: vid,
        weight: equalWeight,
        explorationBonus: 0,
      }));
    }

    let allocations = samples.map((s) => ({
      vendorId: s.vendorId,
      rawWeight: s.sample / totalSample,
      score: s.score,
    }));

    // Apply min/max constraints
    allocations = this.applyConstraints(allocations);

    // Calculate exploration bonus (how much of the allocation is due to
    // uncertainty vs known quality)
    return allocations.map((a) => {
      const knownQuality = a.score
        ? (a.score.compositeScore / 100) * a.score.confidence
        : 0;
      const explorationBonus = clamp(a.rawWeight - knownQuality, 0, 1);

      return {
        vendorId: a.vendorId,
        weight: a.rawWeight,
        explorationBonus,
      };
    });
  }

  /**
   * Deterministic allocation based on composite scores (no randomness).
   * Used for generating stable recommendations rather than live traffic routing.
   */
  computeDeterministicAllocations(vendorIds: string[]): AllocationWeights[] {
    if (vendorIds.length === 0) return [];

    const scored = vendorIds.map((vid) => ({
      vendorId: vid,
      score: this.store.getLatestVendorScore(vid),
    }));

    const totalScore = scored.reduce(
      (sum, s) => sum + (s.score?.compositeScore ?? 50) * (s.score?.confidence ?? 0.1),
      0,
    );

    if (totalScore === 0) {
      const equalWeight = 1 / vendorIds.length;
      return vendorIds.map((vid) => ({
        vendorId: vid,
        weight: equalWeight,
        explorationBonus: 0,
      }));
    }

    return scored.map((s) => {
      const weighted = (s.score?.compositeScore ?? 50) * (s.score?.confidence ?? 0.1);
      return {
        vendorId: s.vendorId,
        weight: clamp(weighted / totalScore, this.minAllocation, this.maxAllocation),
        explorationBonus: 0,
      };
    });
  }

  /**
   * Select which vendor should receive the next click.
   * Samples once from Thompson Sampling and returns the winner.
   */
  selectVendor(vendorIds: string[]): string {
    const allocations = this.computeAllocations(vendorIds);
    const roll = Math.random();

    let cumulative = 0;
    for (const alloc of allocations) {
      cumulative += alloc.weight;
      if (roll <= cumulative) {
        return alloc.vendorId;
      }
    }

    return allocations[allocations.length - 1].vendorId;
  }

  private applyConstraints(
    allocations: Array<{ vendorId: string; rawWeight: number; score: VendorScore | undefined }>,
  ): typeof allocations {
    let totalAdjusted = 0;

    // First pass: apply min/max
    for (const a of allocations) {
      a.rawWeight = clamp(a.rawWeight, this.minAllocation, this.maxAllocation);
      totalAdjusted += a.rawWeight;
    }

    // Renormalize to sum to 1
    for (const a of allocations) {
      a.rawWeight /= totalAdjusted;
    }

    return allocations;
  }
}
