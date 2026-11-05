import type { GoogleProfile as BetterAuthGoogleProfile } from "better-auth/social-providers";

export interface GoogleProfile {
  id: string;
  name: string;
  email: string;
  picture: string;
  verified_email: boolean;
}

/**
 * Preserve Google's verification claim for Better Auth's linking decision,
 * and expose the profile as the raw claim record Better Auth 1.7 uses to
 * derive the OAuth account key.
 *
 * better-auth 1.7 resolves the account key from `accountSubject`, which for
 * Google reads `profile.sub` from this `data` payload. The v2 userinfo
 * endpoint returns `id` and not `sub`, and a missing subject makes 1.7 throw
 * OAUTH_ACCOUNT_SUBJECT_INVALID, so `sub` is mapped from `id`. The value is
 * identical to the one earlier versions stored, so existing account rows keep
 * matching and no re-link or duplicate account is created.
 *
 * `user.id` is no longer part of the OAuth2UserInfo contract in 1.7 and is
 * therefore not returned here.
 *
 * The cast is deliberate. better-auth types `data` as the decoded ID token,
 * which carries claims this userinfo response never has (aud, azp, iat, iss).
 * The only field better-auth reads from `data` is `sub`, via `accountSubject`,
 * and that field is guaranteed below.
 */
export function mapGoogleProfile(profile: GoogleProfile) {
  const data = {
    ...profile,
    sub: profile.id,
  };

  return {
    user: {
      name: profile.name,
      email: profile.email,
      image: profile.picture,
      emailVerified: profile.verified_email === true,
    },
    data: data as unknown as BetterAuthGoogleProfile,
  };
}
