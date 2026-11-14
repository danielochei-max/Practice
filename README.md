# BuddyUp

BuddyUp is a mobile-friendly group challenge app. Create a challenge, share its invite link or code, check in once a day, and follow the group leaderboard.

## Run locally

1. Install Node.js (version 20 or newer).
2. Copy `.env.example` to `.env.local` and add your Supabase project URL and anon key.
3. Run `npm install` and then `npm run dev`.

The app uses Supabase anonymous sign-in, so friends can join without creating a password. For shared groups to work, configure the database using [`supabase/schema.sql`](supabase/schema.sql) and enable anonymous sign-ins in your Supabase project's authentication settings.

## Deploy

Build with `npm run build`, then deploy the generated `dist` folder to a static web host. Add the same `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` environment variables to the host. Share the deployed URL with friends; invite links include the group's join code.

Do not put a Supabase `service_role` key in this app. The anon key is intended for browser use; Row Level Security policies in the schema protect the data.
