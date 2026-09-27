import { useEffect, useState } from "patchy/preact";
import { useQuery } from "patchy/preact";
import { patchy, describe, TeamProvider, type Company, type Deal, type Member } from "./lib.js";
import { Pipeline } from "./Pipeline.js";
import { Companies, CompanyPage } from "./Companies.js";
import { Contacts } from "./Contacts.js";
import { Import } from "./Import.js";
import { Finance } from "./Finance.js";
import { DealPanel } from "./Deal.js";

const TABS = ["Pipeline", "Companies", "Contacts", "Import", "Finance"] as const;
type Tab = (typeof TABS)[number];

export function App() {
  const [tab, setTab] = useState<Tab>("Pipeline");
  const [companyId, setCompanyId] = useState<Company["id"] | null>(null);
  const [dealId, setDealId] = useState<Deal["id"] | null>(null);
  const [me, setMe] = useState<Member["userId"] | undefined>(undefined);
  const [myName, setMyName] = useState("");
  const [helloError, setHelloError] = useState("");
  const members = useQuery(patchy.server.members.list, {});
  const companies = useQuery(patchy.server.companies.list, {});

  // Register as a teammate so others can hand records to us.
  useEffect(() => {
    patchy.server.members.hello({}).then(
      (member) => {
        setMe(member.userId);
        setMyName(member.name);
      },
      (cause: unknown) => setHelloError(describe(cause))
    );
  }, []);

  const openCompany = (id: Company["id"]) => {
    setTab("Companies");
    setCompanyId(id);
  };
  const list = companies.data ?? [];

  return (
    <TeamProvider value={{ me, members: members.data ?? [] }}>
      <div class="app">
        <nav>
          <strong class="brand">CRM</strong>
          {TABS.map((name) => (
            <button
              type="button"
              key={name}
              class={tab === name ? "active" : ""}
              onClick={() => {
                setTab(name);
                setCompanyId(null);
              }}
            >
              {name}
            </button>
          ))}
          <span class="muted small viewer" id="viewer">
            {myName && `Signed in as ${myName}`}
          </span>
        </nav>
        {helloError && (
          <p class="error" role="alert">
            {helloError}
          </p>
        )}
        {companies.error && (
          <p class="error" role="alert">
            {describe(companies.error)}
          </p>
        )}
        <main>
          {tab === "Pipeline" && <Pipeline companies={list} openDeal={setDealId} />}
          {tab === "Companies" &&
            (companyId ? (
              <CompanyPage
                id={companyId}
                companies={list}
                back={() => setCompanyId(null)}
                openDeal={setDealId}
              />
            ) : (
              <Companies companies={list} openCompany={openCompany} />
            ))}
          {tab === "Contacts" && <Contacts companies={list} />}
          {tab === "Import" && <Import />}
          {tab === "Finance" && <Finance openCompany={openCompany} />}
        </main>
        {dealId && (
          <DealPanel key={dealId} id={dealId} companies={list} close={() => setDealId(null)} />
        )}
      </div>
    </TeamProvider>
  );
}
