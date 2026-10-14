import type {
  AuditEntry,
  ChangeNote,
  CiUser,
  CompetitiveRecord,
  LookupValue,
  ReferenceData,
  ScopeValue,
} from "@/types/ci";
import type { CiRepository } from "@/server/ci/repository";
import {
  MOCK_COMPETITOR_PRODUCTS,
  MOCK_CUSTOMER_FABS,
  MOCK_CUSTOMERS,
  MOCK_LISTS,
  MOCK_PROCESS_LOCATIONS,
  MOCK_TECHNOLOGY_NODES,
} from "@/server/ci/testing/mock-reference-data";
import { rowInDataScope } from "@/lib/ci/rules";

/**
 * TEST FIXTURE ONLY — an in-memory CiRepository for automated tests
 * (server/ci/services/security.test.ts). It is NOT part of the application:
 *  - the running app never selects it (getCiRepository() has no mock path and
 *    there is no environment switch for it);
 *  - an ESLint rule forbids importing server/ci/testing/* from anything but
 *    test files;
 *  - lookups / reference lists come from the CI Prototype (mock-reference-data.ts);
 *  - users are the example users named in the CI BRD / Prototype;
 *  - it starts with NO competitive rows.
 */

const ALL: ScopeValue = "All";

/** Example users and scopes from the CI BRD 1.1 / updated Prototype (example.com addresses). */
const MOCK_USERS: CiUser[] = [
  { id: "u1", name: "Shruti Mehta", email: "shruti.mehta@example.com", role: "CM", customerScope: ALL, segmentScope: ALL, regionScope: ALL, status: "Active" },
  { id: "u2", name: "Morgan Ellis", email: "morgan.ellis@example.com", role: "CM", customerScope: ALL, segmentScope: ALL, regionScope: ALL, status: "Active" },
  { id: "u3", name: "Sam Rivera", email: "sam.rivera@example.com", role: "Sales", customerScope: ["Micron"], segmentScope: ALL, regionScope: ALL, status: "Active" },
  { id: "u4", name: "Lee Park", email: "lee.park@example.com", role: "Sales", customerScope: ["Micron", "SK Hynix"], segmentScope: ALL, regionScope: ALL, status: "Active" },
  { id: "u5", name: "Dana Ortiz", email: "dana.ortiz@example.com", role: "Sales", customerScope: ["Samsung"], segmentScope: ["Foundry", "DRAM"], regionScope: ["Korea"], status: "Active" },
  { id: "u6", name: "Jon Alvarez", email: "jon.alvarez@example.com", role: "Sales", customerScope: ["Intel", "UMC"], segmentScope: ALL, regionScope: ALL, status: "Active" },
  { id: "u7", name: "Carly Meyer", email: "carly.meyer@example.com", role: "Sales", customerScope: ["Samsung"], segmentScope: ALL, regionScope: ALL, status: "Active" },
];

interface MockStore {
  users: CiUser[];
  records: CompetitiveRecord[];
  notes: ChangeNote[];
  audit: AuditEntry[];
  lookups: LookupValue[];
  reference: ReferenceData;
  seq: { record: number; note: number; audit: number; lookup: number; user: number };
}

function buildLookups(): LookupValue[] {
  let id = 0;
  return Object.entries(MOCK_LISTS).flatMap(([category, values]) =>
    values.map((value, i) => ({ id: `lk${++id}`, category, value, sortOrder: i + 1, active: true }))
  );
}

function buildReference(): ReferenceData {
  return {
    customers: [...MOCK_CUSTOMERS],
    customerFabs: Object.entries(MOCK_CUSTOMER_FABS).flatMap(([customer, fabs]) =>
      fabs.map(([fabLocation, fabRegion]) => ({ customer, fabLocation, fabRegion }))
    ),
    competitorProducts: Object.entries(MOCK_COMPETITOR_PRODUCTS).flatMap(([competitor, products]) =>
      Array.from(new Set(products)).map((product) => ({ competitor, product }))
    ),
    processLocations: Object.entries(MOCK_PROCESS_LOCATIONS).flatMap(([servedMarket, locations]) =>
      locations.map((processLocation) => ({ servedMarket, processLocation }))
    ),
    technologyNodes: Object.entries(MOCK_TECHNOLOGY_NODES).flatMap(([key, nodes]) => {
      const [customer, servedMarket] = key.split("|");
      return nodes.map((technologyNode) => ({ customer, servedMarket, technologyNode }));
    }),
  };
}

// Kept on globalThis so Next's dev hot-reload doesn't wipe the in-memory data
// on every edit. Bump STORE_VERSION whenever the stored shapes change, so a
// running dev server rebuilds the store instead of serving stale data.
const STORE_VERSION = 2; // 2: users carry regionScope (BRD 1.1)
const globalStore = globalThis as unknown as { __ciMockStore?: MockStore; __ciMockStoreVersion?: number };
function store(): MockStore {
  if (globalStore.__ciMockStoreVersion !== STORE_VERSION) {
    globalStore.__ciMockStore = undefined;
    globalStore.__ciMockStoreVersion = STORE_VERSION;
  }
  globalStore.__ciMockStore ??= {
    users: MOCK_USERS.map((u) => ({ ...u })),
    records: [],
    notes: [],
    audit: [],
    lookups: buildLookups(),
    reference: buildReference(),
    seq: { record: 0, note: 0, audit: 0, lookup: 10000, user: 100 },
  };
  return globalStore.__ciMockStore;
}

const clone = <T,>(v: T): T => structuredClone(v);
const nextRecordId = (s: MockStore) => `CI-${String(++s.seq.record).padStart(4, "0")}`;

const mockRepository: CiRepository = {
  async findUserByEmail(email) {
    const u = store().users.find((x) => x.email.toLowerCase() === email.trim().toLowerCase());
    return u ? clone(u) : null;
  },
  async getUser(id) {
    const u = store().users.find((x) => x.id === id);
    return u ? clone(u) : null;
  },
  async listUsers() {
    return clone(store().users);
  },
  async createUser(user) {
    const s = store();
    const created = { ...user, id: `u${++s.seq.user}` };
    s.users.push(created);
    return clone(created);
  },
  async updateUser(user) {
    const s = store();
    s.users = s.users.map((u) => (u.id === user.id ? clone(user) : u));
    return clone(user);
  },
  async setUserStatus(id, status) {
    const u = store().users.find((x) => x.id === id);
    if (u) u.status = status;
  },

  async listRecords(scope) {
    return clone(store().records.filter((r) => rowInDataScope(scope, r)));
  },
  async getRecord(recordId) {
    const r = store().records.find((x) => x.recordId === recordId);
    return r ? clone(r) : null;
  },
  async getRecords(recordIds) {
    const ids = new Set(recordIds);
    return clone(store().records.filter((r) => ids.has(r.recordId)));
  },
  async createRecord(record) {
    const s = store();
    const created = { ...record, recordId: nextRecordId(s) };
    s.records.push(created);
    return clone(created);
  },
  async updateRecord(record) {
    const s = store();
    s.records = s.records.map((r) => (r.recordId === record.recordId ? clone(record) : r));
  },
  async discardRecord(recordId) {
    const s = store();
    s.records = s.records.filter((r) => r.recordId !== recordId);
  },
  // Batch writes are applied in one synchronous step, so a batch is all-or-nothing.
  async createRecords(records) {
    const s = store();
    const created = records.map((r) => ({ ...clone(r), recordId: nextRecordId(s) }));
    s.records.push(...created);
    return clone(created);
  },
  async updateRecords(records) {
    const s = store();
    const byId = new Map(records.map((r) => [r.recordId, r]));
    const missing = records.filter((r) => !s.records.some((x) => x.recordId === r.recordId));
    if (missing.length) throw new Error(`Unknown Record ID(s): ${missing.map((m) => m.recordId).join(", ")}`);
    s.records = s.records.map((r) => (byId.has(r.recordId) ? clone(byId.get(r.recordId)!) : r));
  },
  async reassignRecords(from, to) {
    const ids: string[] = [];
    for (const r of store().records) {
      if (r.createdBy === from) {
        r.createdBy = to;
        ids.push(r.recordId);
      }
    }
    return ids;
  },

  async listNotes(recordId) {
    return clone(store().notes.filter((n) => n.recordId === recordId));
  },
  async addNotes(notes) {
    const s = store();
    s.notes.push(...notes.map((n) => ({ ...clone(n), id: `n${++s.seq.note}` })));
  },
  async listAudit(recordId) {
    return clone(store().audit.filter((a) => a.recordId === recordId));
  },
  async addAudit(entries) {
    const s = store();
    s.audit.push(...entries.map((e) => ({ ...clone(e), id: `a${++s.seq.audit}` })));
  },

  async listLookups() {
    return clone(store().lookups);
  },
  async addLookup(category, value, sortOrder) {
    const s = store();
    const created = { id: `lk${++s.seq.lookup}`, category, value, sortOrder, active: true };
    s.lookups.push(created);
    return clone(created);
  },
  async addLookups(items) {
    const out = items.map((i, n) => ({ id: `bulk-${Date.now()}-${n}`, category: i.category, value: i.value, sortOrder: i.sortOrder, active: true }));
    store().lookups.push(...out);
    return out;
  },
  async renameLookup(id, value) {
    const l = store().lookups.find((x) => x.id === id);
    if (l) l.value = value;
  },
  async deactivateLookup(id) {
    const l = store().lookups.find((x) => x.id === id);
    if (l) l.active = false;
  },
  async reorderLookups(category, orderedIds) {
    const order = new Map(orderedIds.map((id, i) => [id, i + 1]));
    for (const l of store().lookups) if (l.category === category && order.has(l.id)) l.sortOrder = order.get(l.id)!;
  },

  async getReferenceData() {
    return clone(store().reference);
  },
};

export function getMockCiRepository(): CiRepository {
  return mockRepository;
}
