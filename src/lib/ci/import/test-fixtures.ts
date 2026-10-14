import type { CiUser, FormOptions, LookupValue } from "@/types/ci";

/**
 * Small, test-only lookup/reference fixture for the import unit tests. Not
 * used by the application.
 */
const LISTS: Record<string, string[]> = {
  Quarter: ["Q1", "Q2", "Q3", "Q4"],
  Year: ["2020", "2021", "2022", "2023", "2024", "2025", "2026", "2027"],
  "Served Market": ["Foundry", "Logic", "DRAM", "NAND"],
  "Wafer Size": ['300mm (12")', '200mm (8")', '150mm (6")'],
  "Process Type": ["Sacrificial - Conformal", "Permanent - Conformal"],
  "Process Location": ["FEOL", "MOL", "BEOL"],
  "Top Competitor": ["AMAT", "LAM", "Wonik IPS", "Jusung Engineering"],
  "Product Line": ["ALD", "CVD", "PEALD"],
  "Process Modules (#)": ["1", "2", "3"],
  "Tool Type": ["SiO-QCM", "SiN-QCM", "ALD-VF"],
  Currency: ["USD", "EUR", "KRW", "JPY", "TWD"],
  "Order Type": ["Module", "Retrofit", "System"],
};

let id = 0;
const lookups: LookupValue[] = Object.entries(LISTS).flatMap(([category, values]) =>
  values.map((value, i) => ({ id: `t${++id}`, category, value, sortOrder: i + 1, active: true }))
);

export const TEST_OPTIONS: FormOptions = {
  lookups,
  reference: {
    customers: ["Samsung", "SK Hynix"],
    customerFabs: [
      { customer: "Samsung", fabLocation: "Samsung Hwaseong", fabRegion: "Korea" },
      { customer: "SK Hynix", fabLocation: "SK Hynix Icheon", fabRegion: "Korea" },
    ],
    competitorProducts: [{ competitor: "AMAT", product: "Producer" }],
    processLocations: [
      { servedMarket: "Foundry", processLocation: "FEOL" },
      { servedMarket: "Foundry", processLocation: "MOL" },
      { servedMarket: "DRAM", processLocation: "BEOL" },
    ],
    technologyNodes: [
      { customer: "Samsung", servedMarket: "Foundry", technologyNode: "L5" },
      { customer: "SK Hynix", servedMarket: "DRAM", technologyNode: "D1Z" },
    ],
  },
};

export const TEST_USERS: CiUser[] = [
  { id: "1", name: "Shruti Mehta", email: "shruti.mehta@example.com", role: "CM", customerScope: "All", segmentScope: "All", regionScope: "All", status: "Active" },
];
