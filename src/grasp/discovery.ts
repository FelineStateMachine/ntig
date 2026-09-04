/** NIP-11-shaped discovery. No complete GRASP/Nostr relay standard is claimed. */
export function serviceInformation(repositoryPath: string) {
  return {
    name: "nostrwal",
    description:
      "Experimental container-free Git/WAL service. Nostr relay and signed-state authorization are not yet implemented.",
    version: "0.1.0",
    supported_nips: [] as number[],
    supported_grasps: [] as string[],
    repo_acceptance_criteria:
      "One operator-configured repository; public reads, bearer-token writes, bounded storage. Nostr announcements are not yet accepted.",
    nostrwal: {
      experimental: true,
      repository_path: repositoryPath,
      git_protocol: "v0",
      filters: ["blob:none", "tree:0"],
      signed_state_authorization: false,
      nostr_relay: false,
    },
  };
}

export function wantsServiceInformation(request: Request): boolean {
  return (request.headers.get("accept") ?? "").split(",").some((item) => {
    const [media, ...parameters] = item.trim().toLowerCase().split(";");
    return (
      media === "application/nostr+json" &&
      !parameters.some((parameter) =>
        /^\s*q\s*=\s*0(?:\.0*)?\s*$/.test(parameter),
      )
    );
  });
}

/** GRASP CORS applies to errors, discovery and landing pages too. */
export function withGraspCors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET, POST");
  headers.set(
    "access-control-allow-headers",
    "Content-Type, Authorization, Git-Protocol, X-Git-Request-Id",
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function repositoryPage(path: string): Response {
  const escaped = path.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>nostrwal</title><h1>nostrwal</h1><p>Experimental container-free Git repository.</p><p>Clone path: <code>${escaped}</code></p><p><a href="https://gitworkshop.dev/" rel="noreferrer">Browse Nostr Git with Git Workshop</a></p><p>This service does not yet implement a Nostr relay or signed-state push authorization.</p></html>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy":
          "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        "cache-control": "no-store",
      },
    },
  );
}
