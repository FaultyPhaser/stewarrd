# Security policy

## Supported versions

Stewarrd is in alpha. Only the latest release receives fixes.

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Report them privately through GitHub: **Security → Report a vulnerability** on this repository.

Include the version, how Stewarrd is deployed (reverse proxy, exposed paths), and steps to reproduce. Expect a first response within a week.

Areas of particular interest:

- Bypassing the Seerr webhook secret or the Plex login.
- Reaching admin endpoints (purge, assign, import) as a regular user.
- Leaking Seerr, Radarr or Sonarr API keys to a browser.
