# Now Playing service

The Now Playing widget: what's playing in Atmos, from Music, a tab in Atmos
Browser or any extension that plays something, with its controls. An official service in
a frame (`"runtime": "frame"`), installed with the first extension that
publishes to it (Audio Player and Atmos Browser name it as a recommended
dependency) and removable like any other.

```text
now-playing/
├── sidebar.js         # The widget: cover, title, line under it, progress, dots
├── assets/sidebar.css
└── src/choose.js      # Which session shows, where its playback is now (pure; tests/choose.test.mjs)
```

## How it gets what plays

Extensions don't talk to this service. They call `atmos.nowPlaying.set()`
(SDK 1.4, ATMOS_CORE_INTEGRATION.md), and Core
(`core/js/core/now-playing.js`) checks each session field by field, stamps
it with the extension that set it, and passes the list on to this service
alone (`atmos.nowPlaying.sessions(fn)`, refused to anything but the
official `service:now-playing`). A control goes back the same way:
`atmos.nowPlaying.control(id, action, value)` reaches only the session's
extension, and only for an action it said it takes. No extension sees what
another plays.

What a session can carry is plain text (title, artist, album, where it
plays), times, a volume and its artwork: a PNG, JPEG, WebP or GIF of 1 MB
and 4096 pixels a side at most, as Core reads it from its bytes (never SVG,
never an address), handed to the widget as a Blob Core made. The widget
draws it in an `<img>` through an object URL, where an image can't run
anything, and shows its placeholder if it doesn't decode. Past 20 updates a
second, the newest of each of an extension's sessions waits for the next
second, and the widget hears at most 10 lists a second
(`core/js/core/now-playing.js`).

## Which one shows

One at a time, as phones do (`chooseSession`):

1. the one picked with the dots, until something starts after the pick
   (then the pick is over for good);
2. else the one playing that started last (Music, then a video: the video);
3. else the one that played last, paused, so it can be resumed.

The dots show only with two or more sessions. Two things keep a click on
what you meant: what shows doesn't change while the pointer is over the
widget, and a click or drag goes to the session that showed when the
button went down (a press just after it changed by itself is ignored).
Core keeps a session that pauses and plays again within 3 seconds where it
was, so flicking play on and off doesn't bring one to the front, and a
community extension's start counts only just after you used it (a click
in one of its frames, which the main process sees land there, or its
controls here); otherwise it shows only when
nothing else plays. Its name is always on the line under the title, with
"· community" beside it where a long artist can't push it out, so none
passes for Music. A volume drag sends ten values a second at most, and
always the one it ended on.

## From anywhere: Space and commands

The background frame (`boot.js`, 1.1.0) acts on the session the widget
shows (the same rule, and the one picked with the dots: the widget tells
it): **Space** outside fields and buttons (`"keys": ["Space"]`), and in
Atmos's command bar `rev/play` (also `rev/pause`: one command, SDK 1.6's
`aliases`), `rev/next` and `rev/previous`, each only when the session takes
it. Music, a video in Atmos Browser and any extension's alike; Audio Player
(1.2.3) no longer has its own. With nothing playing, they say so.

## Gestures

Only the ones the session's extension takes: click the cover to play or
pause; drag up or down for its volume; drag left to restart or go back,
right for the next one. With none, the cover is inert.

The widget keeps Music's old widget id (`"legacyId": "audio-player"`), so
a sidebar laid out before 0.21 still finds it in its place. Beside an Audio
Player older than 1.2, which still has a widget of that id, the second to
start gets an id of its own; neither is lost. A community extension's
widgets take their ids after every official one's, so none can take this
one's (or its place).
