import { useEffect, useRef, useState } from 'react';
import { cx } from '@jumper/ui';
import meta from './assets/board.json';
import topUrl from './assets/board-top.webp';
import insideUrl from './assets/board-inside.webp';

/**
 * The homepage "x-ray" board: a real open-source board (RoyalBlue54L Feather, CERN-OHL-P), built by
 * scripts/hero-board/build.py. The top is KiCad's raytraced render; the inside is the board's actual
 * copper (F.Cu, In2, In4) drawn from its pcbnew geometry. A fragment shader blends the two through a
 * metaball field built from the cursor and a short decaying trail, so the reveal has soft, merging,
 * liquid edges. Signal dots travel the board's real track paths for a few named nets. Without WebGL it
 * falls back to a static clipped reveal; under reduced motion it renders once, half revealed.
 */

type Pt = { x: number; y: number };
const W = meta.width;
const H = meta.height;
const MONO = '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, monospace';

const MAX_BLOBS = 24;
const MAX_DOTS = 6;
const TRAIL_MS = 600;

const VERT = `attribute vec2 a; void main(){ gl_Position = vec4(a, 0.0, 1.0); }`;

const FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D uTop;
uniform sampler2D uIn;
uniform vec2 uRes;
uniform vec3 uB[${MAX_BLOBS}];
uniform vec3 uD[${MAX_DOTS}];
uniform float uT;
uniform float uDpr;
void main() {
  vec2 p = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec2 uv = p / uRes;
  float f = 0.0;
  for (int i = 0; i < ${MAX_BLOBS}; i++) {
    vec3 b = uB[i];
    if (b.z > 0.5) { vec2 d = p - b.xy; f += b.z * b.z / (dot(d, d) + 1.0); }
  }
  vec2 q = p / uDpr;
  float w = sin(q.x * 0.031 + uT * 1.7) * sin(q.y * 0.027 - uT * 1.3) + 0.5 * sin((q.x + q.y) * 0.05 + uT * 2.3);
  f *= 1.0 + 0.07 * w;
  float m = smoothstep(0.94, 1.06, f);
  vec4 top = texture2D(uTop, uv);
  vec4 ins = texture2D(uIn, uv);
  vec3 add = vec3(0.0);
  for (int i = 0; i < ${MAX_DOTS}; i++) {
    vec3 d = uD[i];
    if (d.z > 0.0) {
      float r = length(p - d.xy) / uDpr;
      add += d.z * (vec3(1.0, 0.83, 0.64) * smoothstep(3.0, 1.4, r) + vec3(0.88, 0.54, 0.31) * 0.32 * smoothstep(13.0, 0.0, r));
    }
  }
  ins.rgb += add * ins.a;
  float rim = smoothstep(0.74, 0.95, f) * (1.0 - m);
  top.rgb *= 1.0 - 0.42 * rim;
  gl_FragColor = mix(top, ins, m);
}`;

type Blob = { x: number; y: number; r0: number; t: number };

function pathLengths(path: Pt[]) {
  const seg: number[] = [];
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    const l = Math.hypot(path[i]!.x - path[i - 1]!.x, path[i]!.y - path[i - 1]!.y);
    seg.push(l);
    total += l;
  }
  return { seg, total };
}

const SIGNALS = meta.nets.map((n) => {
  const path = n.path.map(([x, y]) => ({ x: x! * W, y: y! * H }));
  return { path, ...pathLengths(path) };
});

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/** Net names on the inside layer, drawn at runtime so they use the page's mono font. */
function drawLabels(ctx: CanvasRenderingContext2D, pw: number, ph: number, scale: number) {
  const size = Math.round(10 * scale);
  ctx.font = `500 ${size}px ${MONO}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  const placed: Pt[] = [];
  for (const n of meta.nets) {
    const x = n.at[0]! * pw;
    const y = n.at[1]! * ph;
    if (placed.some((p) => Math.hypot(p.x - x, p.y - y) < size * 3)) continue;
    placed.push({ x, y });
    const vertical = Math.abs(Math.abs(n.angle) - 90) < 1;
    const w = ctx.measureText(n.label).width + size * 0.9;
    const h = size * 1.5;
    ctx.save();
    ctx.translate(x, y);
    if (vertical) ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = 'rgba(18,17,16,0.92)';
    ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.strokeStyle = 'rgba(224,138,79,0.55)';
    ctx.lineWidth = Math.max(1, scale * 0.6);
    ctx.strokeRect(-w / 2, -h / 2, w, h);
    ctx.fillStyle = '#EDE9E3';
    ctx.fillText(n.label, 0, size * 0.05);
    ctx.restore();
  }
}

function pointAt(sig: (typeof SIGNALS)[number], dist: number): Pt {
  let d = dist % sig.total;
  for (let i = 0; i < sig.seg.length; i++) {
    const l = sig.seg[i]!;
    if (d <= l) {
      const a = sig.path[i]!;
      const b = sig.path[i + 1]!;
      const k = l === 0 ? 0 : d / l;
      return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
    }
    d -= l;
  }
  return sig.path[sig.path.length - 1]!;
}

function compile(gl: WebGLRenderingContext, type: number, src: string) {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
  return s;
}

export function XrayBoard({ className }: { className?: string }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const tiltRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [mode, setMode] = useState<'fine' | 'touch' | 'static'>('fine');

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    let disposed = false;
    Promise.all([loadImage(topUrl), loadImage(insideUrl)]).then(
      ([topImg, insImg]) => {
        if (!disposed) cleanup = setup(topImg, insImg);
      },
      () => {},
    );
    return () => {
      disposed = true;
      cleanup?.();
    };

  function setup(topImg: HTMLImageElement, insImg: HTMLImageElement): (() => void) | undefined {
    const wrap = wrapRef.current!;
    const tiltEl = tiltRef.current!;
    const canvas = canvasRef.current!;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) setMode('static');
    else if (matchMedia('(pointer: coarse)').matches) setMode('touch');

    const top = document.createElement('canvas');
    const ins = document.createElement('canvas');
    let dpr = 1;
    let cssW = 1;
    let cssH = 1;

    const paint2D = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      cssW = Math.max(1, wrap.clientWidth);
      cssH = (cssW * H) / W;
      const pw = Math.round(cssW * dpr);
      const ph = Math.round(cssH * dpr);
      for (const [c, img] of [
        [top, topImg],
        [ins, insImg],
      ] as const) {
        c.width = pw;
        c.height = ph;
        const ctx = c.getContext('2d')!;
        ctx.imageSmoothingQuality = 'high';
        ctx.clearRect(0, 0, pw, ph);
        ctx.drawImage(img, 0, 0, pw, ph);
      }
      drawLabels(ins.getContext('2d')!, pw, ph, dpr * Math.min(1.25, Math.max(0.8, cssW / 760)));
      canvas.width = pw;
      canvas.height = ph;
    };

    // Fixed blobs for the reduced-motion / fallback "half revealed" state (fractions of width).
    const staticBlobs = (): [number, number, number][] => [
      [0.36, 0.48, 0.11],
      [0.46, 0.6, 0.09],
      [0.28, 0.62, 0.07],
      [0.5, 0.36, 0.08],
      [0.22, 0.4, 0.06],
    ];

    const gl = canvas.getContext('webgl', { premultipliedAlpha: true, antialias: false, alpha: true });
    if (!gl) {
      // No WebGL: stack the two renders and clip the inside one to a fixed opening.
      paint2D();
      canvas.style.display = 'none';
      for (const c of [top, ins]) {
        c.className = 'absolute inset-0 h-full w-full';
        tiltEl.appendChild(c);
      }
      ins.style.clipPath = 'circle(28% at 66% 50%)';
      setMode('static');
      return () => {
        top.remove();
        ins.remove();
      };
    }

    let prog: WebGLProgram;
    try {
      prog = gl.createProgram()!;
      gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
      gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'link');
    } catch (err) {
      console.error('x-ray board shader failed', err);
      return;
    }
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    const aLoc = gl.getAttribLocation(prog, 'a');
    gl.enableVertexAttribArray(aLoc);
    gl.vertexAttribPointer(aLoc, 2, gl.FLOAT, false, 0, 0);

    const makeTex = (unit: number, name: string) => {
      const t = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.uniform1i(gl.getUniformLocation(prog, name), unit);
      return t;
    };
    const texTop = makeTex(0, 'uTop');
    const texIn = makeTex(1, 'uIn');
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);

    const uRes = gl.getUniformLocation(prog, 'uRes');
    const uB = gl.getUniformLocation(prog, 'uB');
    const uD = gl.getUniformLocation(prog, 'uD');
    const uT = gl.getUniformLocation(prog, 'uT');
    const uDpr = gl.getUniformLocation(prog, 'uDpr');
    const blobBuf = new Float32Array(MAX_BLOBS * 3);
    const dotBuf = new Float32Array(MAX_DOTS * 3);

    const upload = () => {
      paint2D();
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texTop);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, top);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, texIn);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, ins);
    };

    /* ── Interaction state (CSS px, relative to the wrapper) ── */
    const target = { x: 0, y: 0 };
    const head = { x: 0, y: 0 };
    let headR = 0;
    let over = false;
    let trail: Blob[] = [];
    const tilt = { x: 0, y: 0 };
    let raf = 0;
    let last = 0;

    const draw = (now: number, blobs: [number, number, number][], dotsOn: boolean) => {
      blobBuf.fill(0);
      blobs.slice(0, MAX_BLOBS).forEach(([x, y, r], i) => {
        blobBuf[i * 3] = x * dpr;
        blobBuf[i * 3 + 1] = y * dpr;
        blobBuf[i * 3 + 2] = r * dpr;
      });
      dotBuf.fill(0);
      if (dotsOn) {
        const s = canvas.width / W;
        SIGNALS.slice(0, MAX_DOTS).forEach((sig, i) => {
          const p = pointAt(sig, now * 0.16 + i * 211);
          dotBuf[i * 3] = p.x * s;
          dotBuf[i * 3 + 1] = p.y * s;
          dotBuf[i * 3 + 2] = 1;
        });
      }
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform3fv(uB, blobBuf);
      gl.uniform3fv(uD, dotBuf);
      gl.uniform1f(uT, now / 1000);
      gl.uniform1f(uDpr, dpr);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    };

    const drawStatic = () => draw(0, staticBlobs().map(([x, y, r]) => [x * cssW, y * cssH, r * cssW]), false);

    const frame = (now: number) => {
      const dt = Math.min(64, last ? now - last : 16) / 16.667;
      last = now;
      const R = cssW * 0.075;

      const k = 1 - Math.pow(1 - 0.2, dt);
      head.x += (target.x - head.x) * k;
      head.y += (target.y - head.y) * k;
      const kr = 1 - Math.pow(1 - (over ? 0.14 : 0.1), dt);
      headR += ((over ? R : 0) - headR) * kr;

      const lastBlob = trail[trail.length - 1];
      if (over && headR > R * 0.2 && (!lastBlob || Math.hypot(head.x - lastBlob.x, head.y - lastBlob.y) > R * 0.22)) {
        trail.push({ x: head.x, y: head.y, r0: headR * (0.72 + Math.random() * 0.28), t: now });
      }
      trail = trail.filter((b) => now - b.t < TRAIL_MS).slice(-(MAX_BLOBS - 2));

      const blobs: [number, number, number][] = [];
      if (headR > 0.5) {
        const a = now * 0.0021;
        blobs.push([head.x, head.y, headR]);
        blobs.push([head.x + Math.cos(a) * headR * 0.55, head.y + Math.sin(a * 1.3) * headR * 0.45, headR * 0.55]);
      }
      for (const b of trail) {
        const life = 1 - (now - b.t) / TRAIL_MS;
        blobs.push([b.x, b.y, b.r0 * Math.pow(life, 1.3)]);
      }

      const tx = over ? (target.y / cssH - 0.5) * -4 : 0;
      const ty = over ? (target.x / cssW - 0.5) * 5 : 0;
      const kt = 1 - Math.pow(1 - 0.08, dt);
      tilt.x += (tx - tilt.x) * kt;
      tilt.y += (ty - tilt.y) * kt;
      tiltEl.style.transform = `perspective(1400px) rotateX(${tilt.x.toFixed(3)}deg) rotateY(${tilt.y.toFixed(3)}deg)`;

      const alive = blobs.length > 0;
      draw(now, blobs, alive);

      if (alive || over || Math.abs(tilt.x) + Math.abs(tilt.y) > 0.01) raf = requestAnimationFrame(frame);
      else {
        raf = 0;
        last = 0;
        tiltEl.style.transform = '';
      }
    };

    const wake = () => {
      if (!raf) raf = requestAnimationFrame(frame);
    };

    const locate = (e: PointerEvent) => {
      const r = wrap.getBoundingClientRect();
      target.x = e.clientX - r.left;
      target.y = e.clientY - r.top;
      if (headR < 2) {
        head.x = target.x;
        head.y = target.y;
      }
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse' && !over) return;
      if (e.pointerType === 'mouse') over = true;
      locate(e);
      wake();
    };
    const onDown = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') return;
      over = true;
      locate(e);
      wake();
    };
    const onUp = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') return;
      over = false;
      wake();
    };
    const onLeave = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      over = false;
      wake();
    };

    upload();
    canvas.style.opacity = '1';
    if (reduced) drawStatic();
    else {
      draw(0, [], false);
      wrap.addEventListener('pointermove', onMove);
      wrap.addEventListener('pointerdown', onDown);
      wrap.addEventListener('pointerup', onUp);
      wrap.addEventListener('pointercancel', onUp);
      wrap.addEventListener('pointerleave', onLeave);
    }

    const redraw = () => {
      upload();
      if (reduced) drawStatic();
      else if (!raf) draw(0, [], false);
    };
    let lastW = cssW;
    const ro = new ResizeObserver(() => {
      if (Math.abs(wrap.clientWidth - lastW) < 1) return;
      lastW = wrap.clientWidth;
      redraw();
    });
    ro.observe(wrap);
    // Labels use the webfont; repaint once it is available.
    document.fonts?.load('500 10px "JetBrains Mono Variable"').then(redraw, () => {});

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      wrap.removeEventListener('pointermove', onMove);
      wrap.removeEventListener('pointerdown', onDown);
      wrap.removeEventListener('pointerup', onUp);
      wrap.removeEventListener('pointercancel', onUp);
      wrap.removeEventListener('pointerleave', onLeave);
      // Not loseContext(): StrictMode re-runs this effect on the same canvas and would get the lost context back.
      gl.deleteTexture(texTop);
      gl.deleteTexture(texIn);
      gl.deleteBuffer(buf);
      gl.deleteProgram(prog);
    };
  }
  }, []);

  const caption = mode === 'static' ? 'Top layer, with the copper shown underneath' : mode === 'touch' ? 'Drag across the board to see inside' : 'Move over the board to see inside';

  return (
    <figure className={cx('select-none', className)}>
      <div
        ref={wrapRef}
        role="img"
        aria-label={`${meta.board.name}, an open-source ${meta.board.copperLayers}-layer board. Moving the pointer over it peels back the solder mask to show the copper layers underneath.`}
        className="relative"
        style={{ touchAction: 'pan-y' }}
      >
        <div ref={tiltRef} className="relative w-full" style={{ aspectRatio: `${W} / ${H}` }}>
          <canvas ref={canvasRef} aria-hidden className="block h-full w-full opacity-0 transition-opacity duration-500" />
        </div>
      </div>
      <figcaption className="mt-6 flex flex-col items-center gap-1.5 text-center font-mono text-[12px] tracking-[0.01em] text-fg-muted">
        <span>{caption}</span>
        <span className="text-fg-subtle">
          <a href={meta.board.url} target="_blank" rel="noreferrer" className="underline decoration-from-font underline-offset-2 hover:text-fg">
            {meta.board.name}
          </a>{' '}
          by {meta.board.author} · <span className="whitespace-nowrap">{meta.board.license}</span> · {meta.board.copperLayers} layers
        </span>
      </figcaption>
    </figure>
  );
}
