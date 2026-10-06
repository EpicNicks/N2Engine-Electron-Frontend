import { test, describe } from "node:test"
import * as assert from "node:assert/strict"
import {
  decodeAudioSamples,
  deinterleave,
  int16ToFloat32,
  JitterBuffer,
  resampleLinear,
  applyFadeIn,
  ScheduleDecision,
} from "../audio-stream"

// An AudioSamples payload as the server writes it (WriteAudioSamples), without the 5-byte response header
function audioPayload(
  format: string,
  channels: number,
  frameCount: number,
  droppedFrames: number,
  sampleBytes: Buffer,
  sampleRate: number = 48000
): Buffer {
  const formatBytes = Buffer.from(format, "utf-8")
  const header = Buffer.alloc(8 + 4 + formatBytes.length + 8)
  let offset = 0
  offset = header.writeUInt32LE(sampleRate, offset)
  offset = header.writeUInt32LE(channels, offset)
  offset = header.writeUInt32LE(formatBytes.length, offset)
  offset += formatBytes.copy(header, offset)
  offset = header.writeUInt32LE(frameCount, offset)
  header.writeUInt32LE(droppedFrames, offset)
  return Buffer.concat([header, sampleBytes])
}

function float32Bytes(values: number[]): Buffer {
  const bytes = Buffer.alloc(values.length * 4)
  values.forEach((v, i) => bytes.writeFloatLE(v, i * 4))
  return bytes
}

function int16Bytes(values: number[]): Buffer {
  const bytes = Buffer.alloc(values.length * 2)
  values.forEach((v, i) => bytes.writeInt16LE(v, i * 2))
  return bytes
}

describe("decodeAudioSamples", () => {
  test("decodes a float32 payload", () => {
    const values = [0, 0.5, -0.5, 1, -1, 0.25]
    const decoded = decodeAudioSamples(audioPayload("float32", 2, 3, 7, float32Bytes(values)))

    assert.equal(decoded.sampleRate, 48000)
    assert.equal(decoded.channels, 2)
    assert.equal(decoded.sampleFormat, "float32")
    assert.equal(decoded.frameCount, 3)
    assert.equal(decoded.droppedFrames, 7)
    assert.deepEqual(Array.from(decoded.samples), values)
  })

  test("decodes an int16 payload to float32 in [-1, 1)", () => {
    const decoded = decodeAudioSamples(audioPayload("int16", 2, 2, 0, int16Bytes([0, 16384, -32768, 32767])))

    assert.equal(decoded.sampleFormat, "int16")
    assert.equal(decoded.frameCount, 2)
    assert.deepEqual(Array.from(decoded.samples), [0, 0.5, -1, 32767 / 32768])
  })

  test("reads samples that aren't 4-byte aligned, inside a larger buffer", () => {
    // "float32" is 7 bytes, so the samples start at an odd offset; the frame also has a response header in front
    const payload = audioPayload("float32", 1, 2, 0, float32Bytes([0.125, -0.75]))
    const response = Buffer.concat([Buffer.from([0x0a, 0, 0, 0, 0]), payload])
    const decoded = decodeAudioSamples(response.subarray(5))

    assert.deepEqual(Array.from(decoded.samples), [0.125, -0.75])
  })

  test("decodes an empty response (nothing mixed since the last call)", () => {
    const decoded = decodeAudioSamples(audioPayload("float32", 2, 0, 0, Buffer.alloc(0)))

    assert.equal(decoded.frameCount, 0)
    assert.equal(decoded.samples.length, 0)
  })

  test("rejects a sample count that doesn't match frameCount * channels", () => {
    assert.throws(() => decodeAudioSamples(audioPayload("float32", 2, 3, 0, float32Bytes([0, 0, 0, 0]))), /expected 24/)
  })

  test("rejects an unknown sample format", () => {
    assert.throws(() => decodeAudioSamples(audioPayload("float64", 2, 0, 0, Buffer.alloc(0))), /Unsupported/)
  })

  test("rejects a truncated header", () => {
    const payload = audioPayload("int16", 2, 0, 0, Buffer.alloc(0))
    assert.throws(() => decodeAudioSamples(payload.subarray(0, payload.length - 2)), /too short/)
  })
})

describe("sample helpers", () => {
  test("int16ToFloat32 is little-endian", () => {
    assert.deepEqual(Array.from(int16ToFloat32(new Uint8Array([0x00, 0x40, 0x00, 0xc0]))), [0.5, -0.5])
  })

  test("deinterleave splits channels", () => {
    const [left, right] = deinterleave(new Float32Array([1, -1, 2, -2, 3, -3]), 2)
    assert.deepEqual(Array.from(left), [1, 2, 3])
    assert.deepEqual(Array.from(right), [-1, -2, -3])
  })

  test("resampleLinear keeps the same length unchanged", () => {
    const input = new Float32Array([0, 1, 2, 3, 4, 5])
    assert.deepEqual(Array.from(resampleLinear(input, 2, 3)), [0, 1, 2, 3, 4, 5])
  })

  test("resampleLinear stretches and squeezes, keeping the end frames", () => {
    const ramp = new Float32Array([0, 1, 2, 3, 4]) // mono
    assert.deepEqual(Array.from(resampleLinear(ramp, 1, 9)), [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4])
    assert.deepEqual(Array.from(resampleLinear(ramp, 1, 3)), [0, 2, 4])
  })
})

describe("applyFadeIn", () => {
  test("ramps the leading frames up from silence and leaves the rest", () => {
    const samples = new Float32Array([1, 1, 1, 1, 1, 1, 1, 1]) // 4 stereo frames
    applyFadeIn(samples, 2, 3)
    assert.deepEqual(Array.from(samples), [0.25, 0.25, 0.5, 0.5, 0.75, 0.75, 1, 1])
  })
})

describe("JitterBuffer", () => {
  const rate = 48000

  // The end of a chunk on the playback clock
  function endOf(d: ScheduleDecision): number {
    return d.startTime + d.outputFrames / rate
  }

  test("starts a chunk so that it ends targetSeconds from now", () => {
    const jitter = new JitterBuffer({ targetSeconds: 0.08 })
    const d = jitter.schedule(10, 1200, rate)!

    assert.equal(d.reason, "start")
    assert.equal(d.skipFrames, 0)
    assert.equal(d.outputFrames, 1200)
    assert.ok(Math.abs(endOf(d) - 10.08) < 1e-9)
  })

  test("keeps only the newest frames of a large first chunk", () => {
    // The first GetAudio of a connection can return 250 ms mixed before the client connected
    const jitter = new JitterBuffer({ targetSeconds: 0.08, minLeadSeconds: 0.01 })
    const d = jitter.schedule(0, 12000, rate)!

    assert.equal(d.outputFrames, Math.round(0.07 * rate))
    assert.equal(d.skipFrames, 12000 - d.outputFrames)
    assert.ok(Math.abs(d.startTime - 0.01) < 1e-9)
    assert.equal(jitter.stats.skippedFrames, d.skipFrames)
  })

  test("schedules steady chunks back to back", () => {
    const jitter = new JitterBuffer()
    let previous = jitter.schedule(0, 1200, rate)!
    for (let i = 1; i <= 20; i++) {
      const d = jitter.schedule(i * 0.025, 1200, rate)!
      assert.equal(d.reason, "steady")
      assert.ok(Math.abs(d.startTime - endOf(previous)) < 1e-9)
      assert.equal(d.outputFrames, 1200)
      previous = d
    }
  })

  test("returns null for an empty chunk", () => {
    const jitter = new JitterBuffer()
    assert.equal(jitter.schedule(0, 0, rate), null)
  })

  test("resyncs after the server dropped frames (a gap)", () => {
    const jitter = new JitterBuffer({ targetSeconds: 0.08 })
    jitter.schedule(0, 1200, rate)
    const d = jitter.schedule(0.025, 1200, rate, 4800)!

    assert.equal(d.reason, "gap")
    assert.ok(Math.abs(endOf(d) - 0.105) < 1e-9)
    assert.equal(jitter.stats.gaps, 1)
    assert.equal(jitter.stats.serverDroppedFrames, 4800)
  })

  test("doesn't count frames dropped before the first chunk as a gap", () => {
    // The first GetAudio of a connection reports what the server dropped while nobody was listening
    const jitter = new JitterBuffer()
    const first = jitter.schedule(0, 1200, rate, 96000)!
    assert.equal(first.reason, "start")

    jitter.reset()
    assert.equal(jitter.schedule(1, 1200, rate, 4800)!.reason, "start")
    assert.equal(jitter.stats.gaps, 0)
    assert.equal(jitter.stats.serverDroppedFrames, 0)
  })

  test("a gap resync doesn't overlap audio that is still scheduled", () => {
    const jitter = new JitterBuffer({ targetSeconds: 0.1, minLeadSeconds: 0.01, fadeInSeconds: 0.003 })
    const first = jitter.schedule(0, 4800, rate)! // 100 ms, ends at 0.1
    const d = jitter.schedule(0.01, 4800, rate, 2400)! // a gap, with 100 ms of new audio

    assert.equal(d.reason, "gap")
    assert.ok(d.startTime >= endOf(first) - 1e-9, `starts at ${d.startTime}, before ${endOf(first)}`)
    assert.ok(Math.abs(endOf(d) - 0.11) < 1 / rate) // still ends targetSeconds ahead
    assert.equal(d.skipFrames + d.outputFrames, 4800)
    assert.equal(d.fadeInFrames, 144)
  })

  test("fades in only after a discontinuity", () => {
    const jitter = new JitterBuffer({ fadeInSeconds: 0.003 })
    assert.equal(jitter.schedule(0, 1200, rate)!.fadeInFrames, 144) // start
    assert.equal(jitter.schedule(0.025, 1200, rate)!.fadeInFrames, 0) // steady
    assert.equal(jitter.schedule(1, 1200, rate)!.fadeInFrames, 144) // underrun
  })

  test("resyncs after an underrun", () => {
    const jitter = new JitterBuffer({ targetSeconds: 0.08 })
    jitter.schedule(0, 1200, rate) // ends at 0.08
    const d = jitter.schedule(0.5, 1200, rate)! // the poll stalled; playback ran dry

    assert.equal(d.reason, "underrun")
    assert.ok(Math.abs(endOf(d) - 0.58) < 1e-9)
    assert.equal(jitter.stats.underruns, 1)
  })

  test("drops the excess at once when far too much is buffered", () => {
    const jitter = new JitterBuffer({ targetSeconds: 0.08, maxSeconds: 0.25 })
    const first = jitter.schedule(0, 1200, rate)! // ends at 0.08
    const d = jitter.schedule(0.01, 12000, rate)! // a 250 ms burst

    assert.equal(d.reason, "overflow")
    assert.ok(Math.abs(d.startTime - endOf(first)) < 1e-9)
    assert.ok(Math.abs(endOf(d) - 0.09) < 1 / rate) // target ahead of now again
  })

  test("doesn't correct jitter inside the tolerance band", () => {
    const jitter = new JitterBuffer({ targetSeconds: 0.08, toleranceSeconds: 0.03 })
    jitter.schedule(0, 1200, rate)
    // The response arrived 20 ms early relative to the frames in it: 20 ms more than the target is buffered
    const d = jitter.schedule(0.005, 1200, rate)!
    assert.equal(d.reason, "steady")
    assert.equal(d.outputFrames, 1200)
  })

  interface DriftResult {
    jitter: JitterBuffer
    reasons: Record<string, number>
    /** Times drift correction switched between dropping and repeating frames */
    flips: number
    minAhead: number
    maxAhead: number
  }

  // The server mixes by its own clock (in main-loop iterations, so what a poll gets lags real time by 0 to 16 ms),
  // while playback runs on the sound card's at playbackSpeed, read through a currentTime that moves in 10 ms steps
  function simulateDrift(playbackSpeed: number, seconds: number, seed: number = 1): DriftResult {
    const jitter = new JitterBuffer()
    const random = (): number => {
      seed = (seed * 16807) % 2147483647
      return seed / 2147483647
    }

    let t = 0
    let taken = 0
    let flips = 0
    let lastSign = 0
    let minAhead = Infinity
    let maxAhead = 0
    const reasons: Record<string, number> = {}

    while (t < seconds) {
      t += 0.025 + random() * 0.02 // 25 ms after the previous response, plus 0 to 20 ms for the request
      const now = Math.floor((t * playbackSpeed) / 0.01) * 0.01
      const mixed = Math.max(taken, Math.floor((t - random() * 0.016) * rate))
      const frames = mixed - taken
      taken = mixed

      const d = jitter.schedule(now, frames, rate)
      if (!d) continue
      reasons[d.reason] = (reasons[d.reason] ?? 0) + 1
      if (d.reason === "drift") {
        const sign = Math.sign(frames - d.skipFrames - d.outputFrames)
        if (lastSign !== 0 && sign !== lastSign) flips++
        lastSign = sign
      }
      if (t > 5) {
        const ahead = endOf(d) - now
        minAhead = Math.min(minAhead, ahead)
        maxAhead = Math.max(maxAhead, ahead)
      }
    }
    return { jitter, reasons, flips, minAhead, maxAhead }
  }

  for (const [name, speed] of [
    ["fast", 1.0005],
    ["slow", 0.9995],
    ["matching", 1],
  ] as const) {
    test(`holds a ${name} playback clock steady with a noisy clock and mix timing`, () => {
      for (const seed of [1, 2, 3]) {
        const { jitter, reasons, flips, minAhead, maxAhead } = simulateDrift(speed, 300, seed * 7919)
        const o = jitter.options
        const label = `seed ${seed}: ${JSON.stringify(reasons)}`

        assert.equal(jitter.stats.underruns, 0, label)
        assert.equal(reasons.overflow ?? 0, 0, label)
        assert.equal(jitter.stats.skippedFrames, 0, label)
        assert.ok(flips <= 2, `${flips} correction direction flips, ${label}`)
        assert.ok(minAhead > o.minLeadSeconds + 0.03, `buffer fell to ${minAhead}`)
        assert.ok(maxAhead < o.targetSeconds + 0.05, `buffer rose to ${maxAhead}`)
        if (speed > 1) assert.ok(jitter.stats.correctedFrames < 0, "frames are repeated")
        if (speed < 1) assert.ok(jitter.stats.correctedFrames > 0, "frames are dropped")
        if (speed === 1) assert.equal(reasons.drift ?? 0, 0, label)
      }
    })
  }

  test("reset starts afresh", () => {
    const jitter = new JitterBuffer()
    jitter.schedule(0, 1200, rate)
    jitter.reset()
    assert.equal(jitter.bufferedSeconds(0), 0)
    assert.equal(jitter.schedule(1, 1200, rate)!.reason, "start")
  })
})
