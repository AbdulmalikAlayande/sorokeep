import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { computeSeverity, computeResourceSeverity } from '../../src/alerts/types';

const validSeverities = ['critical', 'warning', 'info'] as const;

describe('computeSeverity', () => {
  it('always returns info for resolution events, regardless of TTL/threshold', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1e6, max: 1e6, noNaN: true }),
        fc.double({ min: 1e-6, max: 1e6, noNaN: true }),
        (remainingTTL, thresholdLedgers) => {
          expect(computeSeverity(remainingTTL, thresholdLedgers, true)).toBe('info');
        }
      )
    );
  });

  it('always returns a valid severity for any TTL/threshold combination', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1e6, max: 1e6, noNaN: true }),
        fc.double({ min: 1e-6, max: 1e6, noNaN: true }),
        fc.boolean(),
        (remainingTTL, thresholdLedgers, isResolution) => {
          const severity = computeSeverity(remainingTTL, thresholdLedgers, isResolution);
          expect(validSeverities).toContain(severity);
        }
      )
    );
  });

  it('classifies non-resolution severity based on the <=0 and 25% boundaries', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1e6, max: 1e6, noNaN: true }),
        fc.double({ min: 1e-6, max: 1e6, noNaN: true }),
        (remainingTTL, thresholdLedgers) => {
          const expected =
            remainingTTL <= 0 || remainingTTL < thresholdLedgers * 0.25
              ? 'critical'
              : 'warning';
          expect(computeSeverity(remainingTTL, thresholdLedgers, false)).toBe(expected);
        }
      )
    );
  });

  it('returns critical when remainingTTL is zero or negative', () => {
    expect(computeSeverity(0, 100, false)).toBe('critical');
    expect(computeSeverity(-1, 100, false)).toBe('critical');
  });

  it('returns critical when remainingTTL is just below the 25% threshold boundary', () => {
    expect(computeSeverity(24.999, 100, false)).toBe('critical');
  });

  it('returns warning when remainingTTL is exactly at the 25% threshold boundary', () => {
    expect(computeSeverity(25, 100, false)).toBe('warning');
  });

  it('returns warning when remainingTTL is well above the 25% threshold boundary', () => {
    expect(computeSeverity(100, 100, false)).toBe('warning');
    expect(computeSeverity(1000, 100, false)).toBe('warning');
  });
});

describe('computeResourceSeverity', () => {
  it('always returns a valid severity for any usage percentage', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 200, noNaN: true }),
        (usagePercent) => {
          const severity = computeResourceSeverity(usagePercent);
          expect(validSeverities).toContain(severity);
        }
      )
    );
  });

  it('classifies severity based on the 80% and 95% boundaries', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 200, noNaN: true }),
        (usagePercent) => {
          const expected = usagePercent >= 95
            ? 'critical'
            : usagePercent >= 80
              ? 'warning'
              : 'info';
          expect(computeResourceSeverity(usagePercent)).toBe(expected);
        }
      )
    );
  });

  it('returns warning when usage is exactly 80%', () => {
    expect(computeResourceSeverity(80)).toBe('warning');
  });

  it('returns info when usage is just below 80%', () => {
    expect(computeResourceSeverity(79.999)).toBe('info');
  });

  it('returns warning when usage is between 80% and 95%', () => {
    expect(computeResourceSeverity(80.001)).toBe('warning');
    expect(computeResourceSeverity(94.999)).toBe('warning');
  });

  it('returns critical when usage is exactly 95% or above', () => {
    expect(computeResourceSeverity(95)).toBe('critical');
    expect(computeResourceSeverity(95.001)).toBe('critical');
  });
});
