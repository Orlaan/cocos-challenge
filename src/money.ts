import Decimal from 'decimal.js';

// decimal.js rounds to 20 significant digits by default. Sums of NUMERIC(10,2) × INT can need more,
// so every module imports Decimal from here, set to 40: no cent is ever rounded away.
Decimal.set({ precision: 40 });

export default Decimal;
