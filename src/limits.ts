// Limits that come from the provided schema, so a valid request can never overflow a column.
export const INT_MAX = 2_147_483_647; // INT: every id and orders.size

// Money travels as decimal strings (like the responses), so no amount is ever a binary float.
export const PRICE = /^\d{1,8}(\.\d{1,2})?$/; // orders.price is NUMERIC(10, 2)
export const AMOUNT = /^\d{1,15}(\.\d{1,2})?$/; // bounds the input; a size above INT is AMOUNT_TOO_LARGE anyway
