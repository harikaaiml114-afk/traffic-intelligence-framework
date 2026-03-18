import { v4 as uuidv4 } from 'uuid';
import {
  Vendor,
  Campaign,
  TrafficEvent,
  QualitySignals,
  VendorScore,
  Experiment,
  BudgetRecommendation,
} from '../types';

/**
 * In-memory data store with a clean interface boundary.
 *
 * In production this would be backed by a time-series DB (e.g. TimescaleDB)
 * for traffic events and a relational DB for vendor/campaign metadata.
 * The interface-first design makes that swap straightforward.
 */
export class DataStore {
  private vendors: Map<string, Vendor> = new Map();
  private campaigns: Map<string, Campaign> = new Map();
  private trafficEvents: TrafficEvent[] = [];
  private qualitySignals: QualitySignals[] = [];
  private vendorScores: Map<string, VendorScore[]> = new Map();
  private experiments: Map<string, Experiment> = new Map();
  private recommendations: BudgetRecommendation[] = [];

  // --------------- Vendors ---------------

  addVendor(name: string, metadata: Record<string, string> = {}): Vendor {
    const vendor: Vendor = {
      id: uuidv4(),
      name,
      active: true,
      createdAt: new Date(),
      metadata,
    };
    this.vendors.set(vendor.id, vendor);
    return vendor;
  }

  getVendor(id: string): Vendor | undefined {
    return this.vendors.get(id);
  }

  getAllVendors(): Vendor[] {
    return Array.from(this.vendors.values());
  }

  getActiveVendors(): Vendor[] {
    return this.getAllVendors().filter((v) => v.active);
  }

  updateVendor(id: string, updates: Partial<Vendor>): Vendor | undefined {
    const vendor = this.vendors.get(id);
    if (!vendor) return undefined;
    const updated = { ...vendor, ...updates, id };
    this.vendors.set(id, updated);
    return updated;
  }

  // --------------- Campaigns ---------------

  addCampaign(campaign: Omit<Campaign, 'id'>): Campaign {
    const full: Campaign = { ...campaign, id: uuidv4() };
    this.campaigns.set(full.id, full);
    return full;
  }

  getCampaign(id: string): Campaign | undefined {
    return this.campaigns.get(id);
  }

  getAllCampaigns(): Campaign[] {
    return Array.from(this.campaigns.values());
  }

  getActiveCampaigns(): Campaign[] {
    return this.getAllCampaigns().filter((c) => c.active);
  }

  // --------------- Traffic Events ---------------

  addTrafficEvent(event: TrafficEvent): void {
    this.trafficEvents.push(event);
  }

  addTrafficEvents(events: TrafficEvent[]): void {
    this.trafficEvents.push(...events);
  }

  getTrafficEvents(filters: {
    vendorId?: string;
    campaignId?: string;
    experimentId?: string;
    since?: Date;
    until?: Date;
  }): TrafficEvent[] {
    return this.trafficEvents.filter((e) => {
      if (filters.vendorId && e.vendorId !== filters.vendorId) return false;
      if (filters.campaignId && e.campaignId !== filters.campaignId) return false;
      if (filters.experimentId && e.experimentId !== filters.experimentId) return false;
      if (filters.since && e.timestamp < filters.since) return false;
      if (filters.until && e.timestamp > filters.until) return false;
      return true;
    });
  }

  getTrafficEventCount(vendorId: string, campaignId?: string): number {
    return this.trafficEvents.filter(
      (e) => e.vendorId === vendorId && (!campaignId || e.campaignId === campaignId),
    ).length;
  }

  // --------------- Quality Signals ---------------

  addQualitySignals(signals: QualitySignals): void {
    this.qualitySignals.push(signals);
  }

  getLatestQualitySignals(vendorId: string, campaignId?: string): QualitySignals | undefined {
    const matching = this.qualitySignals
      .filter((s) => s.vendorId === vendorId && (!campaignId || s.campaignId === campaignId))
      .sort((a, b) => b.windowEnd.getTime() - a.windowEnd.getTime());
    return matching[0];
  }

  getQualitySignalsHistory(vendorId: string, limit: number = 10): QualitySignals[] {
    return this.qualitySignals
      .filter((s) => s.vendorId === vendorId)
      .sort((a, b) => b.windowEnd.getTime() - a.windowEnd.getTime())
      .slice(0, limit);
  }

  // --------------- Vendor Scores ---------------

  addVendorScore(score: VendorScore): void {
    const existing = this.vendorScores.get(score.vendorId) || [];
    existing.push(score);
    this.vendorScores.set(score.vendorId, existing);
  }

  getLatestVendorScore(vendorId: string): VendorScore | undefined {
    const scores = this.vendorScores.get(vendorId);
    if (!scores || scores.length === 0) return undefined;
    return scores[scores.length - 1];
  }

  getAllLatestScores(): VendorScore[] {
    const results: VendorScore[] = [];
    for (const scores of this.vendorScores.values()) {
      if (scores.length > 0) {
        results.push(scores[scores.length - 1]);
      }
    }
    return results;
  }

  getVendorScoreHistory(vendorId: string, limit: number = 20): VendorScore[] {
    const scores = this.vendorScores.get(vendorId) || [];
    return scores.slice(-limit);
  }

  // --------------- Experiments ---------------

  addExperiment(experiment: Experiment): void {
    this.experiments.set(experiment.id, experiment);
  }

  getExperiment(id: string): Experiment | undefined {
    return this.experiments.get(id);
  }

  getAllExperiments(): Experiment[] {
    return Array.from(this.experiments.values());
  }

  getActiveExperiments(): Experiment[] {
    return this.getAllExperiments().filter(
      (e) => e.status === 'running' || e.status === 'scheduled',
    );
  }

  getExperimentsByCampaign(campaignId: string): Experiment[] {
    return this.getAllExperiments().filter((e) => e.campaignId === campaignId);
  }

  updateExperiment(id: string, updates: Partial<Experiment>): Experiment | undefined {
    const exp = this.experiments.get(id);
    if (!exp) return undefined;
    const updated = { ...exp, ...updates, id };
    this.experiments.set(id, updated);
    return updated;
  }

  // --------------- Recommendations ---------------

  addRecommendations(recs: BudgetRecommendation[]): void {
    this.recommendations.push(...recs);
  }

  getLatestRecommendations(campaignId?: string): BudgetRecommendation[] {
    const filtered = campaignId
      ? this.recommendations.filter((r) => r.campaignId === campaignId)
      : this.recommendations;

    if (filtered.length === 0) return [];

    const latestTimestamp = Math.max(...filtered.map((r) => r.timestamp.getTime()));
    return filtered.filter((r) => r.timestamp.getTime() === latestTimestamp);
  }

  // --------------- Utilities ---------------

  clear(): void {
    this.vendors.clear();
    this.campaigns.clear();
    this.trafficEvents = [];
    this.qualitySignals = [];
    this.vendorScores.clear();
    this.experiments.clear();
    this.recommendations = [];
  }

  getStats(): Record<string, number> {
    return {
      vendors: this.vendors.size,
      campaigns: this.campaigns.size,
      trafficEvents: this.trafficEvents.length,
      qualitySignals: this.qualitySignals.length,
      experiments: this.experiments.size,
      recommendations: this.recommendations.length,
    };
  }
}
