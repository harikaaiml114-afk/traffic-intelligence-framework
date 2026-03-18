import { DataStore } from '../src/store/DataStore';
import { BudgetAllocator } from '../src/recommendation/BudgetAllocator';
import { Simulator } from '../src/simulation/Simulator';
import { SignalCollector } from '../src/tracking/SignalCollector';
import { VendorScorer } from '../src/scoring/VendorScorer';

describe('BudgetAllocator', () => {
  let store: DataStore;
  let allocator: BudgetAllocator;

  beforeEach(() => {
    store = new DataStore();
    allocator = new BudgetAllocator(store);
  });

  function setupScoredScenario() {
    const simulator = new Simulator(store);
    const scenario = simulator.setupDemoScenario();

    const signalCollector = new SignalCollector();
    const vendorScorer = new VendorScorer();
    const windowStart = new Date(Date.now() - 86400000);
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

    return scenario;
  }

  describe('generateAllocationPlan', () => {
    it('should produce a plan with allocations for all vendors', () => {
      const scenario = setupScoredScenario();
      const vendorIds = scenario.vendors.map((v) => v.id);

      const plan = allocator.generateAllocationPlan(
        scenario.campaign.id,
        vendorIds,
        5000,
      );

      expect(plan.allocations).toHaveLength(vendorIds.length);
      expect(plan.totalBudget).toBe(5000);
      expect(plan.topTierVendorIds.length).toBeGreaterThan(0);
      expect(plan.summary).toBeTruthy();
    });

    it('should identify top-tier vendors', () => {
      const scenario = setupScoredScenario();
      const vendorIds = scenario.vendors.map((v) => v.id);

      const plan = allocator.generateAllocationPlan(
        scenario.campaign.id,
        vendorIds,
        5000,
      );

      expect(plan.topTierVendorIds.length).toBe(2);
    });

    it('should flag fraudulent vendors', () => {
      const scenario = setupScoredScenario();
      const vendorIds = scenario.vendors.map((v) => v.id);

      const plan = allocator.generateAllocationPlan(
        scenario.campaign.id,
        vendorIds,
        5000,
      );

      expect(plan.flaggedVendorIds.length).toBeGreaterThan(0);

      const flaggedRecs = plan.allocations.filter(
        (a) => a.action === 'pause' || a.action === 'review',
      );
      expect(flaggedRecs.length).toBeGreaterThan(0);
    });

    it('should include reasons for every recommendation', () => {
      const scenario = setupScoredScenario();
      const vendorIds = scenario.vendors.map((v) => v.id);

      const plan = allocator.generateAllocationPlan(
        scenario.campaign.id,
        vendorIds,
        5000,
      );

      for (const alloc of plan.allocations) {
        expect(alloc.reason).toBeTruthy();
        expect(alloc.reason.length).toBeGreaterThan(10);
      }
    });
  });

  describe('getActionItems', () => {
    it('should surface critical items for fraudulent vendors', () => {
      const scenario = setupScoredScenario();
      const vendorIds = scenario.vendors.map((v) => v.id);

      const items = allocator.getActionItems(scenario.campaign.id, vendorIds);

      const critical = items.filter((i) => i.priority === 'critical');
      expect(critical.length).toBeGreaterThan(0);
    });

    it('should sort by priority (critical first)', () => {
      const scenario = setupScoredScenario();
      const vendorIds = scenario.vendors.map((v) => v.id);

      const items = allocator.getActionItems(scenario.campaign.id, vendorIds);
      if (items.length >= 2) {
        const priorities = ['critical', 'high', 'medium', 'low'];
        for (let i = 1; i < items.length; i++) {
          expect(
            priorities.indexOf(items[i].priority),
          ).toBeGreaterThanOrEqual(priorities.indexOf(items[i - 1].priority));
        }
      }
    });

    it('should handle vendors with no scores', () => {
      const v1 = store.addVendor('New Vendor');
      const items = allocator.getActionItems('c1', [v1.id]);

      expect(items.length).toBe(1);
      expect(items[0].priority).toBe('medium');
      expect(items[0].action).toContain('No data');
    });
  });
});
