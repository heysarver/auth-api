export interface GoogleProfile {
  id: string;
  name: string;
  email: string;
  picture: string;
  verified_email: boolean;
}

import type { GoogleProfile as CoreGoogleProfile } from "@better-auth/core/social-providers";

/** Preserve Google's verification claim for Better Auth's linking decision. */
export function mapGoogleProfile(profile: GoogleProfile) {
  return {
    user: {
      // better-auth >= 1.7 forbids a provider `id` in mapped user info; the raw
      // provider identity travels in `data` and `accountSubject`.
      name: profile.name,
      email: profile.email,
      image: profile.picture,
      emailVerified: profile.verified_email === true,
    },
    // The /userinfo shape differs from the id_token shape better-auth types for
    // the built-in provider; cast is type-only (runtime data is unchanged and is
    // used solely for the account key).
    data: profile as unknown as CoreGoogleProfile,
  };
}
