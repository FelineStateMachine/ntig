import assert from "node:assert/strict";
import test from "node:test";
import {
  repositoryPage,
  serviceInformation,
  wantsServiceInformation,
  withGraspCors,
} from "../src/grasp/discovery.ts";

test("discovery lists no unimplemented GRASPs or relay NIPs", () => {
  const info = serviceInformation("/repo.git");
  assert.deepEqual(info.supported_grasps, []);
  assert.deepEqual(info.supported_nips, []);
  assert.match(info.repo_acceptance_criteria, /bearer/);
  assert.equal(Object.hasOwn(info, "curation"), false);
  assert.equal(info.nostrwal.nostr_relay, false);
});

test("Nostr Accept negotiation honors q=0 and multiple media types", () => {
  const request = (accept: string) =>
    new Request("https://example.test/", { headers: { accept } });
  assert.equal(
    wantsServiceInformation(request("text/html, application/nostr+json;q=1")),
    true,
  );
  assert.equal(
    wantsServiceInformation(request("application/nostr+json;q=0.0")),
    false,
  );
  assert.equal(wantsServiceInformation(request("text/html")), false);
});

test("GRASP CORS covers errors and landing-page paths cannot inject HTML", async () => {
  const error = withGraspCors(new Response("missing", { status: 404 }));
  assert.equal(error.status, 404);
  assert.equal(error.headers.get("access-control-allow-origin"), "*");
  assert.equal(error.headers.get("access-control-allow-methods"), "GET, POST");
  assert.match(
    error.headers.get("access-control-allow-headers")!,
    /Content-Type/,
  );
  const page = repositoryPage('/<script>"&.git');
  assert.doesNotMatch(await page.text(), /<script>/);
  assert.match(
    page.headers.get("content-security-policy")!,
    /default-src 'none'/,
  );
});
