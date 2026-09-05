import {
  IntegrityError,
  type GitRepository,
  type RefSnapshot,
} from "../contracts.ts";
import {
  createAcceptedStateRepository,
  type AcceptedStateOptions,
} from "./accepted-state.ts";

const prRefPattern = /^refs\/nostr\/([0-9a-f]{64})$/;

export function isPrRef(name: string): boolean {
  return prRefPattern.test(name);
}

export interface PrRepositoryOptions {
  /** Verified, repository-scoped event tip; null is unknown, false is inadmissible. */
  lookupTip?: (eventId: string) => Promise<string | null | false>;
  /** The host must supply upload admission, deadlines and trusted cleanup. */
  allowUnknownPrRefs?: boolean;
  /** Shares the host's event-acceptance and Git-publication authority fence. */
  serialize?: AcceptedStateOptions["serialize"];
}

export type PrRepository = GitRepository;

/**
 * GRASP-06 Git policy, composed with the accepted-state authority protections.
 * Nostr verification, signer/path matching, expiry and admission belong to the
 * host. Public callers cannot delete refs; cleanup uses the private raw WAL.
 * Unknown uploads require explicit opt-in. No ordinary refs or HEAD are exposed.
 */
export function createPrRepository(
  repo: PrRepository,
  options: PrRepositoryOptions = {},
): PrRepository {
  const onlyPrRefs = <T extends RefSnapshot>(snapshot: T): T => ({
    ...snapshot,
    headRef: null,
    refs: Object.fromEntries(
      Object.entries(snapshot.refs).filter(([name]) => isPrRef(name)),
    ),
  });
  const authorized = createAcceptedStateRepository(
    {
      load: async () => onlyPrRefs(await repo.load()),
      loadRefs: async () =>
        onlyPrRefs(await (repo.loadRefs ? repo.loadRefs() : repo.load())),
      commit: (request) => repo.commit(request),
      ...(repo.lookupRecord
        ? { lookupRecord: (id: string) => repo.lookupRecord!(id) }
        : {}),
      ...(repo.getObject
        ? { getObject: (oid: string) => repo.getObject!(oid) }
        : {}),
      ...(repo.getObjectInfo
        ? { getObjectInfo: (oid: string) => repo.getObjectInfo!(oid) }
        : {}),
    },
    {
      lookupState: async () => null,
      ...(options.lookupTip ? { lookupPrTip: options.lookupTip } : {}),
      allowUnknownPrRefs: options.allowUnknownPrRefs === true,
      ...(options.serialize ? { serialize: options.serialize } : {}),
    },
  );
  return {
    load: () => authorized.load(),
    loadRefs: () => authorized.loadRefs!(),
    commit: async (request) => {
      for (const update of request.updates) {
        if (typeof update.name !== "string" || !isPrRef(update.name))
          throw new IntegrityError(
            "GRASP-06 PR repository accepts only refs/nostr/<event-id>",
          );
      }
      return authorized.commit(request);
    },
    ...(repo.getObject
      ? { getObject: (oid: string) => authorized.getObject!(oid) }
      : {}),
    ...(repo.getObjectInfo
      ? { getObjectInfo: (oid: string) => authorized.getObjectInfo!(oid) }
      : {}),
  };
}
