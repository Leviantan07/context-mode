# Mobile Interface

V1 does not ship a separate native app. The dashboard at
[`packages/dashboard`](../packages/dashboard) is mobile-first (single
column, large tap targets, dark theme, `viewport-fit=cover` for notch/home
indicator safe areas) and works as the phone interface: open it in mobile
Safari/Chrome and "Add to Home Screen" for an app-like icon and standalone
window (`packages/dashboard/public/manifest.json`).

This was a deliberate V1 trade-off, not an oversight — see
[`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) → Mobile Interface /
Notifications Mobile for why: a real native app needs app-store
distribution or at minimum push-notification credentials (APNs/FCM), both
of which are their own setup project independent of the Forge itself.

**What a real native (or PWA with push) app would add later:**

- A service worker + push subscription, so task-complete notifications
  arrive even when the tab isn't open (today: only live while the SSE
  connection is open, i.e. the dashboard tab is open).
- Native share-sheet integration ("send this to Forge" from other apps).
- Offline queueing of a task created with no connectivity.

None of these change the API contract (`packages/shared/src/types.ts`) —
they're additive to the interface, not the backend.
