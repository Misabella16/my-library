# My Library: private deployment verification

This repository serves the standalone owner-only Cloudflare Pages project **momoshelf**.

## Current configuration checklist

- Cloudflare Pages Git integration: **momoshelf**, production branch `main`.
- Separate D1 database: `my-library-data`, binding `BOOK_DB`.
- Separate private R2 bucket: `my-library-private`, binding `BOOK_FILES`; no public bucket access.
- Pages runtime variables: `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `OWNER_EMAIL`.
- Cloudflare Zero Trust Access: permit **only the owner email** for `momoshelf.pages.dev` and all preview hostnames. Configure a 1-month session where permitted.
- Keep the original Novel Conservatory databases, R2 buckets and websites isolated.
- Goodreads/EPUB import and shelf-photo recognition are *not yet active*.

## Verify before uploading personal EPUBs, photos or notes

1. Check the newest production deployment in Cloudflare has succeeded after all bindings and variables were saved.
2. In an incognito/private browser with no Access session, open `https://momoshelf.pages.dev/` and `https://momoshelf.pages.dev/api/session`. Both must **not reveal the app or owner data**. Cloudflare Access login challenge is expected.
3. Repeat the anonymous check for the project's preview hostnames.
4. Sign in as the allowed owner. The library should render, and `/api/session` should confirm `authenticated: true`, `owner: true`.
5. Sign in with a different address, if available. It must be denied.
6. Confirm the new independent D1 contains all required schema tables, and R2 cover uploads remain private.
7. Confirm books, edition notes, location edits and edition cover persist after refreshing. No demo data should be inserted.
8. Backup D1/R2 before any future bulk import. Test duplicate matching and import Undo before enabling the Goodreads and EPUB importers.

## Security rule

The advanced-mode `_worker.js` must authenticate **every** route before responding with static files or API results. Never bypass this check or expose `BOOK_FILES` via a public R2 URL. Do not commit private books, photos, credentials or environment variable values to Git.

Updating this documentation triggers a fresh production build through the connected GitHub integration, subject to Cloudflare branch deployment settings.

## After changing Cloudflare Access team domain

The `momoshelf` Pages project must receive a fresh production deployment after edits to `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, or `OWNER_EMAIL`. Verify `https://momoshelf.pages.dev/_logout` redirects to the Cloudflare Access logout endpoint, rather than responding with a JSON configuration error. This check does not confirm successful owner login: after logout, sign in as the configured owner, verify `/api/session` succeeds, and confirm private browsing without an authorized account cannot read any library content. Do not enter or commit environment-variable values or session tokens here.

## Owner email adjustment: deployment note

After the owner updates the production `OWNER_EMAIL` variable in Cloudflare Pages, trigger a new deployment of `momoshelf` from `main` to apply it. Verify the authenticated owner can open the homepage and `/api/session`; anonymous and unauthorized requests must still be denied. This file contains no addresses, tokens, or secret values.

Production deployment retry after confirming only the older project responded to the initial owner-email change.

## Production deploy verification after restoring momoshelf automatic builds

After confirming `momoshelf` has production branch `main` and automatic deployments enabled, check the GitHub Cloudflare Pages status for **momoshelf specifically** on this commit. Only after that check succeeds should we test the changed `OWNER_EMAIL` value. Do not modify or delete the independent private database or R2 bucket. The original `my-library` Pages site can be removed once `momoshelf` works.
