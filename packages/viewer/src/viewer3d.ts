// Ambient types for occt-import-js; consumers compile this file from source.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./occt.d.ts" />
import {
  NeutralToneMapping,
  Box3,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  EdgesGeometry,
  Group,
  LineBasicMaterial,
  LineSegments,
  MeshBasicMaterial,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  OrthographicCamera,
  PerspectiveCamera,
  PMREMGenerator,
  Raycaster,
  Scene,
  Vector2,
  SRGBColorSpace,
  Quaternion,
  Vector3,
  WebGLRenderer,
  type Material,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

export interface PartFinishLike {
  color: number;
  roughness: number;
  metalness: number;
}

export type View3D = 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right' | 'iso';

/** A point on the board in KiCad's coordinates (mm, y down), the side it is on and how far above that face it sits. */
export interface BoardPoint {
  x: number;
  y: number;
  top: boolean;
  /** mm above the copper face of that side; a click on a part body is well above it. */
  lift: number;
}

/** Maps the model's own coordinates to board millimetres and back. */
export interface BoardFrame {
  toBoard(local: Vector3): BoardPoint;
  toLocal(x: number, y: number, top: boolean, lift: number): Vector3;
  /** Model units per millimetre. */
  unit: number;
}

/** kicad-cli's GLB export: metres, board X along x, board Y along +z, the board's bottom face at y = 0 and up is +y. */
export function kicadGlbFrame(thickness: number): BoardFrame {
  return {
    unit: 0.001,
    toBoard: (p) => {
      const h = p.y * 1000;
      const top = h >= thickness / 2;
      return { x: p.x * 1000, y: p.z * 1000, top, lift: top ? h - thickness : -h };
    },
    toLocal: (x, y, top, lift) => new Vector3(x / 1000, (top ? thickness + lift : -lift) / 1000, y / 1000),
  };
}

/** buildBoard3D: millimetres, board Y flipped to +y up the screen, the board centred on z = 0 with the top face at +z. */
export function liveBoardFrame(thickness: number): BoardFrame {
  return {
    unit: 1,
    toBoard: (p) => {
      const top = p.z >= 0;
      return { x: p.x, y: -p.y, top, lift: Math.abs(p.z) - thickness / 2 };
    },
    toLocal: (x, y, top, lift) => new Vector3(x, -y, top ? thickness / 2 + lift : -(thickness / 2 + lift)),
  };
}

/** What to light up on the board, in board millimetres. */
export interface Highlight3D {
  /** Parts: a box over the footprint, from the face up to `height` mm. */
  boxes: { minX: number; minY: number; maxX: number; maxY: number; top: boolean; height: number }[];
  /** Tracks: flat ribbons on the copper face. Inner layers pass `top: null` and are drawn on both faces. */
  segments: { a: { x: number; y: number }; b: { x: number; y: number }; width: number; top: boolean | null }[];
  /** Vias and pads: discs, drawn on both faces when `top` is null. */
  discs: { x: number; y: number; r: number; top: boolean | null }[];
  color: number;
}

export interface Viewer3DOptions {
  /** URL of occt-import-js.wasm, required for STEP loading. */
  occtWasmUrl?: string;
}

/**
 * 3D board viewer. GLB comes from `kicad-cli pcb export glb`; STEP files are
 * tessellated in the browser with OpenCascade (the kernel KiCad itself uses).
 */
export class Viewer3D {
  private renderer: WebGLRenderer;
  private scene = new Scene();
  private camera: PerspectiveCamera | OrthographicCamera;
  private controls: OrbitControls;
  private model: Object3D | null = null;
  private frame = 0;
  private resizeObserver: ResizeObserver;
  private up = new Vector3(0, 1, 0);
  private normal = new Vector3(0, 1, 0);
  private ortho = false;
  /** The loaded object itself, inside the centring wrapper: its local space is the file's own coordinates. */
  private content: Object3D | null = null;
  private frameMap: BoardFrame | null = null;
  private highlight: Group | null = null;
  private raycaster = new Raycaster();
  private down: { x: number; y: number } | null = null;
  private readonly onDown = (e: PointerEvent) => {
    this.down = e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
  };
  private readonly onUp = (e: PointerEvent) => {
    const d = this.down;
    this.down = null;
    // A click, not the end of a drag.
    if (!d || e.button !== 0 || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4 || !this.onPick) return;
    this.onPick(this.pickAt(e.clientX, e.clientY));
  };

  constructor(
    private readonly el: HTMLElement,
    private readonly opts: Viewer3DOptions = {},
  ) {
    this.renderer = new WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(el.clientWidth, el.clientHeight);
    el.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = 'block';

    this.camera = this.makeCamera(false);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.screenSpacePanning = true;
    this.controls.rotateSpeed = 0.55;
    this.controls.zoomToCursor = true;
    this.controls.autoRotateSpeed = 1.5;
    // Any interaction stops the turntable.
    this.controls.addEventListener('start', () => {
      if (this.controls.autoRotate) {
        this.controls.autoRotate = false;
        this.onAutoRotateChange?.(false);
      }
    });

    // Studio lighting: an image-based environment gives metal (pins, pads, shields) real reflections and plastic a
    // believable sheen; neutral tone mapping keeps true part colours without clipping highlights. One key light adds direction and depth.
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = NeutralToneMapping;
    this.renderer.toneMappingExposure = 0.95;
    const pmrem = new PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    this.scene.environment = pmrem.fromScene(room, 0.03).texture;
    this.scene.environmentIntensity = 0.7;
    room.dispose();
    pmrem.dispose();
    const key = new DirectionalLight(0xfff6ec, 1.4);
    key.position.set(1, 2.2, 1.4);
    const rim = new DirectionalLight(0xdfe8ff, 0.45);
    rim.position.set(-1.5, -0.6, -1.2);
    this.scene.add(key, rim);

    this.renderer.domElement.addEventListener('pointerdown', this.onDown);
    this.renderer.domElement.addEventListener('pointerup', this.onUp);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(el);
    const loop = () => {
      this.frame = requestAnimationFrame(loop);
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }

  private makeCamera(ortho: boolean): PerspectiveCamera | OrthographicCamera {
    const aspect = Math.max(this.el.clientWidth, 1) / Math.max(this.el.clientHeight, 1);
    return ortho ? new OrthographicCamera(-aspect, aspect, 1, -1, -1e5, 1e5) : new PerspectiveCamera(35, aspect, 0.001, 1e5);
  }

  private resize(): void {
    const w = this.el.clientWidth;
    const h = this.el.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    if (this.camera instanceof PerspectiveCamera) {
      this.camera.aspect = w / h;
    } else {
      const half = (this.camera.top - this.camera.bottom) / 2;
      this.camera.left = (-half * w) / h;
      this.camera.right = (half * w) / h;
    }
    this.camera.updateProjectionMatrix();
  }

  private setModel(obj: Object3D): void {
    if (this.model) {
      this.scene.remove(this.model);
      disposeTree(this.model);
    }
    this.highlight = null;
    this.content = obj;
    // Centre the model at the origin.
    const box = new Box3().setFromObject(obj);
    const center = box.getCenter(new Vector3());
    const wrapper = new Group();
    obj.position.sub(center);
    wrapper.add(obj);
    this.model = wrapper;
    this.scene.add(wrapper);
    // The board plane is perpendicular to the smallest extent.
    const size = box.getSize(new Vector3());
    const axis = size.x <= size.y && size.x <= size.z ? 'x' : size.y <= size.z ? 'y' : 'z';
    this.normal = new Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0);
    this.up = axis === 'y' ? new Vector3(0, 0, -1) : new Vector3(0, 1, 0);
    if (axis === 'z') this.up = new Vector3(0, 1, 0);
    this.setView('iso');
  }

  /** Called on a click (not a drag) on the canvas: the board point under it, or null for empty space. */
  onPick: ((hit: BoardPoint | null) => void) | null = null;

  /** How the current model's coordinates map to the board; picking and highlights need it. */
  setFrame(frame: BoardFrame | null): void {
    this.frameMap = frame;
  }

  private pickAt(clientX: number, clientY: number): BoardPoint | null {
    if (!this.content || !this.frameMap) return null;
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const targets: Object3D[] = [];
    this.content.traverseVisible((o) => {
      if (o instanceof Mesh && !o.userData.highlight) targets.push(o);
    });
    const hit = this.raycaster.intersectObjects(targets, false)[0];
    if (!hit) return null;
    return this.frameMap.toBoard(this.content.worldToLocal(hit.point.clone()));
  }

  /** Light up parts, tracks and pads; null clears. */
  setHighlight(h: Highlight3D | null): void {
    if (this.highlight) {
      this.highlight.parent?.remove(this.highlight);
      disposeTree(this.highlight);
      this.highlight = null;
    }
    const frame = this.frameMap;
    if (!h || !this.content || !frame) return;
    const g = new Group();
    g.userData.highlight = true;
    const color = new Color(h.color);
    // Drawn over everything, so a lit net reads through parts that sit on it.
    const fill = new MeshBasicMaterial({ color, transparent: true, opacity: 0.85, depthTest: false, depthWrite: false });
    const soft = new MeshBasicMaterial({ color, transparent: true, opacity: 0.22, depthWrite: false });
    const lift = 0.04;

    const verts: number[] = [];
    const quad = (a: Vector3, b: Vector3, c: Vector3, d: Vector3) => verts.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, a.x, a.y, a.z, c.x, c.y, c.z, d.x, d.y, d.z);
    const disc = (x: number, y: number, r: number, top: boolean) => {
      const n = 16;
      const c = frame.toLocal(x, y, top, lift);
      for (let i = 0; i < n; i++) {
        const a0 = (i / n) * Math.PI * 2;
        const a1 = ((i + 1) / n) * Math.PI * 2;
        const p0 = frame.toLocal(x + Math.cos(a0) * r, y + Math.sin(a0) * r, top, lift);
        const p1 = frame.toLocal(x + Math.cos(a1) * r, y + Math.sin(a1) * r, top, lift);
        verts.push(c.x, c.y, c.z, p0.x, p0.y, p0.z, p1.x, p1.y, p1.z);
      }
    };
    const sides = (top: boolean | null) => (top === null ? [true, false] : [top]);
    for (const s of h.segments) {
      const dx = s.b.x - s.a.x;
      const dy = s.b.y - s.a.y;
      const len = Math.hypot(dx, dy) || 1;
      const w = Math.max(s.width, 0.15) / 2;
      const nx = (-dy / len) * w;
      const ny = (dx / len) * w;
      for (const top of sides(s.top)) {
        quad(
          frame.toLocal(s.a.x + nx, s.a.y + ny, top, lift),
          frame.toLocal(s.b.x + nx, s.b.y + ny, top, lift),
          frame.toLocal(s.b.x - nx, s.b.y - ny, top, lift),
          frame.toLocal(s.a.x - nx, s.a.y - ny, top, lift),
        );
        disc(s.a.x, s.a.y, w, top);
        disc(s.b.x, s.b.y, w, top);
      }
    }
    for (const d of h.discs) for (const top of sides(d.top)) disc(d.x, d.y, d.r, top);
    if (verts.length) {
      const geo = new BufferGeometry();
      geo.setAttribute('position', new BufferAttribute(new Float32Array(verts), 3));
      const m = new Mesh(geo, fill);
      m.renderOrder = 10;
      m.userData.highlight = true;
      g.add(m);
    }

    const edge = new LineBasicMaterial({ color, depthTest: false, transparent: true });
    for (const b of h.boxes) {
      const pad = 0.25;
      const p0 = frame.toLocal(b.minX - pad, b.minY - pad, b.top, 0);
      const p1 = frame.toLocal(b.maxX + pad, b.maxY + pad, b.top, b.height);
      const size = p1.clone().sub(p0);
      const box = new BoxGeometry(Math.abs(size.x), Math.abs(size.y), Math.abs(size.z));
      const center = p0.clone().add(p1).multiplyScalar(0.5);
      const shell = new Mesh(box, soft);
      shell.position.copy(center);
      shell.userData.highlight = true;
      const lines = new LineSegments(new EdgesGeometry(box), edge);
      lines.position.copy(center);
      lines.renderOrder = 11;
      lines.userData.highlight = true;
      g.add(shell, lines);
    }
    this.content.add(g);
    this.highlight = g;
  }

  /** Turn the view so a board area is in the middle, keeping the distance. */
  centreOn(x: number, y: number, top: boolean): void {
    if (!this.content || !this.frameMap) return;
    const world = this.content.localToWorld(this.frameMap.toLocal(x, y, top, 0));
    const shift = world.sub(this.controls.target);
    this.controls.target.add(shift);
    this.camera.position.add(shift);
    this.controls.update();
  }

  /** Called when interaction stops the turntable. */
  onAutoRotateChange: ((on: boolean) => void) | null = null;

  /** Show an already-built object (e.g. the procedural board). */
  loadObject(obj: Object3D, keepView = false): void {
    const dir = keepView && this.model ? this.camera.position.clone().sub(this.controls.target).normalize() : null;
    const up = this.camera.up.clone();
    this.setModel(obj);
    if (dir) {
      this.camera.up.copy(up);
      this.fitCamera(dir);
    }
  }

  setAutoRotate(on: boolean): void {
    this.controls.autoRotate = on;
  }

  /** Turn the board over: look at the other side from the mirrored angle. */
  flip(): void {
    const target = this.controls.target.clone();
    const offset = this.camera.position.clone().sub(target);
    const n = this.normal;
    offset.sub(n.clone().multiplyScalar(2 * offset.dot(n)));
    // Straight down onto the board: lean a hair so the board keeps its orientation on screen (see setView).
    if (Math.abs(offset.clone().normalize().dot(n)) > 0.9999) offset.add(this.up.clone().multiplyScalar(offset.length() * (offset.dot(n) > 0 ? -1e-4 : 1e-4)));
    this.camera.position.copy(target.clone().add(offset));
    this.camera.lookAt(target);
    this.controls.update();
  }

  /**
   * Orbit around the board's normal. OrbitControls reads the camera's up direction only once, when it is created, so
   * it has to be told when that changes; otherwise dragging up or down tilts the board around the wrong axis.
   */
  private orbitAround(n: Vector3): void {
    this.camera.up.copy(n);
    const c = this.controls as unknown as { _quat: Quaternion; _quatInverse: Quaternion };
    c._quat.setFromUnitVectors(n.clone().normalize(), new Vector3(0, 1, 0));
    c._quatInverse.copy(c._quat).invert();
  }

  /** Toggle a named child of the model (e.g. "components"). */
  setVisible(name: string, visible: boolean): void {
    this.model?.traverse((o) => {
      if (o.name === name) o.visible = visible;
    });
  }

  /** PNG data URL of the current view. */
  screenshot(): string {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }

  /**
   * @param fromKicad the file came from kicad-cli (directly or re-compressed); detected from the generator tag when
   * omitted, but tools like gltf-transform rewrite that tag, so callers that know should say.
   */
  async loadGlb(source: string | ArrayBuffer, fromKicad?: boolean, finishFor?: (reference: string) => PartFinishLike | null): Promise<void> {
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    const gltf = typeof source === 'string' ? await loader.loadAsync(source) : await loader.parseAsync(source, '');
    // kicad-cli writes through OpenCascade, which stores KiCad's sRGB colours in glTF's linear colour slot.
    const kicad = fromKicad ?? /open cascade/i.test(String((gltf.parser.json as { asset?: { generator?: string } }).asset?.generator ?? ''));
    const seen = new Set<MeshStandardMaterial>();
    // Parts whose STEP colours kicad-cli dropped carry no material: three's white default (no glTF material index;
    // the loader may still keep an empty association), or a placeholder named `ref:<REF>` that the homepage's bake step
    // adds so the part survives mesh merging. Give each the finish its footprint implies (metal shell, nylon connector,
    // ceramic capacitor...), found from the nearest node named after a reference; default to dark moulded epoxy.
    const finishes = new Map<string, MeshStandardMaterial>();
    const finished = (ref: string | null) => {
      const key = ref ?? '';
      let m = finishes.get(key);
      if (!m) {
        const f = (ref && finishFor?.(ref)) || { color: 0x1d1d1f, roughness: 0.62, metalness: 0 };
        finishes.set(key, (m = new MeshStandardMaterial(f)));
      }
      return m;
    };
    const refOf = (o: Object3D | null): string | null => {
      for (let n = o; n; n = n.parent) if (n.name && finishFor?.(n.name)) return n.name;
      return null;
    };
    gltf.scene.traverse((o) => {
      if (!(o instanceof Mesh)) return;
      if (kicad && !Array.isArray(o.material)) {
        const tagged = /^ref:(.+)$/.exec(o.material.name ?? '');
        if (tagged) {
          o.material = finished(tagged[1]!);
          return;
        }
        if (gltf.parser.associations.get(o.material)?.materials === undefined) {
          o.material = finished(refOf(o));
          return;
        }
      }
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (!(m instanceof MeshStandardMaterial) || seen.has(m)) continue;
        seen.add(m);
        if (kicad) m.color.convertSRGBToLinear();
        finishKicadMaterial(m);
      }
    });
    this.setModel(gltf.scene);
  }

  async loadStep(buffer: ArrayBuffer): Promise<void> {
    const { default: occtimportjs } = await import('occt-import-js');
    const wasm = this.opts.occtWasmUrl;
    const occt = await occtimportjs(wasm ? { locateFile: () => wasm } : undefined);
    const result = occt.ReadStepFile(new Uint8Array(buffer), null);
    if (!result.success) throw new Error('Could not read STEP file');
    const group = new Group();
    for (const m of result.meshes) {
      const geo = new BufferGeometry();
      geo.setAttribute('position', new BufferAttribute(new Float32Array(m.attributes.position.array), 3));
      if (m.attributes.normal) geo.setAttribute('normal', new BufferAttribute(new Float32Array(m.attributes.normal.array), 3));
      geo.setIndex(new BufferAttribute(new Uint32Array(m.index.array), 1));
      if (!m.attributes.normal) geo.computeVertexNormals();
      const base = m.color ? new Color(m.color[0], m.color[1], m.color[2]) : new Color(0xb0b0b0);
      const materials: Material[] = [new MeshStandardMaterial({ color: base, metalness: 0.1, roughness: 0.6 })];
      for (const f of m.brep_faces) {
        if (!f.color) continue;
        materials.push(new MeshStandardMaterial({ color: new Color(f.color[0], f.color[1], f.color[2]), metalness: 0.1, roughness: 0.6 }));
        geo.addGroup(f.first * 3, (f.last - f.first + 1) * 3, materials.length - 1);
      }
      if (materials.length > 1) {
        // Faces without colour fall back to the mesh colour.
        geo.addGroup(0, Infinity, 0);
      }
      group.add(new Mesh(geo, materials.length > 1 ? materials : materials[0]));
    }
    this.setModel(group);
  }

  setProjection(ortho: boolean): void {
    if (ortho === this.ortho) return;
    this.ortho = ortho;
    const target = this.controls.target.clone();
    const pos = this.camera.position.clone();
    const up = this.camera.up.clone();
    this.camera = this.makeCamera(ortho);
    this.camera.up.copy(up);
    this.camera.position.copy(pos);
    this.controls.object = this.camera;
    this.controls.target.copy(target);
    this.fitCamera(pos.clone().sub(target).normalize());
  }

  setView(view: View3D): void {
    const n = this.normal.clone();
    const side = new Vector3().crossVectors(this.up, n).normalize();
    // Top and bottom lean a hair off straight-on: looking exactly along the orbit axis has no defined "up" on screen.
    // The lean keeps the board's own up pointing up, and the bottom view mirrored left to right like KiCad's.
    const dirs: Record<View3D, Vector3> = {
      top: n.clone().add(this.up.clone().multiplyScalar(-1e-4)).normalize(),
      bottom: n.clone().negate().add(this.up.clone().multiplyScalar(1e-4)).normalize(),
      front: this.up.clone().negate(),
      back: this.up.clone(),
      left: side.clone().negate(),
      right: side.clone(),
      iso: n.clone().multiplyScalar(1).add(this.up.clone().multiplyScalar(-0.9)).add(side.clone().multiplyScalar(0.6)).normalize(),
    };
    this.orbitAround(n);
    this.fitCamera(dirs[view]);
  }

  private fitCamera(dir: Vector3): void {
    if (!this.model) return;
    const box = new Box3().setFromObject(this.model);
    // A bounding sphere leaves a flat board small in the frame; boards are thin, so most of that sphere is empty.
    const radius = (box.getSize(new Vector3()).length() / 2) * 0.72 || 1;
    const center = box.getCenter(new Vector3());
    if (this.camera instanceof PerspectiveCamera) {
      const dist = radius / Math.sin((this.camera.fov * Math.PI) / 360);
      this.camera.position.copy(center.clone().add(dir.clone().multiplyScalar(dist)));
      this.camera.near = dist / 1000;
      this.camera.far = dist * 100;
    } else {
      const aspect = this.el.clientWidth / Math.max(this.el.clientHeight, 1);
      this.camera.top = radius;
      this.camera.bottom = -radius;
      this.camera.left = -radius * aspect;
      this.camera.right = radius * aspect;
      this.camera.position.copy(center.clone().add(dir.clone().multiplyScalar(radius * 4)));
    }
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(center);
    // Keep the board in reach: no zooming through it or off into the distance.
    this.controls.minDistance = radius * 0.08;
    this.controls.maxDistance = radius * 12;
    this.controls.update();
  }

  destroy(): void {
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    this.renderer.domElement.removeEventListener('pointerdown', this.onDown);
    this.renderer.domElement.removeEventListener('pointerup', this.onUp);
    this.controls.dispose();
    if (this.model) disposeTree(this.model);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

/**
 * kicad-cli leaves metallic/roughness unset on most model materials, and glTF's defaults for unset values (fully metal,
 * fully rough) turn every plastic body into grey chalk. Give unset materials the finish KiCad's own renderer implies:
 * neutral light greys and warm brass tones are metal (shields, shells, pins), everything else is moulded plastic.
 */
function finishKicadMaterial(m: MeshStandardMaterial): void {
  if (m.metalness !== 1 || m.roughness !== 1) return;
  const { r, g, b } = m.color;
  const max = Math.max(r, g, b);
  const neutral = max - Math.min(r, g, b) < 0.04;
  const brass = r > 0.25 && r >= g && g > b * 2; // gold, brass and copper pins
  if ((neutral && max > 0.15) || brass) {
    m.metalness = 0.9;
    m.roughness = 0.32;
  } else {
    // Moulded epoxy and nylon are matte; glossier values mirror the studio lights and turn black chips white.
    m.metalness = 0;
    m.roughness = 0.7;
  }
}

function disposeTree(obj: Object3D): void {
  obj.traverse((o) => {
    if (o instanceof Mesh) {
      o.geometry.dispose();
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) (m as Material).dispose();
    }
  });
}
