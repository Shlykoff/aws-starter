// The key attributes of the requests table (see the comment above the repositories for
// the key design). They live in the domain because two places need both directions: the
// repositories build keys from ids, and the enqueuer reads the owner back out of a
// DynamoDB stream record, which carries `pk` but not the raw owner id.

const OWNER_PREFIX = "USER#";
const REQUEST_PREFIX = "REQ#";

export const ownerKey = (ownerId: string): string => `${OWNER_PREFIX}${ownerId}`;
export const requestKey = (id: string): string => `${REQUEST_PREFIX}${id}`;

/** True for a well-formed partition key: the prefix followed by a non-empty owner id. */
export const isOwnerKey = (pk: string): boolean =>
  pk.startsWith(OWNER_PREFIX) && pk.length > OWNER_PREFIX.length;

/** The reverse of `ownerKey`. Only call it for a key that passed `isOwnerKey`. */
export const ownerIdFromKey = (pk: string): string => pk.slice(OWNER_PREFIX.length);
