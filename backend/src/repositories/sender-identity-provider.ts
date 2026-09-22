// Where create-request gets the requester's own display identity from. The service asks for it
// once, at creation, with the caller's own raw access token; it is never re-read on delivery.
export interface SenderIdentityProvider {
  /**
   * The caller's own verified e-mail, read from their access token (never from anything the
   * client sends). Throws if the token cannot be read or the account has no verified e-mail
   * attribute: a request must never be stored with an empty sender identity.
   */
  getEmail(accessToken: string): Promise<string>;
}
