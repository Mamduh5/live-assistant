# ADR 0008: Authenticated Chrome as the TikTok Webcast transport

Status: accepted.

## Context

TikFinity remains a useful optional local adapter, but it adds an external desktop/login dependency and its login failed in actual testing. TikTok's normal public developer APIs do not provide the general LIVE event stream needed here. A separately tested anonymous direct Webcast connection found the room but failed because TikTok returned HTTP 200 without issuing the required `ttwid`; maintaining cookie acquisition, request signing, browser impersonation, or anti-bot workarounds is outside this product.

A manual regional experiment with a dedicated, authenticated Chrome profile succeeded. Chrome stayed connected for more than five minutes and continued receiving Webcast frames while FLV/HLS/MP4 media was blocked. Real `WebcastChatMessage`, `WebcastLikeMessage`, `WebcastRoomUserSeqMessage`, and `WebcastMemberMessage` frames decoded successfully. Follow, share, gift, and subscription mappings are schema-backed and covered by synthetic tests, but have not all been validated in a real LIVE session.

## Decision

Live Assistant uses a separately started dedicated Chrome profile as the authentication and TikTok transport owner. The `tiktok-browser` connector attaches through a loopback-only Chrome DevTools Protocol endpoint, creates one owned page, enables Fetch interception before navigation, resolves every paused request, aborts locally classified livestream media, observes conservatively selected TikTok Webcast WebSockets, and decodes their binary protobuf messages locally. It never proxies, replaces, acknowledges, or recreates TikTok's WebSocket. `Network.setBlockedURLs` is not retained because its wildcard behavior failed real CDN URLs and would obscure Fetch-domain accounting.

The connector emits a small decoded TikTok-browser envelope. `normalizeTikTokBrowserEvent` is the only boundary that maps it to canonical `LiveEvent` v1. TikTok protobuf objects never reach runtime, Attention, speech, or dashboard policy. TikFinity stays available, DOM scraping is not used, and the simulator stays the default.

The minimal protobufjs schema is derived from PirateTok/live-js revision `ad822caecf91c494580102e3c1ded6f98ace71be` under 0BSD. Attribution is in `third_party/piratetok-webcast/`. No PirateTok transport, HTTP, authentication, cookie, proxy, or signing code is vendored.

## Consequences

- Chrome must already be running locally with remote debugging and a non-default persistent profile.
- The user manually logs into TikTok; Live Assistant never receives the password or reads cookies/browser storage.
- The owned page consumes browser RAM, but livestream FLV/HLS/MP4/M4S downloads are blocked by default.
- The CDP endpoint is restricted to `localhost`, `127.0.0.1`, or `::1` and must not be exposed to a LAN.
- Chrome can replace its Webcast socket without a page restart. A stale socket or full CDP loss triggers bounded recovery.
- Shutdown closes only Live Assistant's target and CDP socket. It never sends `Browser.close`, terminates Chrome, deletes the profile, or logs the user out.
- The Webcast protocol is unofficial and can change. Its connector, decoder, and normalizer isolation confines future repairs.
- Direct anonymous `ttwid` acquisition, automatic login, anti-bot bypass, DOM scraping, and TikFinity removal remain explicitly rejected.
