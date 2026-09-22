import { GetUserCommand } from "@aws-sdk/client-cognito-identity-provider";
import type { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import type { SenderIdentityProvider } from "./sender-identity-provider";

// GetUser identifies the pool and the user from the access token itself: no UserPoolId, no
// ClientId, nothing else to pass or to scope IAM to (see infra/modules/lambda-function/main.tf,
// needs_cognito_get_user). It returns the CALLER's OWN attributes only, so this is purely a
// read of "who is asking", never a lookup of somebody else's account.
export class CognitoSenderIdentityProvider implements SenderIdentityProvider {
  constructor(private readonly client: CognitoIdentityProviderClient) {}

  async getEmail(accessToken: string): Promise<string> {
    const response = await this.client.send(new GetUserCommand({ AccessToken: accessToken }));
    const email = response.UserAttributes?.find((attribute) => attribute.Name === "email")?.Value;

    // The user pool requires and verifies an e-mail for every account (infra/modules/cognito:
    // username_attributes, auto_verified_attributes), so a missing one here means our own setup
    // is wrong, not bad input from the caller. Either way, storing an empty sender identity would
    // be worse than failing the request.
    if (email === undefined || email === "") {
      throw new Error("Cognito returned no email attribute for the caller");
    }
    return email;
  }
}
