# Backend authentication

The current backend authentication mode is intentionally **single-owner / self-hosted**. It is not a multi-user identity system.

## Configure the server

Copy the template and set a unique password:

```sh
cp .env.example .env
openssl rand -base64 32
```

Put the generated value into `LOCMAN_ACCESS_PASSWORD`. Keep `.env` private and do not commit it. The API refuses to start if the password is missing or shorter than 12 characters. `LOCMAN_OWNER_ID` selects the single data owner; changing it does not migrate existing project ownership.

The Compose backend is intentionally bound to loopback and runs in development mode. Do not expose it directly to the Internet. Remote access requires a TLS reverse proxy, hardened deployment, and a full security review.

## API flow

- `POST /api/v1/auth/login` with JSON `{"password":"..."}` exchanges the configured password for an opaque bearer token.
- `GET /api/v1/auth/me` returns the authenticated owner and session expiry.
- `POST /api/v1/auth/logout` revokes the current token.
- `POST /api/v1/auth/logout-all` revokes every active session belonging to the configured owner; use it after losing a device.
- All other `/api/v1` routes require `Authorization: Bearer <token>`, except the one-time GitHub App installation callback.
- Sessions expire after 30 days. Only SHA-256 token digests are stored in PostgreSQL.
- Five failed password attempts from the same observed client IP trigger a 15-minute lockout. The counter resets after a 15-minute inactivity window and clears after a successful login.
- Android stores the bearer token in AndroidX EncryptedSharedPreferences backed by Android Keystore.
- The Settings screen exposes both current-device logout and owner-wide logout; owner-wide logout clears the token on the current device after the server confirms revocation.

The GitHub App installation callback is exempt from bearer authentication because GitHub opens it in a browser. It can only complete a pending installation whose high-entropy, short-lived state was created by an authenticated session.

## Explicit limitations

- There is one configured password and one configured owner ID. There are no individual accounts, password reset, account recovery, invitations, or role-based access control.
- IP-based throttling is a defence-in-depth measure, not a substitute for edge rate limiting. When deployed behind a reverse proxy, configure trusted proxy handling carefully; do not trust arbitrary client-supplied forwarding headers.
- Session cleanup currently runs at API startup; expired sessions are still rejected immediately by every lookup.
- This authentication mode does not enable command execution. The sandbox controller remains disabled until a real isolated runner is deployed and tested.
