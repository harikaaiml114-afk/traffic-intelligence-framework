import { DataStore } from './store/DataStore';
import { createServer } from './api/server';
import { Simulator } from './simulation/Simulator';

/**
 * Traffic Intelligence Framework — Main Entry Point
 *
 * Starts the API server with optional demo data preloaded.
 * In production, the store would be backed by a real database.
 */
const PORT = parseInt(process.env.PORT || '3000', 10);
const LOAD_DEMO = process.env.LOAD_DEMO !== 'false';

async function main(): Promise<void> {
  const store = new DataStore();

  if (LOAD_DEMO) {
    console.log('Loading demo scenario...');
    const simulator = new Simulator(store);
    const scenario = simulator.setupDemoScenario();
    console.log(`  Loaded ${scenario.vendors.length} vendors, ${scenario.totalEvents} traffic events`);

    // Pre-compute scores for demo data
    const { SignalCollector } = await import('./tracking/SignalCollector');
    const { VendorScorer } = await import('./scoring/VendorScorer');

    const signalCollector = new SignalCollector();
    const vendorScorer = new VendorScorer();
    const windowStart = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const windowEnd = new Date();

    for (const vendor of scenario.vendors) {
      const events = store.getTrafficEvents({
        vendorId: vendor.id,
        campaignId: scenario.campaign.id,
      });
      const signals = signalCollector.computeSignals(
        vendor.id,
        scenario.campaign.id,
        events,
        windowStart,
        windowEnd,
        scenario.campaign.targetGeos,
      );
      store.addQualitySignals(signals);
      const score = vendorScorer.scoreVendor(signals);
      store.addVendorScore(score);
    }

    console.log('  Vendor scores computed.');
  }

  const app = createServer(store);

  app.listen(PORT, () => {
    console.log(`\n🚀 Traffic Intelligence Framework running on http://localhost:${PORT}`);
    console.log(`\n📊 Dashboard:  http://localhost:${PORT}/dashboard`);
    console.log(`\n   API Endpoints:`);
    console.log('   GET  /health                          — System health & stats');
    console.log('   GET  /vendors                         — List all vendors');
    console.log('   GET  /vendors/ranking/all              — Ranked vendor list');
    console.log('   GET  /vendors/top-tier/all             — Top 20% vendors');
    console.log('   POST /experiments                      — Create experiment');
    console.log('   POST /experiments/auto-schedule         — Auto-schedule experiments');
    console.log('   POST /allocations/compute               — Compute traffic allocations');
    console.log('   POST /recommendations/plan              — Generate budget plan');
    console.log('   POST /recommendations/action-items      — Get action items');
  });
}

main().catch(console.error);

export { DataStore } from './store/DataStore';
export { ExperimentEngine } from './engine/ExperimentEngine';
export { TrafficDistributor } from './engine/TrafficDistributor';
export { BudgetAllocator } from './recommendation/BudgetAllocator';
export { SignalCollector } from './tracking/SignalCollector';
export { VendorScorer } from './scoring/VendorScorer';
export { FraudDetector } from './scoring/FraudDetector';
export { EngagementProxy } from './scoring/EngagementProxy';
export { Simulator } from './simulation/Simulator';
export { createServer } from './api/server';
export * from './types';
