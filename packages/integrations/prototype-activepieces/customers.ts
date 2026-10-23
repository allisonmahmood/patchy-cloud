/** Invented local identities and nonfunctional keys. Never real provider credentials. */
export const customers = [
  {
    companyId: "cmp_activepieces_a",
    handle: "ap-customer-a",
    name: "Customer A",
    userId: "usr_activepieces_a",
    email: "alice@customer-a.example",
    projectId: 101,
    key: "phx_mockCustomerA0000001",
    events: 12
  },
  {
    companyId: "cmp_activepieces_b",
    handle: "ap-customer-b",
    name: "Customer B",
    userId: "usr_activepieces_b",
    email: "bob@customer-b.example",
    projectId: 202,
    key: "phx_mockCustomerB0000002",
    events: 34
  }
] as const;
