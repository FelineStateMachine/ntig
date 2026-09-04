import {
  AuthorizationError,
  IntegrityError,
  LimitError,
  RepositoryUnavailableError,
  type CommitRequest,
  type GitRepository,
  type Refs,
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
        // Never advertise a stale branch tip as the accepted state's HEAD.
        const head = state?.head ?? null;
        return {
          ...snapshot,
          refs,
          headRef:
            head !== null &&
            snapshot.refs[head] !== undefined &&
            snapshot.refs[head] !== state!.refs[head]
              ? null
              : head,
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
        return repo.commit(captured);
      });
    },
  };
}
