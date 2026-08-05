/**
 * The package version, in its own module so `routes/health.ts` can read it without
 * importing `index.ts` (which imports the route table — an import cycle).
 */
export const API_VERSION = "0.0.0";
