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

export type ExtensionSettings = {
  targetLanguage: string;
  autoTranslate: boolean;
  ollamaEndpoint: string;
  ollamaModel: string;
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
