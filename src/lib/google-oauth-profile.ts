export interface GoogleProfile {
  id: string;
  name: string;
  email: string;
  picture: string;
  verified_email: boolean;
}

/** Preserve Google's verification claim for Better Auth's linking decision. */
export function mapGoogleProfile(profile: GoogleProfile) {
  return {
    user: {
      id: profile.id,
      name: profile.name,
      email: profile.email,
      image: profile.picture,
      emailVerified: profile.verified_email === true,
    },
    data: profile,
  };
}
