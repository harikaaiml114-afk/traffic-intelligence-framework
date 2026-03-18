import {
  normalCdf,
  twoProportionZTest,
  wilsonInterval,
  shannonEntropy,
  normalizedEntropy,
  coefficientOfVariation,
  sampleBeta,
  betaMean,
  betaVariance,
  clamp,
} from '../src/utils/statistics';

describe('Statistics utilities', () => {
  describe('normalCdf', () => {
    it('should return 0.5 for z=0', () => {
      expect(normalCdf(0)).toBeCloseTo(0.5, 5);
    });

    it('should return ~0.8413 for z=1', () => {
      expect(normalCdf(1)).toBeCloseTo(0.8413, 3);
    });

    it('should return ~0.9772 for z=2', () => {
      expect(normalCdf(2)).toBeCloseTo(0.9772, 3);
    });

    it('should return ~0.1587 for z=-1 (symmetric)', () => {
      expect(normalCdf(-1)).toBeCloseTo(0.1587, 3);
    });
  });

  describe('twoProportionZTest', () => {
    it('should return non-significant for similar proportions', () => {
      const result = twoProportionZTest(50, 100, 48, 100);
      expect(result.pValue).toBeGreaterThan(0.05);
    });

    it('should return significant for very different proportions', () => {
      const result = twoProportionZTest(80, 100, 20, 100);
      expect(result.pValue).toBeLessThan(0.001);
    });

    it('should handle zero standard error gracefully', () => {
      const result = twoProportionZTest(0, 100, 0, 100);
      expect(result.zStat).toBe(0);
      expect(result.pValue).toBe(1);
    });
  });

  describe('wilsonInterval', () => {
    it('should return [0, 1] for zero total', () => {
      const [low, high] = wilsonInterval(0, 0);
      expect(low).toBe(0);
      expect(high).toBe(1);
    });

    it('should produce a narrow interval for large samples', () => {
      const [low, high] = wilsonInterval(500, 1000);
      expect(high - low).toBeLessThan(0.1);
      expect(low).toBeGreaterThan(0.4);
      expect(high).toBeLessThan(0.6);
    });

    it('should produce a wider interval for small samples', () => {
      const [low, high] = wilsonInterval(5, 10);
      expect(high - low).toBeGreaterThan(0.2);
    });
  });

  describe('shannonEntropy', () => {
    it('should return 0 for a single outcome', () => {
      expect(shannonEntropy([1])).toBeCloseTo(0, 5);
    });

    it('should return 1 bit for fair coin', () => {
      expect(shannonEntropy([0.5, 0.5])).toBeCloseTo(1, 5);
    });

    it('should return log2(4) = 2 for uniform distribution over 4 outcomes', () => {
      expect(shannonEntropy([0.25, 0.25, 0.25, 0.25])).toBeCloseTo(2, 5);
    });
  });

  describe('normalizedEntropy', () => {
    it('should return 1 for perfectly uniform distribution', () => {
      expect(normalizedEntropy([10, 10, 10, 10])).toBeCloseTo(1, 5);
    });

    it('should return 0 for all-on-one distribution', () => {
      expect(normalizedEntropy([100, 0, 0, 0])).toBeCloseTo(0, 5);
    });

    it('should return 0 for empty input', () => {
      expect(normalizedEntropy([])).toBe(0);
    });
  });

  describe('coefficientOfVariation', () => {
    it('should return 0 for constant values', () => {
      expect(coefficientOfVariation([5, 5, 5, 5])).toBe(0);
    });

    it('should return a positive value for variable data', () => {
      expect(coefficientOfVariation([1, 2, 3, 4, 5])).toBeGreaterThan(0);
    });

    it('should handle single-element arrays', () => {
      expect(coefficientOfVariation([42])).toBe(0);
    });
  });

  describe('sampleBeta', () => {
    it('should return values between 0 and 1', () => {
      for (let i = 0; i < 100; i++) {
        const sample = sampleBeta(2, 5);
        expect(sample).toBeGreaterThanOrEqual(0);
        expect(sample).toBeLessThanOrEqual(1);
      }
    });

    it('should produce samples centered near the mean', () => {
      const samples: number[] = [];
      for (let i = 0; i < 5000; i++) {
        samples.push(sampleBeta(5, 5));
      }
      const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
      expect(mean).toBeCloseTo(0.5, 1);
    });
  });

  describe('betaMean', () => {
    it('should return 0.5 for symmetric distribution', () => {
      expect(betaMean(5, 5)).toBe(0.5);
    });

    it('should return higher mean when alpha > beta', () => {
      expect(betaMean(8, 2)).toBeCloseTo(0.8, 5);
    });
  });

  describe('betaVariance', () => {
    it('should decrease with larger alpha + beta (more data)', () => {
      const var1 = betaVariance(2, 2);
      const var2 = betaVariance(20, 20);
      expect(var2).toBeLessThan(var1);
    });
  });

  describe('clamp', () => {
    it('should clamp values below min', () => {
      expect(clamp(-5, 0, 100)).toBe(0);
    });

    it('should clamp values above max', () => {
      expect(clamp(150, 0, 100)).toBe(100);
    });

    it('should leave values within range unchanged', () => {
      expect(clamp(50, 0, 100)).toBe(50);
    });
  });
});
