declare module "cloudflare:workers" {
  /** The loader uses only these members of workerd's built-in entrypoint class. */
  export class WorkerEntrypoint<Env = unknown, Props = unknown> {
    protected readonly env: Env;
    protected readonly ctx: { readonly props: Props };
  }
}
