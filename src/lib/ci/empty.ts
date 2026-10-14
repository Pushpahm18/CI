import type { FormOptions } from "@/types/ci";

/** Used while form options can't be loaded (e.g. CI table configuration is pending): every dropdown is simply empty — never sample values. */
export const EMPTY_FORM_OPTIONS: FormOptions = {
  lookups: [],
  reference: { customers: [], customerFabs: [], competitorProducts: [], processLocations: [], technologyNodes: [] },
};
