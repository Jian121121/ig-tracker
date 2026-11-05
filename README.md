# IG Tracker (web)

Private Instagram follower tracker that runs entirely in your browser. Upload the files from
Instagram's official "Download your information" export (Followers and following, JSON) and see
who unfollowed you, who doesn't follow back, and your latest followers/following.

- No login, no scraping, no server. Files are parsed in the browser and snapshots are stored in
  the browser's IndexedDB. The site's Content-Security-Policy blocks all network requests.
- Static site: deploy this folder to Vercel with framework preset "Other" and no build command.
