<!-- PROTOTYPE for #314 -->

# Execution

The credential-free side of the deployment that runs a tier 2 patch's handler code and reaches Patchy only through callbacks. Vocabulary from the execution service resolution (#298); this package is a prototype cut, not the spec's.

## Language

**Engine**:
The service that owns one workerd process running the loader Worker, binds server bundles into it by name, invokes handlers, and answers the guest's callbacks on a loopback listener with a per-invocation capability.
_Avoid_: sandbox (the browser's), worker (a workerd term), lambda

**Invocation capability**:
The opaque per-invocation reference the loopback presents on callbacks, minted by the host at admission and refused after the invocation returns or its deadline passes. Handler code never sees it.
_Avoid_: token, bearer

**Inspection**:
Loading a server bundle in a throwaway workerd process to derive its handler descriptors, with no committed version and no table capabilities. Discovery for publish and dev.
_Avoid_: dry run, preview
