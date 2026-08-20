# PirateTok Webcast schema attribution

`src/vendor/piratetok-webcast/schema.js` is a minimal JavaScript derivative of the protobufjs schema in
[PirateTok/live-js](https://github.com/PirateTok/live-js), revision
`ad822caecf91c494580102e3c1ded6f98ace71be` (`src/proto/schema.ts` and `src/proto/messages.ts`).

Only Webcast frame envelopes and the fields needed for chat, gift, like, social, room-user,
member, subscription, common metadata, and user identity are retained. No PirateTok HTTP,
authentication, cookie, signing, proxy, profile, or WebSocket transport code is included.

The derived schema is distributed under the 0BSD license reproduced in `LICENSE`.
