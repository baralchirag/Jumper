// Ambient types for occt-import-js; consumers compile this file from source.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./occt.d.ts" />
import {
  AmbientLight,
  Box3,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  Group,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  OrthographicCamera,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
  type Material,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export type View3D = 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right' | 'iso';

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
    this.controls.rotateSpeed = 0.9;
    this.controls.zoomToCursor = true;
    this.controls.autoRotateSpeed = 1.5;
    // Any interaction stops the turntable.
    this.controls.addEventListener('start', () => {
      if (this.controls.autoRotate) {
        this.controls.autoRotate = false;
        this.onAutoRotateChange?.(false);
      }
    });

    this.scene.add(new HemisphereLight(0xffffff, 0x404040, 1.2));
    this.scene.add(new AmbientLight(0xffffff, 0.35));
    const key = new DirectionalLight(0xffffff, 1.6);
    key.position.set(1, 2, 1.5);
    const fill = new DirectionalLight(0xffffff, 0.6);
    fill.position.set(-1.5, -1, -1);
    this.scene.add(key, fill);

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

  /** Turn the board over (rotate 180° about the camera's up axis). */
  flip(): void {
    const target = this.controls.target.clone();
    const offset = this.camera.position.clone().sub(target);
    const axis = this.camera.up.clone().normalize();
    offset.applyAxisAngle(axis, Math.PI);
    this.camera.position.copy(target.clone().add(offset));
    this.camera.lookAt(target);
    this.controls.update();
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

  async loadGlb(source: string | ArrayBuffer): Promise<void> {
    const loader = new GLTFLoader();
    const gltf = typeof source === 'string' ? await loader.loadAsync(source) : await loader.parseAsync(source, '');
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
    this.camera = this.makeCamera(ortho);
    this.camera.position.copy(pos);
    this.controls.object = this.camera;
    this.controls.target.copy(target);
    this.fitCamera(pos.clone().sub(target).normalize());
  }

  setView(view: View3D): void {
    const n = this.normal.clone();
    const side = new Vector3().crossVectors(this.up, n).normalize();
    const dirs: Record<View3D, Vector3> = {
      top: n.clone(),
      bottom: n.clone().negate(),
      front: this.up.clone().negate(),
      back: this.up.clone(),
      left: side.clone().negate(),
      right: side.clone(),
      iso: n.clone().multiplyScalar(1).add(this.up.clone().multiplyScalar(-0.9)).add(side.clone().multiplyScalar(0.6)).normalize(),
    };
    this.camera.up.copy(view === 'top' || view === 'bottom' ? this.up : n);
    this.fitCamera(dirs[view]);
  }

  private fitCamera(dir: Vector3): void {
    if (!this.model) return;
    const box = new Box3().setFromObject(this.model);
    const radius = box.getSize(new Vector3()).length() / 2 || 1;
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
    this.controls.update();
  }

  destroy(): void {
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    if (this.model) disposeTree(this.model);
    this.renderer.dispose();
    this.renderer.domElement.remove();
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
