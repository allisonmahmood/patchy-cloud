import { afterAll, expect } from "vitest";
import { externalRequests } from "@patchy/auth/testing";

// Every offline suite fails on a denied request, even if application code caught its error.
afterAll(() => expect(externalRequests).toEqual([]));
