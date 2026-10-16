import type {
  AddLookupRequest,
  ApiErrorBody,
  ApiErrorCode,
  AuditResponse,
  DependentAddRequest,
  DependentListsResponse,
  FormOptionsResponse,
  ImportApiRequest,
  LookupDeactivationImpact,
  LookupsResponse,
  OffboardPreviewResponse,
  OffboardResponse,
  RecordDetailResponse,
  RecordsResponse,
  ReferenceDataResponse,
  ReorderLookupsRequest,
  GalleryResponse,
  HomeResponse,
  CiOffboardDetailsResponse,
  CiOffboardPreviewResponse,
  CiOffboardResponse,
  CiUserRecordsResponse,
  CiUserWriteResponse,
  LoginHistoryResponse,
  DirectoryUsersResponse,
  UserAccessEntry,
  UserAccessResponse,
  SaveRecordRequest,
  SaveRecordResponse,
  SaveUserRequest,
  SessionResponse,
  UsersResponse,
} from "@/types/ci-api";
import type { CiUser, LookupValue } from "@/types/ci";
import type { FfAnalysisResponse, FfFilters, FfGroupKey } from "@/lib/ci/ff-analysis";
import type { UserFormValues as CiUserFormBody } from "@/lib/ci/user-form";
import type { BulkPreview, ExcelRowsPreview, HistoricOptions, HistoricPreview, ImportCommitResult, ParsedSheet } from "@/lib/ci/import/types";

/** A CI API failure, carrying the server's code so screens can show the right empty/error state. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: ApiErrorCode,
    readonly details: string[] = []
  ) {
    super(message);
  }
}

export function isNotConfigured(error: unknown): boolean {
  return error instanceof ApiError && error.code === "NOT_CONFIGURED";
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    cache: "no-store",
    ...init,
    headers: init?.body ? { "Content-Type": "application/json", ...init.headers } : init?.headers,
  });
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => ({}))) as Partial<ApiErrorBody> & T;
  if (!res.ok) {
    throw new ApiError(data.error ?? "Something went wrong. Please try again.", res.status, data.code ?? "INTERNAL", data.details ?? []);
  }
  return data as T;
}

const json = (body: unknown) => JSON.stringify(body);

export const ciApi = {
  session: () => request<SessionResponse>("/api/session"),

  listRecords: () => request<RecordsResponse>("/api/competitive-info"),
  getRecord: (id: string) => request<RecordDetailResponse>(`/api/competitive-info/${encodeURIComponent(id)}`),
  createRecord: (body: SaveRecordRequest) =>
    request<SaveRecordResponse>("/api/competitive-info", { method: "POST", body: json(body) }),
  updateRecord: (id: string, body: SaveRecordRequest) =>
    request<SaveRecordResponse>(`/api/competitive-info/${encodeURIComponent(id)}`, { method: "PUT", body: json(body) }),
  audit: (id: string) => request<AuditResponse>(`/api/competitive-info/${encodeURIComponent(id)}/audit`),
  formOptions: () => request<FormOptionsResponse>("/api/competitive-info/form-options"),
  previewHistoric: (sheet: ParsedSheet, options: HistoricOptions) =>
    request<HistoricPreview>("/api/competitive-info/import", {
      method: "POST",
      body: json({ importType: "historic", mode: "preview", sheet, options } satisfies ImportApiRequest),
    }),
  commitHistoric: (sheet: ParsedSheet, options: HistoricOptions) =>
    request<ImportCommitResult>("/api/competitive-info/import", {
      method: "POST",
      body: json({ importType: "historic", mode: "commit", sheet, options } satisfies ImportApiRequest),
    }),
  previewExcelRows: (sheet: ParsedSheet) =>
    request<ExcelRowsPreview>("/api/competitive-info/import", {
      method: "POST",
      body: json({ importType: "excel", mode: "preview", sheet } satisfies ImportApiRequest),
    }),
  commitExcelRows: (sheet: ParsedSheet) =>
    request<ImportCommitResult>("/api/competitive-info/import", {
      method: "POST",
      body: json({ importType: "excel", mode: "commit", sheet } satisfies ImportApiRequest),
    }),
  previewBulk: (sheet: ParsedSheet, changeNote: string) =>
    request<BulkPreview>("/api/competitive-info/import", {
      method: "POST",
      body: json({ importType: "bulk", mode: "preview", sheet, changeNote } satisfies ImportApiRequest),
    }),
  commitBulk: (sheet: ParsedSheet, changeNote: string) =>
    request<ImportCommitResult>("/api/competitive-info/import", {
      method: "POST",
      body: json({ importType: "bulk", mode: "commit", sheet, changeNote } satisfies ImportApiRequest),
    }),

  home: () => request<HomeResponse>("/api/home"),
  flatFile: () => request<RecordsResponse>("/api/competitive-ff"),
  ffAnalysis: (filters: FfFilters, group: FfGroupKey) => {
    const q = new URLSearchParams({ group });
    for (const [key, values] of Object.entries(filters)) for (const v of values ?? []) q.append(key, v);
    return request<FfAnalysisResponse>(`/api/competitive-ff/analysis?${q.toString()}`);
  },

  listUsers: () => request<UsersResponse>("/api/user-management"),
  createUser: (body: SaveUserRequest) =>
    request<{ user: CiUser }>("/api/user-management", { method: "POST", body: json(body) }),
  updateUser: (id: string, body: SaveUserRequest) =>
    request<{ user: CiUser }>(`/api/user-management/${encodeURIComponent(id)}`, { method: "PUT", body: json(body) }),
  offboardPreview: (id: string) =>
    request<OffboardPreviewResponse>(`/api/user-management/${encodeURIComponent(id)}/offboard`),
  offboard: (id: string, reassignToUserId: string) =>
    request<OffboardResponse>(`/api/user-management/${encodeURIComponent(id)}/offboard`, {
      method: "POST",
      body: json({ reassignToUserId }),
    }),

  listLookups: () => request<LookupsResponse>("/api/lookups"),
  addLookup: (body: AddLookupRequest) =>
    request<{ lookup: LookupValue }>("/api/lookups", { method: "POST", body: json(body) }),
  removeLookup: (id: string, confirmedImpact?: string) =>
    request<void>(`/api/lookups/${encodeURIComponent(id)}${confirmedImpact ? `?confirmImpact=${encodeURIComponent(confirmedImpact)}` : ""}`, { method: "DELETE" }),
  lookupRemovalImpact: (id: string) => request<LookupDeactivationImpact>(`/api/lookups/${encodeURIComponent(id)}/impact`),
  reorderLookups: (body: ReorderLookupsRequest) =>
    request<void>("/api/lookups/order", { method: "PUT", body: json(body) }),

  renameLookup: (id: string, value: string) =>
    request<void>(`/api/lookups/${encodeURIComponent(id)}`, { method: "PATCH", body: json({ value }) }),

  addLookupsBulk: (items: { category: string; value: string }[]) =>
    request<{ results: ({ ok: true; lookup: LookupValue } | { ok: false; error: string })[] }>("/api/lookups/bulk", { method: "POST", body: json({ items }) }),
  addDependentsBulk: (items: DependentAddRequest[]) =>
    request<{ results: ({ ok: true; id: string } | { ok: false; error: string })[] }>("/api/dependent-lists/bulk", { method: "POST", body: json({ items }) }),

  dependentLists: () => request<DependentListsResponse>("/api/dependent-lists"),
  addDependent: (body: DependentAddRequest) => request<{ id: string }>("/api/dependent-lists", { method: "POST", body: json(body) }),
  renameDependent: (id: string, body: { value?: string; region?: string }) =>
    request<void>(`/api/dependent-lists/${encodeURIComponent(id)}`, { method: "PATCH", body: json(body) }),
  removeDependent: (id: string) => request<void>(`/api/dependent-lists/${encodeURIComponent(id)}`, { method: "DELETE" }),
  reorderDependent: (body: { list: string; parent1: string; parent2: string; orderedIds: string[] }) =>
    request<void>("/api/dependent-lists/order", { method: "PUT", body: json(body) }),
  referenceData: () => request<ReferenceDataResponse>("/api/reference-data"),

  loginHistory: () => request<LoginHistoryResponse>("/api/login-history"),
  competitiveGallery: () => request<GalleryResponse>("/api/competitive-info/gallery"),
  ciUserRecords: () => request<CiUserRecordsResponse>("/api/user-management/ci-users"),
  createCiUser: (body: CiUserFormBody & { setupKey?: string }) => request<CiUserWriteResponse>("/api/user-management/ci-users", { method: "POST", body: json(body) }),
  updateCiUser: (id: string, body: CiUserFormBody) =>
    request<CiUserWriteResponse>(`/api/user-management/ci-users/${encodeURIComponent(id)}`, { method: "PUT", body: json(body) }),
  deactivateCiUser: (id: string) => request<CiUserWriteResponse>(`/api/user-management/ci-users/${encodeURIComponent(id)}`, { method: "DELETE" }),
  ciOffboardPreview: (id: string) => request<CiOffboardPreviewResponse>(`/api/user-management/ci-users/${encodeURIComponent(id)}/offboard`),
  ciOffboardDetails: (id: string) => request<CiOffboardDetailsResponse>(`/api/user-management/ci-users/${encodeURIComponent(id)}/offboard-details`),
  ciOffboard: (id: string, reassignToUserId: string) =>
    request<CiOffboardResponse>(`/api/user-management/ci-users/${encodeURIComponent(id)}/offboard`, { method: "POST", body: json({ reassignToUserId }) }),
  reactivateCiUser: (id: string) =>
    request<CiUserWriteResponse>(`/api/user-management/ci-users/${encodeURIComponent(id)}/reactivate`, { method: "POST" }),
  userAccessDirectory: () => request<DirectoryUsersResponse>("/api/user-access/directory"),
  /** User Access: the people added (ci_user_access), newest first. */
  userAccess: () => request<UserAccessResponse>("/api/user-access"),
  /** User Access: add one person (name + email from the Microsoft directory). */
  addUserAccess: (body: { email: string; username: string }) => request<{ entry: UserAccessEntry }>("/api/user-access", { method: "POST", body: json(body) }),
};
