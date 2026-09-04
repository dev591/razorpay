/**
 * Indian-format rupees.
 *
 * Tolerates null/undefined rather than throwing: this is called on values
 * that come straight from API responses, and a field a backend version
 * happens not to send should render as a dash, not crash the page rendering
 * it.
 */
export function rupees(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `₹${n.toLocaleString("en-IN")}`;
}
