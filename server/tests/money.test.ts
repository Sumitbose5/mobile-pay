import { describe, expect, it } from 'vitest';
import { paiseToRupees, rupeesToPaise } from '../src/lib/money.js';

describe('money', () => {
  it('converts rupees to paise without floating point error', () => {
    expect(rupeesToPaise('100.50')).toBe(10050n);
    expect(rupeesToPaise('0.1')).toBe(10n);
    expect(rupeesToPaise('1')).toBe(100n);
  });

  it('rejects malformed amounts', () => {
    expect(() => rupeesToPaise('1.234')).toThrow();
    expect(() => rupeesToPaise('-5')).toThrow();
    expect(() => rupeesToPaise('abc')).toThrow();
  });

  it('formats paise as rupees', () => {
    expect(paiseToRupees(10050n)).toBe('100.50');
    expect(paiseToRupees(5n)).toBe('0.05');
    expect(paiseToRupees(-250n)).toBe('-2.50');
  });
});
