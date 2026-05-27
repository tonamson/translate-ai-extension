import type { ExtensionSettings, PageAnalysis } from "./types";

export function shouldAutoTranslate(settings: ExtensionSettings, analysis: PageAnalysis): boolean {
  return settings.autoTranslate && analysis.isForeign && analysis.shouldTranslate;
}
