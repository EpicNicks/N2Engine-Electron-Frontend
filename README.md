# N2Engine Electron Frontend

A quick-and-dirty implementation of an editor frontend for my game engine project [N2Engine](https://github.com/EpicNicks/N2Engine) built to ensure the client/server architecture as well as the specific protocols are well-suited for arbitrary clients.

This is not a reflection of the final design so much as a repo of the ongoing testing.

## Running against the engine

The editor launches the engine's editor host (`N2EditorHost`, from the [N2Engine](https://github.com/EpicNicks/N2Engine) repo) itself, one host per open project. Build the engine first, then:

1. Tell the editor where `N2EditorHost` is, in either of two ways:
   - on the welcome screen, press **Locate N2EditorHost...** and pick it. The path is saved in `settings.json` in the editor's user data folder (`%APPDATA%\n2enginewebfrontend` on Windows), and **Change...** picks another. A configured path wins; or
   - set `N2ENGINE_HOST` to the executable's path before starting the editor. It is used when no path is configured.

2. Install and start the editor:

   ```
   npm install
   npm start
   ```

   `npm run dev` does the same with DevTools open (or set `N2_EDITOR_DEVTOOLS=1`).

3. Open a project folder, or reopen one from **Recent Projects**. Recent projects are kept as plain paths in `recent-projects.json` in the user data folder, and the **×** removes one from the list.

**Creating a project** (engine [#90](https://github.com/EpicNicks/N2Engine/pull/90), phase E3 of #6) runs `N2EditorHost --create <folder> --name <name>`, which writes the project (`project.n2proj` and its layout) without starting the engine. **Create New Project** asks for a folder (it needn't exist) and a name (the folder's name by default). The editor never writes the project file itself, and reads the result as engine #90 specifies:

- exit code 0: stdout has one line, `N2EditorHost created projectId=<uuid> startupScene=res://scenes/Main.scene` (space-separated key=value fields after the prefix; unknown keys are ignored, in any order). The editor then opens the folder;
- exit code 2: the folder already has a `project.n2proj`, and nothing was changed. The editor offers to open it;
- exit code 1: the host's reason, on stderr, is shown.

Whether a host can create projects is asked with `N2EditorHost --help`, which prints the usage and exits without starting the engine: a host whose usage has no `--create` is older than engine #90, and **Create New Project** is disabled with a note saying so. With a host that has projects, a folder without `project.n2proj` isn't a project (the host would refuse it with exit code 1 before its engine starts). Opening one offers to make it a project where it is: `--create` adopts the folder, keeping its files, with `--project-id from-path` so its assets keep the UUIDs they had. All of this is in `src/main/host-launcher.ts` (`createProjectWithHost`, `parseCreatedLine`, `probeHostCapabilities`) and `src/main/project-session.ts`.

The **Engine** panel (bottom right) lists the engine's subsystems from `GetEngineHealth`, e.g. `Audio Running` with `Loopback 48000 Hz, 2 channels, float32 (streamed to the editor client)`. Press **Refresh** to update it.

## The editor host process

Opening a project launches

```
N2EditorHost --project <dir> --port 0 --token-env N2_EDITOR_TOKEN --exit-on-disconnect --exit-on-stdin-eof
```

(`src/main/host-launcher.ts`, `src/main/project-session.ts`):

- **The port.** With `--port 0` the OS picks a free port. The host prints `N2EditorHost ready port=<port>` on stdout once it listens. The editor reads stdout line by line, joins lines split across chunks, strips the `\r` of Windows line endings, and ignores fields it doesn't know (the engine's `docs/logging-and-editor.html`, "The ready line"). Then it connects and says Hello. If the host exits first, or isn't ready within 30 s (`readyTimeoutMs` in `settings.json` changes that), opening fails with the host's last stderr lines (or stdout, if stderr is empty), and the host is killed. stdout is read until it ends, so the host never blocks on a full pipe.
- **The token.** Each launch gets a new random token (32 bytes, hex). It is put in `N2_EDITOR_TOKEN` in the child's environment only. It is never in the editor's own environment, on a command line (which other local processes can read), in a log line, or in anything sent to the page. The host reads the variable and removes it from its own environment. An `N2_EDITOR_TOKEN` the editor itself inherited is removed at startup, so nothing inherits it.
- **Its lifetime.** `--exit-on-disconnect` makes the host exit when the editor's session ends, so a connected host can't outlive the editor, even if the editor is killed. The editor also kills the host itself when you open another project, close the project or reload the page (which goes back to the welcome screen). Quitting (`before-quit`, `window-all-closed`, SIGINT/SIGTERM, the process's `exit`) calls `ProjectSession.shutdown()`, which is final: it kills the host and any child still being spawned (a host starting, or `--create`), and nothing is spawned after it. Each operation also runs with the generation it was queued in, and closing the project (so also a reload) starts a new one: an open that was queued before, or still waiting for the old host to die, spawns nothing. **Stop host** and **Close project** kill a host that is still starting at once, without waiting for its launch, and the open waiting on it ends as cancelled, not as an error.
- **A host that ends on its own** (it crashed, or its session ended) is shown in the toolbar and the console with its exit code and last output lines. That includes a host that dies between its ready line and the editor's Hello: the failed connection waits briefly for the process's exit, and reports that instead of the closed connection. **Start host** launches a new one for the open project. **Stop host** sends `Shutdown` and kills the host if it hasn't exited after 3 s. **Restart host** stops it and launches a new one.
- **Before the first Hello.** A host started with a token ignores connections that never say Hello, so `--exit-on-disconnect` can't end a host whose launcher died between spawning it and connecting. The editor kills it on every path it can run code on. For a launcher that is killed outright, the editor keeps the host's stdin open as a pipe and never writes to it: the pipe closes when the editor dies. The editor passes `--exit-on-stdin-eof` (opt-in in the engine), so the host exits when that pipe closes.

The toolbar shows the host's state: starting, connected, stopped, exited or failed. The page sees it through `window.host` and never picks a host, port or token.

## The console

The **Console** tab of the bottom panel shows the host's log. The editor reads it with `PollEvents` about every 100 ms (`src/renderer/console-store.ts`, with the `EventPump` in `src/protocol/event-pump.ts`). It follows the epoch rule in the engine's docs ("Events: PollEvents and the log ring"):

- the first poll sends epoch 0 and seq 0, which gets everything the host still has, startup lines included;
- every later poll sends the last response's `epoch` and `nextSeq`, across reconnects too, so nothing is missed or repeated;
- a newly launched host (a restart, or another project) starts again from (0, 0), so its whole log is read;
- a response in an epoch other than the one asked about (another host process, or the ring starting over when its seqs ran out) starts a new log, and the console says so;
- `dropped` events (ones that fell off the host's ring before the editor read them) are noted with their count.

The console also shows the editor's own notes: a host starting, a host exiting with its last output, and rendering stopping. It keeps the last 5000 lines and can be filtered by level and by text. **Clear** empties it; the host's log isn't read again.

## Audio

The editor host runs headless, so its audio is mixed on an OpenAL loopback device and streamed to the editor rather than played by the engine. The editor plays it:

- It polls `GetAudio` every 25 ms (timed from the previous response, so requests never overlap), independently of the render loop. It shares the connection with `RenderFrame`, though, and the server answers one request at a time in order, so a `GetAudio` sent while a frame renders waits for it: frames slower than the buffer's slack (about 90 ms) can cause underruns. Each response holds everything mixed since the previous one (at most 250 ms), 48 kHz stereo, float32 or int16.
- The samples go into a jitter buffer that keeps about 100 ms scheduled ahead of playback, on a 48 kHz `AudioContext` (scheduled `AudioBufferSourceNode`s). Audio therefore trails the rendered frames by about 100 ms.
- The server mixes by its own clock and the sound card plays by its own, so the buffer slowly drifts. The buffer level is smoothed over chunks (an exponential moving average); when it leaves a ±20 ms band around the target, each chunk is resampled by at most 0.1% until it is back within 10 ms. If it runs dry (an underrun) or the server reports `droppedFrames` (we fell more than 250 ms behind), the buffer restarts at the target. Both are logged to the console and counted in the toolbar.
- **Mute** in the toolbar mutes or unmutes it, and the setting is remembered. The window allows autoplay, but if the `AudioContext` is still suspended the button reads **Enable audio**; click it to start playback.
- The toolbar shows the audio state: how much is buffered, `muted`, `none` when the engine isn't on a loopback device (`GetAudio` returns an error and the editor stops asking), or an error. Playback stops on disconnect.

The decoding and jitter-buffer logic is in `src/audio-stream.ts` (no DOM or Electron dependencies); the Web Audio side is `src/renderer/audio-player.ts`, in the page. The main process decodes each `GetAudio` response to float32 and the samples reach the page through `window.engine.getAudio`.

## Architecture

| Where | What |
|---|---|
| `src/protocol/` | The protocol client, with no DOM or Electron dependencies: reading frames (`framing.ts`), one spec per command built from the generated codecs (`codec.ts`), `EngineClient`, the `EventPump` for `PollEvents`, and the generated ids, types and codecs (`protocol.generated.ts`) |
| `src/main/` | The Electron main process. It launches the project's editor host (`host-launcher.ts`, `project-session.ts`, `host-settings.ts`), owns the `EngineClient` (the TCP connection to the host) and the open project's files, keeps the recent projects, and answers the page's IPC calls |
| `src/shared/api.ts` | The typed API between the page and the main process: `window.engine` (protocol commands and connection state), `window.host` (the host process: state, restart, stop, locate) and `window.project` (dialogs, recent projects, the project's text files), the IPC channel names, and the command allowlist |
| `src/preload/` | Forwards `window.engine`, `window.host` and `window.project` calls over IPC. Bundled, since a sandboxed preload can require only `electron` |
| `src/renderer/` | The page, in Preact with `@preact/signals`, bundled by esbuild into `dist/bundle/renderer.js`. `store.ts` (`EditorStore`) holds the editor's state as signals (the open project, recent projects, the host, the connection, what is busy or failed) and its actions; `console-store.ts` holds the console. Both take the page's API as a parameter, so they are tested in Node. The components (`.tsx`) are the welcome screen, the editor layout and its panels. The panels on today's commands (files, hierarchy, inspector, engine, scripts) keep their state in `scene-state.ts`. The audio player is here too |

The window runs with `sandbox: true` and `contextIsolation: true`: the page has no Node and no raw file system. It can only call the commands in the allowlist, with arguments of the declared types (`EngineCommandArgs`), on the host the main process launched, and read, write or delete `.scene`, `.lua`, `.json` and `.txt` files inside the open project. The main process checks all of it: paths must resolve inside the project (links followed, dangling links refused; no `:`, Windows device names or trailing dots and spaces), and reads are capped at 16 MiB. IPC is answered only for the editor's own page in its window's main frame; the window can't navigate, redirect or open windows, and every permission request is denied.

**Framing.** Every message is `[type: uint8][payloadLength: uint32 LE][payload]`. `FrameReader` keeps received chunks in a list and copies only once a whole frame has arrived, so a multi-MB viewport frame costs one copy however many chunks it arrives in (a frame inside one chunk isn't copied at all). Responses are matched to requests in order; type ids `0xC0`-`0xFE` are reserved for server-pushed events and never consume a pending request. Decoded `bytes` fields (a frame's pixels) are views into the payload. IPC posts a view's whole underlying buffer, so before a result goes over IPC the main process copies a view that uses only a small part of its buffer (one inside a socket chunk holding other frames); a frame assembled from several chunks owns its buffer, all but the 8-byte header of which is the pixels, and is posted without a copy.

**Hello.** Each connection starts with `Hello` (protocol 1.2): `connect()` sends the client name, the protocol version and the host's access token, and resolves with the host's `ServerInfo` (protocol and engine versions, capabilities, whether a project is loaded), which the page gets in the connection state. Nothing else is sent until it succeeds, and the pre-`Hello` payload is kept under the host's 64 KiB limit. A refused `Hello` (a wrong token, another major protocol version) or no answer within 10 s (the host's 5 s Hello deadline, which starts only when it accepts the connection, plus a margin) fails the connect and closes the connection, and the editor kills that host. The token is the one the editor generated for that launch (see "The editor host process"); the main process never sends it to the page. Hosts speaking protocol 1.0.x (no `Hello`) aren't supported: the editor is pinned to an engine commit (`engine-ref.txt`) and expects its protocol.

## Tests and CI

```
npm run typecheck   # two tsconfigs: the Node side (main, preload, protocol, tests) and the page (.tsx, without Node's types)
npm test            # builds, then runs src/test with node --test
```

`tsconfig.json` compiles the Node side to `dist` for Electron and the tests, including the page's framework-free modules (the store, the console, the audio player). `tsconfig.renderer.json` type checks the page, Preact components included (`jsx: react-jsx`, `jsxImportSource: preact`). esbuild bundles the page and the preload (`scripts/bundle.js`).

The unit tests cover:

- framing: split headers, many frames per chunk, and a 3.7 MB frame in 64 KB chunks;
- the command specs against the engine's golden vectors (`src/protocol/test-vectors.json`);
- `Hello`: tokens, refusals and the timeout;
- FIFO matching, errors and disconnects;
- the `EventPump` and the epoch rule;
- the main process's IPC checks (`PollEvents` included), and that the token never reaches the page;
- the launcher:
  - ready-line parsing, with `\r`, chunks split mid-line, unknown fields, a timeout and an early exit;
  - the host's arguments, and the token being only in the child's environment;
  - the `--create` contract (the created line, exit codes 0, 1 and 2, a host without `--create`) and the `--help` probe;
  - a real child process run in place of the host;
- `ProjectSession`: launching, connecting, killing and restarting the host, a host that exits (also between its ready line and Hello), shutdown or a reload while the old host is dying or `--create` runs, stop and close while a host starts, and folders that aren't projects yet;
- `EditorStore` and the console: the epoch and seq cursor across reconnects and new hosts, filtering, the size cap, and the open and create flows (adopting a folder, a folder that already is a project);
- `SceneState`: a refused transform is reverted, and a script whose rescan fails is deleted;
- recent projects and the host's configured path and ready timeout;
- project path containment;
- the audio decoding, jitter buffer and drift correction.

GitHub Actions (`.github/workflows/ci.yml`) runs `npm ci`, the type check and `npm test` on every push to master and every pull request, and `npm test` again on Windows (where the engine runs, and where the launcher's pipes and kill differ). Another job checks out the engine at the commit pinned in `engine-ref.txt`, regenerates `src/protocol/protocol.generated.ts` and `src/protocol/test-vectors.json`, and fails if either differs from the committed file. When the engine's protocol changes, regenerate (below) and update `engine-ref.txt` to the engine commit you generated from, in the same PR.

## Protocol

`src/protocol/protocol.generated.ts` (ids, types and an encoder and decoder for every message) is generated from the engine's `editor-server/protocol/protocol.json` by the engine's own TypeScript generator, and `src/protocol/test-vectors.json` is the engine's golden vectors, copied. Neither is edited by hand. After the protocol changes, regenerate them (needs Python):

```
npm run sync-protocol                      # the engine checked out next to this repo (../N2Engine)
npm run sync-protocol -- <path to N2Engine> # or anywhere else (or set N2ENGINE_DIR)
```

This runs `editor-server/protocol/generators/generate_typescript.py --out src/protocol/protocol.generated.ts`, so nothing in the engine repo changes. `src/protocol/codec.ts` builds each command's spec from the generated codecs, so a new command gets one with no hand-written layout; add the `EngineClient` method, and add it to `EngineCommands` and `EngineCommandNames` in `src/shared/api.ts` if the page should be able to call it.
