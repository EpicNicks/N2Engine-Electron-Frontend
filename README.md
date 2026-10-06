# N2Engine Electron Frontend

A quick-and-dirty implementation of an editor frontend for my game engine project [N2Engine](https://github.com/EpicNicks/N2Engine) built to ensure the client/server architecture as well as the specific protocols are well-suited for arbitrary clients.

This is not a reflection of the final design so much as a repo of the ongoing testing.

## Running against the engine

1. Build and start the engine's editor host (`N2EditorHost`, from the [N2Engine](https://github.com/EpicNicks/N2Engine) repo). It listens on port 9999 by default (`--port` changes it, `--project <dir>` sets the project):

   ```
   N2EditorHost --port 9999 --project <path to your project>
   ```

2. Install and start the editor:

   ```
   npm install
   npm start
   ```

3. Open or create a project; the editor connects to `localhost:9999` (or press **Connect**).

The **Engine** panel (bottom right) lists the engine's subsystems from `GetEngineHealth`, e.g. `Audio Running` with `Loopback 48000 Hz, 2 channels, float32 (streamed to the editor client)`. Press **Refresh** to update it.

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
| `src/protocol/` | The protocol client, with no DOM or Electron dependencies: framing (`framing.ts`), one encode/decode spec per command (`codec.ts`), `EngineClient`, the `EventPump` for `PollEvents`, and the generated types (`protocol.generated.ts`) |
| `src/main/` | The Electron main process. It owns the `EngineClient` (the TCP connection to the editor host) and the open project's files, and answers the page's IPC calls |
| `src/shared/api.ts` | The typed API between the page and the main process: `window.engine` (protocol commands, connect/disconnect, connection state) and `window.project` (dialogs, recent projects, the project's text files), the IPC channel names, and the command allowlist |
| `src/preload/` | Forwards `window.engine` and `window.project` calls over IPC. Bundled, since a sandboxed preload can require only `electron` |
| `src/renderer/` | The page: the editor UI and the audio player. Bundled by esbuild into `dist/bundle/renderer.js` |

The window runs with `sandbox: true` and `contextIsolation: true`: the page has no Node and no raw file system. It can only call the commands in the allowlist, connect to an editor host on this machine, and read, write or delete `.scene`, `.lua`, `.json` and `.txt` files inside the open project (checked in the main process, links included).

**Framing.** Every message is `[type: uint8][payloadLength: uint32 LE][payload]`. `FrameReader` keeps received chunks in a list and copies only once a whole frame has arrived, so a multi-MB viewport frame costs one copy however many chunks it arrives in (a frame inside one chunk isn't copied at all). Responses are matched to requests in order; type ids `0xC0`-`0xFE` are reserved for server-pushed events and never consume a pending request.

## Tests and CI

```
npm run typecheck   # both tsconfigs: the Node side, and the page without Node's types
npm test            # builds, then runs src/test with node --test
```

The unit tests cover framing (split headers, many frames per chunk, a 3.7 MB frame in 64 KB chunks), the command codecs, FIFO matching, errors and disconnects, the `EventPump`, the main process's IPC checks, project path containment, and the audio decoding, jitter buffer and drift correction.

GitHub Actions (`.github/workflows/ci.yml`) runs `npm ci`, the type check and `npm test` on every push to master and every pull request. A second job checks out the engine at the commit pinned in `engine-ref.txt`, regenerates `src/protocol/protocol.generated.ts` and fails if it differs from the committed file. When the engine's protocol changes, regenerate (below) and update `engine-ref.txt` to the engine commit you generated from, in the same PR.

## Protocol

`src/protocol/protocol.generated.ts` is generated from the engine's `editor-server/protocol/protocol.json` by the engine's own TypeScript generator. After the protocol changes, regenerate it (needs Python):

```
npm run sync-protocol                      # the engine checked out next to this repo (../N2Engine)
npm run sync-protocol -- <path to N2Engine> # or anywhere else (or set N2ENGINE_DIR)
```

This runs `editor-server/protocol/generators/generate_typescript.py` with its output redirected here, so nothing in the engine repo changes. The payload layouts in `src/protocol/codec.ts` (one spec per command) are written by hand until the generator emits codecs, so update them for new or changed commands, add the `EngineClient` method, and add it to `EngineCommands` and `EngineCommandNames` in `src/shared/api.ts` if the page should be able to call it.
