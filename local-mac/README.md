# My Library | Private Mac Edition

A separate local copy of the Romantic Rococo **My Library** website. Uses Wrangler's **local** D1 SQLite emulator and **local** R2 storage. The site listens only on \`http://127.0.0.1:8788\`, not on the internet.

**Your Cloudflare Pages site, production D1 database, R2 objects, login settings, Novel Conservatory, and GitHub deployment remain unchanged.** This package intentionally contains *no* Cloudflare credentials, and nothing syncs automatically to the cloud.

## Before you start

- Mac with [Node.js LTS](https://nodejs.org/en/download/) installed (Node 22 or newer recommended). Verify in Terminal: \`node --version\` and \`npm --version\`.
- A copy of the **my-library** GitHub repository on your Mac (use GitHub's **Code → Download ZIP**, unzip into a folder, or clone the repo).
- Internet to **install** Wrangler with npm the first time. Once the dependency is installed, the local site and local book database can run without Cloudflare or D1 quota. Links and online metadata services still require internet.

### Start from a new, empty local library

Open Terminal and change into the downloaded **my-library** folder. The \`cd\` path will depend on where you saved it.

\`\`\`sh
cd ~/Downloads/my-library
npm install
npm run local:setup
npm run local:start
\`\`\`

Open **http://127.0.0.1:8788** in Safari. The same Rococo My Library layout will appear. Close the Terminal process with **Control+C** when finished. The local library persists for next time.

Do **not** run \`wrangler dev --remote\` or \`wrangler d1 execute ... --remote\`. These are not needed.

### Where are my local books saved?

\`my-library/.my-library-local/state/\`

Wrangler manages the SQLite database and local R2 files inside this directory. The directory is ignored by Git. **Don't delete or rename it while the local server is running.** This is *separate* from your live database.

### Make a local backup

Close the local server first, then run:

\`\`\`sh
npm run local:backup
\`\`\`

This copies local database and stored local file state to a dated folder under \`my-library/.my-library-local/backups/\`. Copy those backups to a private external drive or another secure place for additional protection. Local database backups do not copy files from the online R2 bucket.

## Make a copy of existing books from your live website

Your Mac copy **does not automatically contain the books already imported into the website**. You have two options.

### Option A: import your existing Goodreads CSV locally

Use the **Imports & Undo** tab on the local site, just as on your live site. Your imported books stay in local SQLite and do **not** count against Cloudflare's online D1 quota. Goodreads metadata is read on the Mac. The local importer does not automatically fetch covers, special edition photos, or EPUBs from your live site.

### Option B: restore an exported copy of the online My Library D1 database

This preserves existing database records, including books, ratings, shelves, audit history, editions, copies and notes that are stored in D1. **Only do this if the local database is still empty.** If you've started adding local books, back them up and use a fresh local folder instead of overwriting them.

First, obtain a SQL export of the **my-library-data** D1 database in Cloudflare. See [D1 export documentation](https://developers.cloudflare.com/d1/wrangler-commands/#d1-export). The remote export is a **read-only** operation but may be blocked if your D1 daily quota is already reached. It does not include private R2 object bytes. Keep the exported SQL file confidential because it can contain private notes, shelves, locations and metadata.

From the local repository folder, **before** running \`local:setup\` or adding any local books, use:

\`\`\`sh
npm install
npm run local:restore -- /absolute/path/to/my-library-export.sql
npm run local:start
\`\`\`

The restore command uses \`wrangler d1 execute BOOK_DB --local\`. It never talks to the production D1 database. If the export contains only some tables or an incompatible schema, stop and inspect it rather than forcing destructive changes.

**Important:** a D1 SQL export covers the *database only*. Images, EPUBs and other binary files in production R2 require a separate, carefully controlled copy into the local R2 store. This starter intentionally does **not** sync or download the private production R2 bucket without explicit setup.

## Privacy

- The local server binds to **127.0.0.1 only**. It is intended for use on your own Mac.
- The generated local Worker bypasses Cloudflare Access **only** in the localhost runtime at \`.my-library-local/site/_worker.js\`. The production \`_worker.js\` file and Cloudflare Access rules are never modified.
- This is **not** a replacement for full-disk encryption. Use FileVault and a password-protected Mac account, especially if the local D1 database contains reviews, notes, or shelf locations.
- Never upload \`.my-library-local\`, database exports, R2 files, or backups to GitHub or a public site.
- Do not expose port 8788 through port forwarding, tunnels, proxies, LAN sharing, or screen-sharing applications.

## Troubleshooting

**\`npm: command not found\`**: Install Node.js from nodejs.org and restart Terminal.

**\`Wrangler is not installed\`**: Run \`npm install\` in the my-library folder.

**\`port 8788 already in use\`**: Stop the previous local server with Control+C.

**\`no such table: books\`**: Run \`npm run local:setup\` before starting *unless* restoring a complete exported SQL database into a fresh local installation.

**The local library looks empty**: This is expected until you import your Goodreads CSV or a D1 SQL export. The live website is not synced automatically.

**Cloudflare login screen**: Confirm you opened **http://127.0.0.1:8788**, not **https://momoshelf.pages.dev**. The local library never needs Cloudflare login.

**I'm worried about online D1 limits**: They do not apply to local SQLite reads and writes made by Wrangler. Reading metadata from internet services, importing books into online Cloudflare D1, or exporting from your live database will still depend on those remote services.

## Development checks

\`\`\`sh
npm test
\`\`\`

CI validates that the local generated runtime changes authentication **only in its generated copy**, restricts access to loopback, uses a distinct local database and bucket, and never issues a remote D1 command.
