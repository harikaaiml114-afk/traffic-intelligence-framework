import {
  BudgetRecommendation,
  AllocationPlan,
  RecommendationAction,
  VendorScore,
} from '../types';
import { DataStore } from '../store/DataStore';
import { VendorScorer } from '../scoring/VendorScorer';
import { TrafficDistributor } from '../engine/TrafficDistributor';
import { clamp } from '../utils/statistics';

/**
 * BudgetAllocator generates actionable budget allocation recommendations
 * for the media buying team.
 *
 * This is the "last mile" of the framework — translating statistical
 * analysis into clear, defensible guidance that non-technical stakeholders
 * can act on.
 *
 * Design decisions:
 *
 * - Recommendations use plain language actions: increase, maintain,
 *   decrease, pause, review. The buying team doesn't need p-values.
 *
 * - Each recommendation includes a confidence level and reason string,
 *   making the logic auditable and defensible with agency clients.
 *
 * - The allocator identifies "top tier" vendors (top 20% by composite
 *   score) — directly addressing the success criterion in the brief.
 *
 * - Flagged vendors (high fraud risk or sudden quality drops) get
 *   explicit "review" or "pause" recommendations with explanations.
 */
export class BudgetAllocator {
  private store: DataStore;
  private vendorScorer: VendorScorer;
  private trafficDistributor: TrafficDistributor;

  private readonly topTierPercentile = 0.20;
  private readonly pauseThreshold = 25;      // composite score below this → pause
  private readonly reviewThreshold = 40;     // composite score below this → review
  private readonly fraudAlertThreshold = 50; // fraud risk above this → flag

  constructor(store: DataStore) {
    this.store = store;
    this.vendorScorer = new VendorScorer();
    this.trafficDistributor = new TrafficDistributor(store);
  }

  /**
   * Generate a complete allocation plan for a campaign.
   * This is the primary output consumed by the media buying team.
   */
  generateAllocationPlan(
    campaignId: string,
    vendorIds: string[],
    totalBudget: number,
  ): AllocationPlan {
    const scores = vendorIds
      .map((vid) => this.store.getLatestVendorScore(vid))
      .filter((s): s is VendorScore => s !== undefined);

    const rankedScores = this.vendorScorer.rankVendors(scores);
    const topTier = this.vendorScorer.getTopTier(scores, this.topTierPercentile);
    const topTierIds = new Set(topTier.map((s) => s.vendorId));

    // Get deterministic allocations (not Thompson Sampling — we want stable recs)
    const allocations = this.trafficDistributor.computeDeterministicAllocations(vendorIds);
    const allocationMap = new Map(allocations.map((a) => [a.vendorId, a.weight]));

    const recommendations: BudgetRecommendation[] = [];
    const flaggedVendorIds: string[] = [];

    for (const vendorId of vendorIds) {
      const score = scores.find((s) => s.vendorId === vendorId);
      const currentAllocation = 1 / vendorIds.length; // assume equal if unknown
      const recommendedAllocation = allocationMap.get(vendorId) ?? currentAllocation;

      const rec = this.generateVendorRecommendation(
        vendorId,
        campaignId,
        score,
        currentAllocation,
        recommendedAllocation,
        topTierIds.has(vendorId),
      );

      recommendations.push(rec);

      if (rec.action === 'pause' || rec.action === 'review') {
        flaggedVendorIds.push(vendorId);
      }
    }

    const summary = this.generateSummary(
      recommendations,
      topTier.length,
      flaggedVendorIds.length,
      totalBudget,
    );

    return {
      campaignId,
      timestamp: new Date(),
      allocations: recommendations,
      totalBudget,
      topTierVendorIds: Array.from(topTierIds),
      flaggedVendorIds,
      summary,
    };
  }

  /**
   * Quick report: which vendors should the team focus on right now?
   */
  getActionItems(campaignId: string, vendorIds: string[]): ActionItem[] {
    const items: ActionItem[] = [];

    for (const vendorId of vendorIds) {
      const score = this.store.getLatestVendorScore(vendorId);
      const vendor = this.store.getVendor(vendorId);
      const vendorName = vendor?.name || vendorId.slice(0, 8);

      if (!score) {
        items.push({
          vendorId,
          vendorName,
          priority: 'medium',
          action: 'No data available — schedule experiment to evaluate',
        });
        continue;
      }

      if (score.fraudRiskScore > this.fraudAlertThreshold) {
        items.push({
          vendorId,
          vendorName,
          priority: 'critical',
          action: `High fraud risk (${score.fraudRiskScore}/100). Investigate immediately and consider pausing.`,
        });
      }

      if (score.compositeScore < this.pauseThreshold) {
        items.push({
          vendorId,
          vendorName,
          priority: 'high',
          action: `Very low quality score (${score.compositeScore}/100). Recommend pausing and reallocating budget.`,
        });
      }

      // Detect sudden quality drops
      const history = this.store.getVendorScoreHistory(vendorId, 5);
      if (history.length >= 2) {
        const prev = history[history.length - 2];
        const drop = prev.compositeScore - score.compositeScore;
        if (drop > 15) {
          items.push({
            vendorId,
            vendorName,
            priority: 'high',
            action: `Quality dropped ${drop} points since last evaluation. Possible vendor behavior change.`,
          });
        }
      }
    }

    return items.sort((a, b) => {
      const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
      return priorityOrder[a.priority] - priorityOrder[b.priority];
    });
  }

  private generateVendorRecommendation(
    vendorId: string,
    campaignId: string,
    score: VendorScore | undefined,
    currentAllocation: number,
    recommendedAllocation: number,
    isTopTier: boolean,
  ): BudgetRecommendation {
    let action: RecommendationAction;
    let reason: string;
    let confidence: number;

    if (!score) {
      return {
        vendorId,
        campaignId,
        timestamp: new Date(),
        action: 'review',
        currentAllocationPercent: currentAllocation * 100,
        recommendedAllocationPercent: recommendedAllocation * 100,
        reason: 'Insufficient data. Schedule an experiment to evaluate this vendor.',
        confidence: 0,
        compositeScore: 0,
      };
    }

    if (score.fraudRiskScore > this.fraudAlertThreshold) {
      action = 'pause';
      reason = `High fraud risk score (${score.fraudRiskScore}/100). ` +
        `Key indicators: bot rate, IP concentration, or suspicious click patterns.`;
      confidence = score.confidence;
    } else if (score.compositeScore < this.pauseThreshold) {
      action = 'pause';
      reason = `Composite quality score (${score.compositeScore}/100) is below minimum threshold. ` +
        `Traffic unlikely to produce genuine engagement.`;
      confidence = score.confidence;
    } else if (score.compositeScore < this.reviewThreshold) {
      action = 'decrease';
      reason = `Below-average quality (${score.compositeScore}/100). ` +
        `Reduce allocation and monitor for improvement.`;
      confidence = score.confidence;
    } else if (isTopTier) {
      action = 'increase';
      reason = `Top-tier vendor (score: ${score.compositeScore}/100). ` +
        `High engagement proxy, low fraud risk. Recommend increased budget allocation.`;
      confidence = score.confidence;
    } else if (Math.abs(recommendedAllocation - currentAllocation) < 0.05) {
      action = 'maintain';
      reason = `Performing at acceptable level (score: ${score.compositeScore}/100). ` +
        `Current allocation is appropriate.`;
      confidence = score.confidence;
    } else if (recommendedAllocation > currentAllocation) {
      action = 'increase';
      reason = `Above-average quality (score: ${score.compositeScore}/100). ` +
        `Data supports higher allocation.`;
      confidence = score.confidence;
    } else {
      action = 'decrease';
      reason = `Quality trending below peers (score: ${score.compositeScore}/100). ` +
        `Consider reallocating to higher-performing vendors.`;
      confidence = score.confidence;
    }

    return {
      vendorId,
      campaignId,
      timestamp: new Date(),
      action,
      currentAllocationPercent: clamp(Math.round(currentAllocation * 100), 0, 100),
      recommendedAllocationPercent: clamp(Math.round(recommendedAllocation * 100), 0, 100),
      reason,
      confidence,
      compositeScore: score.compositeScore,
    };
  }

  private generateSummary(
    recommendations: BudgetRecommendation[],
    topTierCount: number,
    flaggedCount: number,
    totalBudget: number,
  ): string {
    const actions = recommendations.reduce(
      (acc, r) => {
        acc[r.action] = (acc[r.action] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    );

    const parts: string[] = [
      `Allocation plan for ${recommendations.length} vendors (budget: $${totalBudget.toLocaleString()}).`,
    ];

    if (topTierCount > 0) {
      parts.push(`${topTierCount} top-tier vendor(s) identified for increased allocation.`);
    }
    if (flaggedCount > 0) {
      parts.push(`⚠ ${flaggedCount} vendor(s) flagged for review or pause.`);
    }
    if (actions.increase) {
      parts.push(`${actions.increase} vendor(s) recommended for budget increase.`);
    }
    if (actions.pause) {
      parts.push(`${actions.pause} vendor(s) recommended for pause.`);
    }

    return parts.join(' ');
  }
}

export interface ActionItem {
  vendorId: string;
  vendorName: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  action: string;
}
