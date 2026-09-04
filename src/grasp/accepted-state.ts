import {
  AuthorizationError,
  IntegrityError,
  LimitError,
  RepositoryUnavailableError,
  type CommitRequest,
  type GitRepository,
  type Refs,
  type RefUpdate,
} from "../contracts.ts";
import { validateRefName } from "../wal.ts";

export interface AcceptedState {
  /** Signature/maintainer verification (including pending state) is external. */
  eventId: string;
  refs: Readonly<Refs>;
  head: string | null;
}

export interface AcceptedStateOptions {
  lookupState: () => Promise<AcceptedState | null>;
  /** OID: accepted PR tip. Null: unknown event. False: known but not an admissible PR. */
  lookupPrTip?: (eventId: string) => Promise<string | null | false>;
  /** GRASP-01 unknown-event uploads require external quotas and timed cleanup. */
  allowUnknownPrRefs?: boolean;
  /** Must also fence external event acceptance; an isolated Git-only lock is insufficient. */
  serialize?: <T>(operation: () => Promise<T>) => Promise<T>;
}

const eventIdPattern = /^[a-f0-9]{64}$/;
const oidPattern = /^(?!0{40}$)[a-f0-9]{40}$/;
const prPattern = /^refs\/nostr\/([a-f0-9]{64})$/;

function captureState(value: AcceptedState | null): AcceptedState | null {
  if (value === null) return null;
  if (
    !eventIdPattern.test(value.eventId) ||
    !value.refs ||
    typeof value.refs !== "object"
  )
    throw new RepositoryUnavailableError(
      "Invalid accepted-state authority result",
    );
  const refs: Refs = Object.create(null);
  const entries = Object.entries(value.refs);
  if (entries.length > 1024)
    throw new LimitError("Accepted state exceeds ref limit");
  try {
    for (const [name, oid] of entries) {
      validateRefName(name);
      if (
        name.startsWith("refs/nostr/") ||
        typeof oid !== "string" ||
        !oidPattern.test(oid)
      )
        throw new IntegrityError("Invalid accepted-state ref");
      refs[name] = oid;
    }
    if (value.head !== null) {
      validateRefName(value.head);
      if (!value.head.startsWith("refs/heads/"))
        throw new IntegrityError("Accepted HEAD must name a branch");
    }
  } catch (cause) {
    throw new RepositoryUnavailableError(
      "Invalid accepted-state authority result",
      { cause },
    );
  }
  return { eventId: value.eventId, refs, head: value.head };
}

/**
 * Authorization only; Nostr verification/purgatory/expiry are the host's job.
 * Hold the SAME authority fence across lookup and commit AND external Nostr
 * state changes. Callbacks alone cannot atomically fence a separate R2 CAS.
 * Ordinary reads retain materialized refs so a subsequent push can supply the
 * true expected old OID. PR refs known to violate current authority are hidden.
 */
export function createAcceptedStateRepository(
  repo: GitRepository,
  options: AcceptedStateOptions,
): GitRepository {
  const run = <T>(operation: () => Promise<T>): Promise<T> =>
    options.serialize ? options.serialize(operation) : operation();

  const prTip = async (eventId: string): Promise<string | null | false> => {
    const tip = options.lookupPrTip ? await options.lookupPrTip(eventId) : null;
    if (tip !== null && tip !== false && !oidPattern.test(tip))
      throw new RepositoryUnavailableError("Invalid PR authority result");
    return tip;
  };

  return {
    load: () =>
      run(async () => {
        const state = captureState(await options.lookupState());
        const snapshot = await repo.load();
        const refs: Refs = Object.create(null);
        for (const [name, oid] of Object.entries(snapshot.refs)) {
          const pr = prPattern.exec(name);
          if (pr) {
            const tip = await prTip(pr[1]!);
            if (
              tip === oid ||
              (tip === null && options.allowUnknownPrRefs === true)
            )
              refs[name] = oid;
          } else refs[name] = oid;
        }
        // HEAD names the authority-selected branch, whose materialized old tip
        // remains useful while new state awaits Git data (including clone/checkout).
        const head = state?.head ?? null;
        return {
          ...snapshot,
          refs,
          headRef: head,
        };
      }),
    commit: (request: CommitRequest) => {
      // Copy before serialization/authority awaits: callers cannot swap authorized data.
      const captured: CommitRequest = {
        id: request.id,
        updates: request.updates.map((update) => ({ ...update })),
        ...(request.pack === undefined ? {} : { pack: request.pack.slice() }),
      };
      return run(async () => {
        const state = captureState(await options.lookupState());
        const tips = new Map<string, string | null | false>();
        const corrections: RefUpdate[] = [];
        for (const update of captured.updates) {
          validateRefName(update.name);
          const pr = prPattern.exec(update.name);
          if (pr) {
            // Anonymous Git transport is not authority to delete someone else's PR.
            // The host performs expiry cleanup through its private underlying WAL.
            if (update.new === null)
              throw new AuthorizationError(
                "PR deletion requires host cleanup authority",
              );
            const id = pr[1]!;
            if (!tips.has(id)) tips.set(id, await prTip(id));
            const tip = tips.get(id)!;
            if (
              tip !== update.new &&
              !(tip === null && options.allowUnknownPrRefs === true)
            )
              throw new AuthorizationError(
                "PR tip is not authorized by an accepted event",
              );
            if (
              update.old === null &&
              typeof tip === "string" &&
              tip === update.new
            )
              corrections.push(update);
          } else {
            if (
              !state ||
              update.name.startsWith("refs/nostr/") ||
              (state.refs[update.name] ?? null) !== update.new
            )
              throw new AuthorizationError(
                "Ref does not match accepted repository state",
              );
          }
        }
        if (corrections.length) {
          // A known-wrong PR tip is hidden in advertisements. Stock Git therefore
          // submits old=null when correcting it. Translate only this authorized
          // view mismatch; the WAL still checks the exact physical old and root CAS.
          // The authority fence must remain held across this read and the commit.
          const physical = await repo.load().catch((cause: unknown) => {
            if (cause instanceof LimitError) throw cause;
            throw new RepositoryUnavailableError(
              "Cannot reconcile PR repository view",
              { cause },
            );
          });
          const prior = physical.records.find(
            (record) => record.id === captured.id,
          );
          for (const update of corrections) {
            const original = prior?.updates.find(
              (item) => item.name === update.name,
            );
            if (
              original &&
              original.new === update.new &&
              original.old !== null &&
              original.old !== original.new
            ) {
              // A retry after successful correction now sees a visible correct
              // tip. Reconstruct its physical transaction; WAL request hashing
              // still rejects any other altered ref, pack, or transaction data.
              update.old = original.old;
            } else if (
              physical.refs[update.name] !== undefined &&
              physical.refs[update.name] !== update.new
            ) {
              update.old = physical.refs[update.name]!;
            }
          }
        }
        return repo.commit(captured);
      });
    },
  };
}
