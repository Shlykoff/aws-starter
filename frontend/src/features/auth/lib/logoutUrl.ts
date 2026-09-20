// Cognito hosted UI logout endpoint:
//   https://<domain>/logout?client_id=<app client>&logout_uri=<where to return>
// `logout_uri` must be one of the app client's allowed sign-out URLs exactly
// (http://localhost:5173/ locally, with the trailing slash).
export function buildLogoutUrl(hostedUiUrl: string, clientId: string, origin: string): string {
  const params = new URLSearchParams({ client_id: clientId, logout_uri: `${origin}/` });
  return `${hostedUiUrl}/logout?${params.toString()}`;
}
