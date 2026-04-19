// ============================================================
// Case Law Types
// ============================================================

export interface SupremeCourtCase {
  id: number;
  title: string | null;
  petitioner: string | null;
  respondent: string | null;
  description: string | null;
  judge: string | null;
  author_judge: string | null;
  citation: string | null;
  case_id: string | null;
  cnr: string | null;
  decision_date: string | null;
  disposal_nature: string | null;
  court: string;
  available_languages: string | null;
  path: string | null;
  nc_display: string | null;
  year: number | null;
  judgment_text: string | null;
  pdf_url: string | null;
  created_at: string;
}

export interface HighCourtCase {
  id: number;
  court_code: string | null;
  title: string | null;
  description: string | null;
  judge: string | null;
  pdf_link: string | null;
  cnr: string | null;
  date_of_registration: string | null;
  decision_date: string | null;
  disposal_nature: string | null;
  court_name: string | null;
  year: number | null;
  bench: string | null;
  judgment_text: string | null;
  pdf_url: string | null;
  created_at: string;
}

export interface CaseChunk {
  id: number;
  source_table: "supreme_court_cases" | "high_court_cases";
  source_id: number;
  chunk_index: number;
  chunk_text: string;
  embedding: number[] | null;
  created_at: string;
}

// ============================================================
// User Types
// ============================================================

export type UserPlan = "free" | "monthly" | "yearly";
export type SubscriptionStatus = "active" | "inactive" | "cancelled";

export interface User {
  id: number;
  firebase_uid: string;
  email: string;
  display_name: string | null;
  photo_url: string | null;
  plan: UserPlan;
  queries_used_today: number;
  queries_reset_date: string;
  razorpay_customer_id: string | null;
  razorpay_subscription_id: string | null;
  subscription_status: SubscriptionStatus;
  subscription_end_date: string | null;
  is_staff: boolean;
  created_at: string;
  updated_at: string;
}

// ============================================================
// Chat Types
// ============================================================

export interface ChatSession {
  id: string; // UUID
  user_id: number;
  title: string | null;
  filters: SearchFilters;
  created_at: string;
  updated_at: string;
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface ChatMessage {
  id: string; // UUID
  session_id: string;
  role: "user" | "assistant";
  content: string;
  cited_cases: CitedCase[];
  search_query: string | null;
  search_results: SearchResult[] | null;
  context_sent: string | null;
  model: string | null;
  token_usage: TokenUsage | null;
  response_time_ms: number | null;
  error: string | null;
  status: "success" | "error";
  created_at: string;
}

export interface CitedCase {
  id: number;
  source_table: "supreme_court_cases" | "high_court_cases";
  title: string;
  citation: string | null;
  pdf_url: string | null;
  pdf_path: string | null;
}

export interface CitationRef {
  case: CitedCase;
  paragraph: string | null;
}

export interface ParagraphDetail {
  source_table: "supreme_court_cases" | "high_court_cases";
  source_id: number;
  paragraph_number: string;
  paragraph_text: string;
  paragraph_order: number;
  kind: "numbered" | "synthetic";
  matched_as: "exact" | "parent";
}

// ============================================================
// Search Types
// ============================================================

export interface SearchFilters {
  court?: string;
  yearFrom?: number;
  yearTo?: number;
  citation?: string;
  extractedPetitioner?: string;
  extractedRespondent?: string;
  caseCategory?: string;
  caseNumber?: string;
  judgeName?: string;
  actCited?: string;
  keyword?: string;
}

export interface SearchResult {
  id: number;
  source_table: "supreme_court_cases" | "high_court_cases";
  title: string;
  petitioner: string | null;
  respondent: string | null;
  judge: string | null;
  decision_date: string | null;
  citation: string | null;
  court: string;
  disposal_nature: string | null;
  pdf_url: string | null;
  pdf_path: string | null;
  snippet: string;
  relevance_score: number;
}

export interface SearchParams {
  searchTerms: string;
  queryEmbedding: number[];
  filters: SearchFilters;
  limit?: number;
}

// ============================================================
// Filter Options (for the filter panel dropdowns)
// ============================================================

export interface FilterOptions {
  courts: string[];
  years: { min: number; max: number };
  citations: string[];
  extractedPetitioners: string[];
  extractedRespondents: string[];
  caseCategories: string[];
  caseNumbers: string[];
  judgeNames: string[];
  actsCited: string[];
  keywords: string[];
}

// ============================================================
// API Response Types
// ============================================================

export interface ChatResponse {
  message: ChatMessage;
  cases: SearchResult[];
  title: string | null;
}

export interface ApiError {
  error: string;
  message?: string;
}

// ============================================================
// Judgment Search Types (for /judgments page)
// ============================================================

export interface JudgmentSearchResult {
  id: number;
  source_table: "supreme_court_cases" | "high_court_cases";
  title: string;
  citation: string | null;
  petitioner: string | null;
  respondent: string | null;
  decision_date: string | null;
  court: string;
  case_category: string | null;
  year: number | null;
  has_pdf: boolean;
}

export interface FilterDiagnostic {
  filterName: string;
  filterValue: string;
  count: number;
}

export interface JudgmentSearchResponse {
  results: JudgmentSearchResult[];
  total: number;
  page: number;
  limit: number;
  diagnostics?: FilterDiagnostic[];
}

// ============================================================
// Error Logging Types
// ============================================================

export type ErrorCategory =
  | "extraction"
  | "fetching"
  | "search"
  | "auth"
  | "payment"
  | "chat"
  | "database"
  | "pipeline"
  | "frontend";

export type ErrorSeverity = "warning" | "error" | "critical";

export interface ErrorLog {
  id: number;
  category: ErrorCategory;
  severity: ErrorSeverity;
  message: string;
  stack_trace: string | null;
  metadata: Record<string, unknown>;
  user_id: number | null;
  endpoint: string | null;
  method: string | null;
  resolved: boolean;
  resolved_at: string | null;
  created_at: string;
}
