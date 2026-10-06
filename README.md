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

- It polls `GetAudio` every 25 ms (timed from the previous response, so requests never overlap), independently of the render loop. Each response holds everything mixed since the previous one (at most 250 ms), 48 kHz stereo, float32 or int16.
- The samples go into a jitter buffer that keeps about 100 ms scheduled ahead of playback, on a 48 kHz `AudioContext` (scheduled `AudioBufferSourceNode`s). Audio therefore trails the rendered frames by about 100 ms.
- The server mixes by its own clock and the sound card plays by its own, so the buffer slowly drifts. The buffer level is smoothed over chunks (an exponential moving average); when it leaves a ±20 ms band around the target, each chunk is resampled by at most 0.1% until it is back within 10 ms. If it runs dry (an underrun) or the server reports `droppedFrames` (we fell more than 250 ms behind), the buffer restarts at the target. Both are logged to the console and counted in the toolbar.
- **Mute** in the toolbar mutes or unmutes it, and the setting is remembered. The window allows autoplay, but if the `AudioContext` is still suspended the button reads **Enable audio**; click it to start playback.
- The toolbar shows the audio state: how much is buffered, `muted`, `none` when the engine isn't on a loopback device (`GetAudio` returns an error and the editor stops asking), or an error. Playback stops on disconnect.

The decoding and jitter-buffer logic is in `src/audio-stream.ts` (no DOM or Electron dependencies); the Web Audio side is `src/audio-player.ts`.

## Tests

```
npm test
```

Builds, then runs the unit tests in `src/test` with `node --test` (sample decoding, the jitter buffer, drift correction).

## Protocol

`src/protocol.generated.ts` is generated from the engine's `editor-server/protocol/protocol.json` by the engine's own TypeScript generator. After the protocol changes, regenerate it (needs Python):

```
npm run sync-protocol                      # the engine checked out next to this repo (../N2Engine)
npm run sync-protocol -- <path to N2Engine> # or anywhere else (or set N2ENGINE_DIR)
```

This runs `editor-server/protocol/generators/generate_typescript.py` with its output redirected here, so nothing in the engine repo changes. `src/engine-client.ts` (one method per command) is written by hand, so update it for new or changed commands.
