import { IntegrityError } from "../contracts.ts";
import type { WalRepository } from "../wal.ts";

/**
 * GRASP-06's PR namespace: the suffix is the 32-byte (lower-case) event id.
 *
 * This is intentionally only the ref policy.  It does not accept Nostr
 * events, verify signatures, or perform the timed cleanup described by the
 * GRASP standard; those responsibilities belong to the caller/service.
 */
const prRefPattern = /^refs\/nostr\/([0-9a-f]{64})$/;

export function isPrRef(name: string): boolean {
  return prRefPattern.test(name);
}

export interface PrRepositoryOptions {
  /**
   * Return the already-verified tip for an accepted PR/PR-update event.
   * Return null when no accepted event is known yet (bounded pushes remain
   * possible in that case).
   */
  lookupTip?: (eventId: string) => Promise<string | null>;
}

export type PrRepository = Pick<WalRepository, "load" | "commit">;

/**
 * Wrap a WAL repository with the GRASP-06 PR-only ref policy.
 *
 * Validation happens completely before delegating, so a rejected mixed or
 * malformed transaction has no writes or partial application.  The WAL
 * remains responsible for normal old-value/CAS checks and pack validation.
 */
export function createPrRepository(
  repo: PrRepository,
  options: PrRepositoryOptions = {},
): PrRepository {
  return {
    load: () => repo.load(),
    commit: async (request) => {
      // Caller-owned data must not change while the accepted-event lookup awaits.
      const captured = {
        id: request.id,
        updates: request.updates.map((update) => ({ ...update })),
        ...(request.pack === undefined ? {} : { pack: request.pack.slice() }),
      };
      const eventIds: string[] = [];
      for (const update of captured.updates) {
        const match =
          typeof update.name === "string"
            ? prRefPattern.exec(update.name)
            : null;
        if (!match) {
          throw new IntegrityError(
            "GRASP-06 PR repository accepts only refs/nostr/<event-id>",
          );
        }
        // Deletions are cleanup operations and do not require a currently
        // accepted event (or tip) to exist.
        if (update.new !== null) eventIds.push(match[1]!);
      }

      if (options.lookupTip) {
        const checked = new Map<string, string | null>();
        for (const eventId of eventIds) {
          if (!checked.has(eventId))
            checked.set(eventId, await options.lookupTip(eventId));
          const knownTip = checked.get(eventId)!;
          if (
            knownTip !== null &&
            captured.updates.some(
              (update) =>
                update.name === `refs/nostr/${eventId}` &&
                update.new !== null &&
                update.new !== knownTip,
            )
          ) {
            throw new IntegrityError(
              `PR tip does not match accepted event ${eventId}`,
            );
          }
        }
      }

      return repo.commit(captured);
    },
  };
}
