export type TranslationStatus =
  | "idle"
  | "detecting"
  | "not-needed"
  | "translating"
  | "translated"
  | "restored"
  | "error";

export type TextItem = {
  id: string;
  text: string;
};

export type ApiProvider = "openai-compatible" | "anthropic";

export type ExtensionSettings = {
  targetLanguage: string;
  autoTranslate: boolean;
  apiProvider: ApiProvider;
  openaiBaseUrl: string;
  openaiModel: string;
  openaiApiKey: string;
};

export type PageAnalysis = {
  detectedLanguage: string;
  confidence: number;
  isForeign: boolean;
  shouldTranslate: boolean;
  reason: string;
};

export type TabStatus = {
  status: TranslationStatus;
  detectedLanguage?: string;
  message?: string;
  progress?: {
    done: number;
    total: number;
  };
};

export type RuntimeMessage =
  | { type: "GET_SETTINGS" }
  | { type: "SAVE_SETTINGS"; settings: ExtensionSettings }
  | { type: "SETTINGS_UPDATED" }
  | { type: "GET_TAB_STATUS"; tabId: number }
  | { type: "ANALYZE_PAGE"; sample: string }
  | { type: "TRANSLATE_ITEMS"; items: TextItem[] }
  | { type: "TRANSLATE_TEXT"; text: string; targetLanguage: string }
  | { type: "SET_TAB_STATUS"; tabId?: number; status: TabStatus };
