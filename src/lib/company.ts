/**
 * Produces the stable, local-only key used to identify a company roster.
 * The original company name must still be retained for display.
 */
export function normalizeCompanyName(value:string):string {
  return value.normalize('NFKC').replace(/\s+/gu,' ').trim().toUpperCase();
}
