export function resolveGoogleRedirectURI(
  env: NodeJS.ProcessEnv = process.env,
) {
  const configuredValue = env.GOOGLE_REDIRECT_URI?.trim();

  if (!configuredValue) {
    return undefined;
  }

  let redirectUrl: URL;

  try {
    redirectUrl = new URL(configuredValue);
  } catch {
    throw new Error("GOOGLE_REDIRECT_URI must be an absolute URL.");
  }

  if (redirectUrl.protocol !== "https:" && redirectUrl.protocol !== "http:") {
    throw new Error("GOOGLE_REDIRECT_URI must use http or https.");
  }

  return redirectUrl.toString();
}
