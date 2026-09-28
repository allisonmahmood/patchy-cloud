export class InvalidManifestError extends Error {
  readonly code = "invalid_manifest";
  readonly exitCode = 1;
  constructor(message: string) {
    super(message);
    this.name = "InvalidManifestError";
  }
}
