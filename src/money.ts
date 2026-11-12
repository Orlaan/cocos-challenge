import DecimalJs from 'decimal.js';

// decimal.js rounds to 20 significant digits by default. Sums of NUMERIC(10,2) × INT can need more,
// so every module uses this copy, set to 40: no cent is ever rounded away. A clone, so the
// library's shared default stays untouched.
const Decimal = DecimalJs.clone({ precision: 40 });
type Decimal = DecimalJs;

export default Decimal;
