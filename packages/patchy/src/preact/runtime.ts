/// <reference types="vite/client" />
import "preact/compat";

// Static debug imports would instrument production too. All entries await this once in DEV.
if (import.meta.env.DEV) await import("preact/debug");
