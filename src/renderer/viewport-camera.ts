// The editor camera's controls, as pure maths: orbit, pan, zoom, fly (and look, the fly camera's mouse) and "frame
// selected". The pose is kept as an orbit around a target point (target, yaw, pitch, distance), so orbiting and
// zooming keep the point of interest, and flying and looking move the target with the camera. The host owns the
// camera: this computes the pose and the page sends it with SetEditorCamera (engine #6 decision: the client computes
// orbit, pan, zoom, fly and frame; the server renders from the pose). Rotation is yaw about world +Y, then pitch about
// the camera's right; the camera looks down its local -Z (protocol), so it sits at target - forward * distance.
import type { Quat, SetEditorCameraRequest, Vec3 } from "../protocol/protocol.generated"
import {
  IdentityQuat,
  add,
  length,
  quatFromAxisAngle,
  quatMultiply,
  quatNormalize,
  quatRotate,
  scale,
  sub,
  vec3,
} from "./viewport-math"

/** The host's camera before any SetEditorCamera (GetEditorCamera's documented defaults) */
export const DefaultCamera = {
  position: vec3(0, 0, 10),
  rotation: IdentityQuat,
  fovY: 60,
  nearPlane: 0.1,
  farPlane: 1000,
  orthoSize: 5,
}

export const MinDistance = 0.01
export const MaxDistance = 100000
/** A pitch of exactly +-90 degrees would make yaw and roll the same axis */
export const MaxPitch = (89 * Math.PI) / 180
/** Radians of rotation per pixel of mouse travel */
export const RadiansPerPixel = 0.005
/** A wheel notch of 100 pixels changes the distance by this factor: exp(100 * ZoomPerPixel) */
export const ZoomPerPixel = 0.0015
/** How far "frame selected" stands from a thing with no known size (an empty object, or no bounds from the host) */
export const PointFrameDistance = 5
/** "Frame selected" leaves this much room around the bounds */
export const FrameMargin = 1.3

export interface Bounds {
  min: Vec3
  max: Vec3
}

export interface CameraSnapshot {
  position: Vec3
  rotation: Quat
  fovY: number
  nearPlane: number
  farPlane: number
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))

export class EditorCameraController {
  target: Vec3 = vec3(0, 0, 0)
  yaw = 0
  pitch = 0
  distance = 10
  fovY = DefaultCamera.fovY
  nearPlane = DefaultCamera.nearPlane
  farPlane = DefaultCamera.farPlane
  /** Counts changes of the pose: whoever sends it can tell whether it is the one it sent */
  version = 0

  /** The camera's rotation */
  get rotation(): Quat {
    const yaw = quatFromAxisAngle(vec3(0, 1, 0), this.yaw)
    const pitch = quatFromAxisAngle(vec3(1, 0, 0), this.pitch)
    return quatNormalize(quatMultiply(yaw, pitch))
  }

  get forward(): Vec3 {
    return quatRotate(this.rotation, vec3(0, 0, -1))
  }

  get right(): Vec3 {
    return quatRotate(this.rotation, vec3(1, 0, 0))
  }

  get up(): Vec3 {
    return quatRotate(this.rotation, vec3(0, 1, 0))
  }

  get position(): Vec3 {
    return sub(this.target, scale(this.forward, this.distance))
  }

  /** The pose as SetEditorCamera sends it (perspective; the orthographic fields keep the host's defaults) */
  toRequest(): SetEditorCameraRequest {
    return {
      position: this.position,
      rotation: this.rotation,
      fovY: this.fovY,
      orthographic: false,
      orthoSize: DefaultCamera.orthoSize,
      nearPlane: this.nearPlane,
      farPlane: this.farPlane,
    }
  }

  /**
   * Takes the host's camera as the pose (when connecting: the host may have been moved by an earlier session): the
   * look direction gives yaw and pitch (roll is dropped), and the target is kept in front of it at the same distance.
   */
  adopt(camera: CameraSnapshot, distance: number = this.distance): void {
    const forward = quatRotate(quatNormalize(camera.rotation), vec3(0, 0, -1))
    this.yaw = Math.atan2(-forward.x, -forward.z)
    this.pitch = clamp(Math.asin(clamp(forward.y, -1, 1)), -MaxPitch, MaxPitch)
    this.distance = clamp(distance, MinDistance, MaxDistance)
    this.fovY = camera.fovY
    this.nearPlane = camera.nearPlane
    this.farPlane = camera.farPlane
    this.target = add(camera.position, scale(this.forward, this.distance))
    this.version++
  }

  /** Orbit around the target: dragging right turns the view to the right, dragging down looks down on it */
  orbit(dxPixels: number, dyPixels: number): void {
    this.yaw -= dxPixels * RadiansPerPixel
    this.pitch = clamp(this.pitch - dyPixels * RadiansPerPixel, -MaxPitch, MaxPitch)
    this.version++
  }

  /** Turn the camera where it stands (the fly camera's mouse look): the target swings with it */
  look(dxPixels: number, dyPixels: number): void {
    const position = this.position
    this.yaw -= dxPixels * RadiansPerPixel
    this.pitch = clamp(this.pitch - dyPixels * RadiansPerPixel, -MaxPitch, MaxPitch)
    this.target = add(position, scale(this.forward, this.distance))
    this.version++
  }

  /**
   * Drag the scene with the mouse: the camera slides opposite to it, by the world size of a pixel at the target's
   * depth (viewportHeight is the viewport's height in the same pixels as the drag)
   */
  pan(dxPixels: number, dyPixels: number, viewportHeight: number): void {
    if (!(viewportHeight > 0)) return
    const worldPerPixel = (2 * this.distance * Math.tan((this.fovY * Math.PI) / 360)) / viewportHeight
    const move = add(scale(this.right, -dxPixels * worldPerPixel), scale(this.up, dyPixels * worldPerPixel))
    this.target = add(this.target, move)
    this.version++
  }

  /** Dolly towards (negative) or away from (positive) the target; the wheel's deltaY in pixels */
  zoom(deltaPixels: number): void {
    this.distance = clamp(this.distance * Math.exp(deltaPixels * ZoomPerPixel), MinDistance, MaxDistance)
    this.version++
  }

  /**
   * Fly: move by move (x right, y up in the world, z forward, each -1 to 1) for dtSeconds at speed units a second.
   * The target moves with the camera, so the orbit distance is unchanged.
   */
  fly(move: Vec3, dtSeconds: number, speed: number): void {
    if (!(dtSeconds > 0) || !(speed > 0)) return
    if (move.x === 0 && move.y === 0 && move.z === 0) return
    const delta = add(
      add(scale(this.right, move.x), scale(vec3(0, 1, 0), move.y)),
      scale(this.forward, move.z)
    )
    const l = length(delta)
    // Diagonals are no faster than straight lines
    this.target = add(this.target, scale(delta, (speed * dtSeconds) / Math.max(1, l)))
    this.version++
  }

  /** The fly speed (units a second): a camera far out moves faster; boost is shift held */
  flySpeed(boost: boolean): number {
    return Math.max(2, this.distance) * (boost ? 4 : 1)
  }

  /** Look at a thing of known size: its centre is the target, and the camera backs off to fit its bounding sphere */
  frameBounds(bounds: Bounds): void {
    const center = scale(add(bounds.min, bounds.max), 0.5)
    const radius = length(sub(bounds.max, bounds.min)) / 2
    if (!Number.isFinite(radius) || !Number.isFinite(center.x + center.y + center.z)) return
    const halfFov = (this.fovY * Math.PI) / 360
    // The sphere fits the narrower of the two fields of view; the aspect ratio isn't known here, so fit the vertical
    // one: a wider-than-tall viewport is then the safe side
    const fitted = radius > 0 ? (radius * FrameMargin) / Math.sin(halfFov) : PointFrameDistance
    this.target = center
    this.distance = clamp(fitted, Math.max(MinDistance, this.nearPlane * 2), MaxDistance)
    this.version++
  }

  /** Look at a point: with no bounds known, the camera stands PointFrameDistance away */
  framePoint(point: Vec3): void {
    if (!Number.isFinite(point.x + point.y + point.z)) return
    this.target = point
    this.distance = PointFrameDistance
    this.version++
  }
}
