import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";

const client = new QueryClient();

function QueryProbe({ client }: { client: QueryClient }) {
  const result = useQuery({
    queryKey: ["extension-query"],
    queryFn: async () => "from-query-fn",
  });
  const data = result.data;

  const report = [
    `client=${client instanceof QueryClient ? "pass" : "fail"}`,
    `provider=${typeof QueryClientProvider === "function" ? "pass" : "fail"}`,
    `query=${"data" in result ? "pass" : "fail"}`,
  ].join(" | ");

  const verdict = report.includes("fail") ? "fail" : "pass";

  return (
    <div data-extension-query="report">
      <output>{report}</output>
      <output>{data === undefined ? "loading" : String(data)}</output>
      <data value={verdict}>{verdict}</data>
    </div>
  );
}

export function App() {
  return (
    <section data-extension-query="self-check">
      <h1>extension tanstack-query PoC</h1>
      <QueryClientProvider client={client}>
        <QueryProbe client={client} />
      </QueryClientProvider>
    </section>
  );
}
