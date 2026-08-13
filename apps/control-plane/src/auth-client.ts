import { createAuthClient } from "better-auth/react";
import { adminClient, organizationClient } from "better-auth/client/plugins";
import {
  adminAc as superuserAc,
  userAc,
} from "better-auth/plugins/admin/access";
import {
  adminAc,
  memberAc,
} from "better-auth/plugins/organization/access";

export const authClient = createAuthClient({
  plugins: [
    adminClient({
      roles: {
        superuser: superuserAc,
        user: userAc,
      },
    }),
    organizationClient({
      roles: {
        admin: adminAc,
        member: memberAc,
      },
    }),
  ],
});
