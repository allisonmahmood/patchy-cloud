export interface HtmlValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  title: string | null;
}
