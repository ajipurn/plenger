/**
 * A request the store refused because of what the caller supplied (a duplicate name,
 * a deleted record, a missing key), as opposed to an I/O or integrity failure. Its
 * message is written for the person using the dashboard and may be shown to them.
 */
export class StoreValidationError extends Error {}
