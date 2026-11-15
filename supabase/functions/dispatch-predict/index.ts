// Starts one prediction on GitHub Actions for a row the caller owns.
// Deploy this file as the Edge Function dispatch-predict, with Verify JWT on.
// Secret, set in the Supabase dashboard: GITHUB_DISPATCH_TOKEN.

const edge = (globalThis as unknown as {
  Deno: {
    env: { get(name: string): string | undefined };
    serve(handler: (req: Request) => Response | Promise<Response>): void;
  };
}).Deno;

const REPO = "Christos7605/cropfather";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

async function signedInUser(url: string, anon: string, auth: string): Promise<string | null> {
  const response = await fetch(`${url}/auth/v1/user`, {
    headers: { Authorization: auth, apikey: anon },
  });
  if (!response.ok) return null;
  const body = (await response.json()) as { id?: unknown };
  return typeof body.id === "string" ? body.id : null;
}

async function ownsGithubRun(url: string, anon: string, auth: string, runId: string, userId: string): Promise<boolean> {
  const response = await fetch(
    `${url}/rest/v1/prediction_runs?id=eq.${runId}&select=id,status,via,user_id`,
    { headers: { Authorization: auth, apikey: anon, Accept: "application/json" } },
  );
  if (!response.ok) return false;
  const rows = (await response.json()) as { status?: unknown; via?: unknown; user_id?: unknown }[];
  const row = Array.isArray(rows) ? rows[0] : undefined;
  return !!row && row.user_id === userId && row.status === "predict" && row.via === "github";
}

edge.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  const url = edge.env.get("SUPABASE_URL") ?? "";
  const anon = edge.env.get("SUPABASE_ANON_KEY") ?? "";
  const token = edge.env.get("GITHUB_DISPATCH_TOKEN") ?? "";
  const auth = req.headers.get("Authorization") ?? "";
  if (!url || !anon || !auth.toLowerCase().startsWith("bearer ")) {
    return json(401, { error: "Not signed in" });
  }

  const userId = await signedInUser(url, anon, auth);
  if (!userId) return json(401, { error: "Not signed in" });

  let runId = "";
  try {
    const body = await req.json();
    runId = typeof body?.run_id === "string" ? body.run_id : "";
  } catch {
    runId = "";
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId)) {
    return json(400, { error: "Missing run" });
  }

  if (!(await ownsGithubRun(url, anon, auth, runId, userId))) {
    return json(404, { error: "Prediction not found" });
  }
  if (!token) return json(500, { error: "The prediction cannot be started" });

  const response = await fetch(`https://api.github.com/repos/${REPO}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "cropfather-dispatch-predict",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({
      event_type: "predict",
      client_payload: { run_id: runId },
    }),
  });
  if (!response.ok) return json(502, { error: "The prediction could not be started" });
  return json(200, { ok: true });
});
