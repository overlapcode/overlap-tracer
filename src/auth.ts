import type { VerifyResponse } from "./types";

/**
 * Verify a user token against a team instance.
 * The token is created by the admin on the Overlap dashboard and given to the member.
 *
 * Endpoint: GET /api/v1/auth/verify
 * Response: { data: { user_id, display_name, team_name, role } }
 */
export async function verifyToken(instanceUrl: string, token: string): Promise<VerifyResponse> {
  const url = `${instanceUrl}/api/v1/auth/verify`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({} as Record<string, unknown>));
    const errMsg = (body as Record<string, unknown>).error || `HTTP ${res.status}`;
    if (res.status === 401) {
      throw new Error("Token not recognized. Ask your team admin to create a member for you.");
    }
    throw new Error(`Verification failed: ${errMsg}`);
  }

  const body = (await res.json()) as { data: VerifyResponse };
  return body.data;
}

/**
 * Fetch the list of registered repos from a team instance.
 *
 * Endpoint: GET /api/v1/repos
 * Response: { data: { repos: [{ id, name, display_name }] } }
 */
export async function fetchRepos(instanceUrl: string, token: string): Promise<string[]> {
  const url = `${instanceUrl}/api/v1/repos`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch repos: ${res.status}`);
  }

  const body = (await res.json()) as { data: { repos: { id: string; name: string; display_name: string }[] } };
  return body.data.repos.map((r) => r.name);
}
