import { Injectable, NotFoundException } from "@nestjs/common";

import { Repository } from "../db/repository";
import { encodeCursor, type ListingQuery } from "./users.schema";

/** The user surface (chapter 3.15, FR-013 and the clauses after it).
 *
 * EVERY ROUTE HERE NAMES ITS USER IN THE PATH, and the credential is the tenant's.
 * So "the caller" on these routes is the application, never the user named — a
 * distinction four documents got wrong for twelve analysis passes, because FR-015's
 * "a channel the caller is not a member of MUST NOT appear in their listing" is
 * vacuous when the caller is an application key: a key is a member of nothing and an
 * empty list satisfied it. The requirement is about the user the PATH names. */
@Injectable()
export class UsersService {
  constructor(private readonly repo: Repository) {}

  /** A deleted user is a 404 on every route that names them (FR-017).
   *
   * The row survives deletion — a message keeps its author, and `toFrame` drops a
   * senderless row, so "authored by a deleted user" and "authored by nobody" are
   * different states and only one of them is the clause. The marker is what makes the
   * row invisible to the API without making the message anonymous. */
  private async requireUser(externalId: string): Promise<{ id: string }> {
    const user = await this.repo.getUserByExternalId(externalId);
    if (!user || user.deleted_at !== null) {
      throw new NotFoundException("user not found");
    }
    return { id: user.id };
  }

  async listChannels(
    externalId: string,
    query: ListingQuery,
  ): Promise<{
    data: Array<Record<string, unknown>>;
    next_cursor: string | null;
  }> {
    const user = await this.requireUser(externalId);
    const { rows, nextCursor } = await this.repo.listChannelsForUser(user.id, {
      limit: query.limit,
      ...(query.cursor === undefined ? {} : { after: query.cursor }),
    });
    return {
      data: rows.map((r) => ({
        id: r.external_id,
        type: r.type,
        name: r.name,
        role: r.role,
        archived_at: r.archived_at,
        last_activity_at: r.last_activity_at,
      })),
      next_cursor:
        nextCursor === null
          ? null
          : encodeCursor(nextCursor.activityAt.toISOString(), nextCursor.id),
    };
  }
}
