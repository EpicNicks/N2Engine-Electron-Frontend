import { test } from "node:test"
import * as assert from "node:assert/strict"
import { AssetPreviewCache, PreviewAsset, checkPreviewMatches, previewKindOf } from "../renderer/asset-previews"
import type { AssetPreview } from "../protocol/editor-tooling"

const tex = (n: number): PreviewAsset => ({
  uuid: `0000000${n}-0000-0000-0000-000000000000`,
  path: `res://t${n}.png`,
  type: "Texture",
  size: 10,
  modified: 1,
})
const wave: PreviewAsset = { uuid: "aaaaaaaa-0000-0000-0000-000000000000", path: "res://s.wav", type: "AudioClip", size: 10, modified: 1 }
const texturePreview = (a: PreviewAsset, w = 2, h = 2): AssetPreview => ({
  kind: "texture",
  uuid: a.uuid,
  path: a.path,
  modified: a.modified,
  width: w,
  height: h,
  sourceWidth: 8,
  sourceHeight: 8,
  pixels: new Uint8Array(w * h * 4),
})
const audioPreview = (a: PreviewAsset): AssetPreview => ({
  kind: "audio",
  uuid: a.uuid,
  path: a.path,
  modified: a.modified,
  durationMs: 10,
  channels: 1,
  sampleRate: 8000,
  peaks: [{ min: -1, max: 1 }],
})
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

/** An engine whose answers the test releases by hand */
function gated() {
  const asked: string[] = []
  const waiting: Array<{ id: string; size: number; finish(p: AssetPreview | Error): void }> = []
  let active = 0
  let peak = 0
  const engine = {
    getAssetPreview: (id: string, size: number) => {
      asked.push(`${id}@${size}`)
      active++
      peak = Math.max(peak, active)
      return new Promise<AssetPreview>((resolve, reject) =>
        waiting.push({
          id,
          size,
          finish: (p) => {
            active--
            if (p instanceof Error) reject(p)
            else resolve(p)
          },
        })
      )
    },
  }
  return { engine, asked, waiting, peak: () => peak }
}

function answering(make: (a: PreviewAsset) => AssetPreview, all: PreviewAsset[]) {
  const asked: string[] = []
  return {
    asked,
    engine: {
      getAssetPreview: async (id: string, size: number) => {
        asked.push(`${id}@${size}`)
        return make(all.find((a) => a.uuid === id)!)
      },
    },
  }
}

test("only textures and audio clips have previews", () => {
  assert.equal(previewKindOf("Texture"), "texture")
  assert.equal(previewKindOf("AudioClip"), "audio")
  for (const type of ["Model", "Material", "LuaScript", "Scene", "Font", ""]) assert.equal(previewKindOf(type), null)
})

test("a preview is asked once, then served from the cache; other types are never asked", async () => {
  const a = tex(1)
  const { engine, asked } = answering((x) => texturePreview(x), [a])
  const cache = new AssetPreviewCache(engine)
  assert.ok(await cache.request(a, 64))
  assert.ok(await cache.request(a, 64))
  assert.equal(cache.peek(a, 64)?.kind, "texture")
  assert.equal(asked.length, 1)
  assert.equal(await cache.request({ ...a, type: "Model" }, 64), null)
  assert.equal(asked.length, 1)
  await cache.request(a, 256)
  assert.equal(asked.length, 2, "another size is another request")
})

test("simultaneous requests share one question to the host", async () => {
  const a = tex(1)
  const g = gated()
  const cache = new AssetPreviewCache(g.engine)
  const first = cache.request(a, 64)
  const second = cache.request(a, 64)
  await tick()
  assert.equal(g.asked.length, 1)
  g.waiting[0].finish(texturePreview(a))
  assert.equal((await first)?.kind, "texture")
  assert.equal((await second)?.kind, "texture")
})

test("at most the allowed number of requests are in flight, the rest wait their turn", async () => {
  const items = [tex(1), tex(2), tex(3), tex(4)]
  const g = gated()
  const cache = new AssetPreviewCache(g.engine, { concurrency: 2 })
  const results = items.map((a) => cache.request(a, 64))
  await tick()
  assert.equal(g.waiting.length, 2)
  g.waiting[0].finish(texturePreview(items[0]))
  await tick()
  assert.equal(g.waiting.length, 3)
  g.waiting[1].finish(texturePreview(items[1]))
  await tick()
  assert.equal(g.waiting.length, 4)
  g.waiting[2].finish(texturePreview(items[2]))
  g.waiting[3].finish(texturePreview(items[3]))
  await Promise.all(results)
  assert.equal(g.peak(), 2)
})

test("least recently used entries go first when there are too many, or too many bytes", async () => {
  const items = [tex(1), tex(2), tex(3)]
  const { engine, asked } = answering((x) => texturePreview(x, 2, 2), items)
  const cache = new AssetPreviewCache(engine, { maxEntries: 2 })
  await cache.request(items[0], 64)
  await cache.request(items[1], 64)
  cache.peek(items[0], 64) // item 0 is the more recent now
  await cache.request(items[2], 64)
  assert.equal(cache.size, 2)
  assert.ok(cache.peek(items[0], 64))
  assert.ok(cache.peek(items[2], 64))
  assert.equal(cache.peek(items[1], 64), null)
  const bytes = new AssetPreviewCache(engine, { maxBytes: 40 }) // each is 16 bytes
  for (const a of items) await bytes.request(a, 64)
  assert.equal(bytes.size, 2)
  assert.equal(bytes.byteSize, 32)
  assert.equal(asked.length, 6)
})

test("a changed file (modified time or size in the listing) is asked for again", async () => {
  const a = tex(1)
  const { engine, asked } = answering((x) => texturePreview(x), [a])
  const cache = new AssetPreviewCache(engine)
  await cache.request(a, 64)
  assert.equal(cache.peek({ ...a, modified: 2 }, 64), null)
  await cache.request({ ...a, modified: 2 }, 64)
  await cache.request({ ...a, modified: 2, size: 11 }, 64)
  assert.equal(asked.length, 3)
})

test("invalidate drops the named paths, and an answer still on its way for them is not stored", async () => {
  const a = tex(1)
  const b = tex(2)
  const g = gated()
  const cache = new AssetPreviewCache(g.engine)
  const first = cache.request(a, 64)
  const second = cache.request(b, 64)
  await tick()
  g.waiting[0].finish(texturePreview(a))
  g.waiting[1].finish(texturePreview(b))
  await first
  await second
  assert.ok(cache.peek(a, 64))
  const before = cache.version.value
  cache.invalidate([a.path.toUpperCase()])
  assert.equal(cache.peek(a, 64), null)
  assert.ok(cache.peek(b, 64))
  assert.ok(cache.version.value > before)
  const late = cache.request(a, 64)
  await tick()
  cache.invalidate([a.path])
  g.waiting[2].finish(texturePreview(a))
  assert.equal(await late, null, "the old answer is not given out")
  assert.equal(cache.peek(a, 64), null)
  const again = cache.request(a, 64)
  await tick()
  g.waiting[3].finish(texturePreview(a))
  assert.ok(await again)
})

test("clear drops everything, including answers still on their way", async () => {
  const a = tex(1)
  const g = gated()
  const cache = new AssetPreviewCache(g.engine)
  const pending = cache.request(a, 64)
  await tick()
  cache.clear()
  g.waiting[0].finish(texturePreview(a))
  assert.equal(await pending, null)
  assert.equal(cache.size, 0)
})

test("answers for another asset, another kind or too much are refused, and the refusal is remembered", async () => {
  const a = tex(1)
  const cases: Array<[string, AssetPreview, number, RegExp]> = [
    ["another uuid", texturePreview(tex(2)), 64, /another asset/],
    ["another path", { ...texturePreview(a), path: "res://elsewhere.png" }, 64, /another path/],
    ["another kind", audioPreview(a), 64, /came back as a audio preview/],
    ["too large", texturePreview(a, 3, 3), 2, /larger than asked/],
  ]
  for (const [name, answer, size, message] of cases) {
    let asked = 0
    const cache = new AssetPreviewCache({
      getAssetPreview: async () => {
        asked++
        return answer
      },
    })
    assert.equal(await cache.request(a, size), null, name)
    assert.match(cache.failure(a, size) ?? "", message, name)
    await cache.request(a, size)
    assert.equal(asked, 1, `${name} is not asked again`)
  }
  assert.doesNotThrow(() => checkPreviewMatches(a, texturePreview({ ...a, uuid: a.uuid.toUpperCase() })))
})

test("a host failure leaves no preview and is remembered until the file changes; too many peaks are refused", async () => {
  const a = tex(1)
  let calls = 0
  const cache = new AssetPreviewCache({
    getAssetPreview: async () => {
      calls++
      throw new Error("corrupt")
    },
  })
  assert.equal(await cache.request(a, 64), null)
  assert.equal(cache.failure(a, 64), "corrupt")
  await cache.request(a, 64)
  assert.equal(calls, 1)
  await cache.request({ ...a, modified: 5 }, 64)
  assert.equal(calls, 2)
  const many = { ...(audioPreview(wave) as object), peaks: [1, 2, 3].map(() => ({ min: 0, max: 0 })) } as AssetPreview
  const peaks = new AssetPreviewCache({ getAssetPreview: async () => many })
  assert.equal(await peaks.request(wave, 1), null)
  assert.match(peaks.failure(wave, 1) ?? "", /too many peaks/)
})

test("nothing is asked when previews are disabled or the engine lacks the command", async () => {
  const a = tex(1)
  let on = false
  let asked = 0
  const cache = new AssetPreviewCache(
    {
      getAssetPreview: async () => {
        asked++
        return texturePreview(a)
      },
    },
    { enabled: () => on }
  )
  assert.equal(await cache.request(a, 64), null)
  assert.equal(asked, 0)
  on = true
  assert.ok(await cache.request(a, 64))
  assert.equal(asked, 1)
  assert.equal(await new AssetPreviewCache({}).request(a, 64), null)
  await assert.rejects(cache.request(a, 0), /1 to 256/)
})
