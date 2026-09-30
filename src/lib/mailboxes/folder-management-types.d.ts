/**
 * Who manages folders (R-1): a user, or for a mail protocol a user through one of their mail app
 * passwords (A2), which must then still exist for that mailbox with the `imap` scope.
 */
export type FolderActor = { userId: string; appPasswordId?: string };

/**
 * Protocol-neutral outcomes of folder management. A protocol maps them to its own answers
 * (JMAP SetErrors today; IMAP response codes in A5.5).
 *
 * - `notFound`: the mailbox is not visible to the actor (no access, revoked, disabled user or
 *   mailbox, a delegate while sharing is off, a wrong credential), or the folder is not a folder
 *   of that mailbox. Nothing about the folder or its contents is revealed.
 * - `forbidden`: the mailbox is visible but the actor may not manage its folders.
 * - `invalidName`: not a string, empty after trimming, longer than the limit, or containing a
 *   control character.
 * - `alreadyExists`: another folder of the mailbox has exactly this name.
 * - `hasMessages`: the folder still holds messages (snoozed ones included).
 * - `unchanged`: a rename to the folder's current name; nothing was written.
 */
export type FolderRefusal = "notFound" | "forbidden" | "invalidName" | "alreadyExists" | "hasMessages";

export type CreateFolderResult = { outcome: "ok"; folderId: string; name: string } | { outcome: Exclude<FolderRefusal, "hasMessages"> };
export type RenameFolderResult = { outcome: "ok" | "unchanged"; name: string } | { outcome: Exclude<FolderRefusal, "hasMessages"> };
export type DeleteFolderResult = { outcome: "ok"; movedToTrash: number } | { outcome: Exclude<FolderRefusal, "invalidName" | "alreadyExists"> };
