/**
 * What patch code can do with each Attio attribute type. One table drives the generated client's
 * types, the host's filter building and its decoding, so the three never disagree. Effect-free:
 * the browser client reads it too.
 *
 * - `eq`: equality with one value; `anyOf`: equality with any of up to 100.
 * - `contains`: a case-insensitive substring.
 * - `range`: `gt`, `gte`, `lt`, `lte` on one attribute.
 * - `empty`: `eq: null` finds records with no value.
 * - `order`: sortable, except a multiselect select.
 */
export const attioTypes = {
  text: { eq: true, anyOf: true, contains: true, range: false, empty: true, order: true },
  number: { eq: true, anyOf: true, contains: false, range: true, empty: true, order: true },
  rating: { eq: true, anyOf: true, contains: false, range: true, empty: true, order: true },
  // Unset reads, filters and sorts as false, so it's never empty.
  checkbox: { eq: true, anyOf: false, contains: false, range: false, empty: false, order: true },
  currency: { eq: true, anyOf: true, contains: false, range: true, empty: true, order: true },
  date: { eq: true, anyOf: true, contains: false, range: true, empty: true, order: true },
  timestamp: { eq: true, anyOf: true, contains: false, range: true, empty: true, order: true },
  select: { eq: true, anyOf: true, contains: false, range: false, empty: true, order: true },
  status: { eq: true, anyOf: true, contains: false, range: false, empty: true, order: true },
  "email-address": {
    eq: true,
    anyOf: true,
    contains: true,
    range: false,
    empty: true,
    order: true
  },
  domain: { eq: true, anyOf: true, contains: true, range: false, empty: true, order: true },
  "phone-number": { eq: true, anyOf: true, contains: true, range: false, empty: true, order: true },
  "personal-name": {
    eq: true,
    anyOf: true,
    contains: true,
    range: false,
    empty: true,
    order: true
  },
  // No exact encoding of "no location" exists.
  location: { eq: true, anyOf: true, contains: true, range: false, empty: false, order: true },
  "record-reference": {
    eq: true,
    anyOf: true,
    contains: false,
    range: false,
    empty: true,
    order: false
  },
  "actor-reference": {
    eq: true,
    anyOf: true,
    contains: false,
    range: false,
    empty: true,
    order: false
  },
  interaction: { eq: false, anyOf: false, contains: false, range: true, empty: true, order: true }
} as const;
export type AttioType = keyof typeof attioTypes;
export type AttioCapability = keyof (typeof attioTypes)[AttioType];
