import { test, describe, beforeEach } from "node:test"
import * as assert from "node:assert/strict"
import { AudioPlayer, AudioPlayerStatus } from "../audio-player"
import { AudioSamples } from "../audio-stream"

// Just enough of Web Audio for AudioPlayer, recording what it schedules
class StubNode {
  connect(): void {}
  disconnect(): void {}
}

class StubContext extends StubNode {
  static instances: StubContext[] = []
  state = "running"
  currentTime = 0
  closed = false
  started: number[] = []
  destination = new StubNode()
  onstatechange: (() => void) | null = null

  constructor() {
    super()
    StubContext.instances.push(this)
  }

  createGain(): unknown {
    return Object.assign(new StubNode(), { gain: { value: 1, setTargetAtTime(): void {} } })
  }

  createBuffer(channels: number, length: number): unknown {
    return { numberOfChannels: channels, length, copyToChannel(): void {} }
  }

  createBufferSource(): unknown {
    const context = this
    return Object.assign(new StubNode(), {
      buffer: null,
      onended: null,
      start(when: number): void {
        context.started.push(when)
      },
      stop(): void {},
    })
  }

  resume(): Promise<void> {
    return Promise.resolve()
  }

  close(): Promise<void> {
    this.closed = true
    return Promise.resolve()
  }
}

const globals = globalThis as Record<string, unknown>
globals.window = { setTimeout, clearTimeout, setInterval, clearInterval }
globals.AudioContext = StubContext

function chunk(frames: number): AudioSamples {
  return {
    sampleRate: 48000,
    channels: 2,
    sampleFormat: "float32",
    frameCount: frames,
    droppedFrames: 0,
    samples: new Float32Array(frames * 2),
  }
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

function lastState(statuses: AudioPlayerStatus[]): string {
  return statuses[statuses.length - 1].state
}

describe("AudioPlayer", () => {
  beforeEach(() => {
    StubContext.instances = []
  })

  test("plays chunks, then stops asking when the server has no audio stream", async () => {
    let calls = 0
    const player = new AudioPlayer({
      getAudio: async () => (++calls === 1 ? chunk(1200) : null),
      isConnected: () => true,
    })
    const statuses: AudioPlayerStatus[] = []
    player.onStatus((s) => statuses.push(s))

    player.start()
    assert.equal(lastState(statuses), "playing")
    await new Promise((resolve) => setTimeout(resolve, 100))

    const context = StubContext.instances[0]
    assert.equal(context.started.length, 1)
    assert.equal(lastState(statuses), "unavailable")
    assert.equal(context.closed, true)

    const callsWhenStopped = calls
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.equal(calls, callsWhenStopped, "no more polls")
  })

  test("a response still in flight when stopped is ignored", async () => {
    let respond: (samples: AudioSamples) => void = () => {}
    let calls = 0
    const player = new AudioPlayer({
      getAudio: () => {
        calls++
        return new Promise<AudioSamples>((resolve) => (respond = resolve))
      },
      isConnected: () => true,
    })

    player.start()
    const context = StubContext.instances[0]
    player.stop()
    respond(chunk(1200))
    await tick()
    await new Promise((resolve) => setTimeout(resolve, 60))

    assert.equal(context.started.length, 0)
    assert.equal(calls, 1)
    assert.equal(context.closed, true)
  })

  test("stops when the connection drops", async () => {
    let connected = true
    const player = new AudioPlayer({
      getAudio: async () => {
        connected = false
        throw new Error("Connection closed")
      },
      isConnected: () => connected,
    })
    const statuses: AudioPlayerStatus[] = []
    player.onStatus((s) => statuses.push(s))

    player.start()
    await tick()

    assert.equal(lastState(statuses), "stopped")
    assert.equal(StubContext.instances[0].closed, true)
  })
})
