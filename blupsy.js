/*!
 * Miss Blupsy — character engine
 * A floating soap-bubble companion drawn in real time: a WebGL thin-film bubble
 * with a hand-drawn cartoon face, rubber-hose arms and legs, moods, flight and speech.
 *
 * Usage:
 *   const blupsy = new MissBlupsy(document.getElementById('stage'), { size: 46 });
 *   await blupsy.enter();
 *   blupsy.setMood('happy');
 *   await blupsy.flyTo(400, 300);
 *   await blupsy.say('بُب! وصلت 🫧');
 *
 * All coordinates are CSS pixels relative to the container element.
 */
(function (root) {
  'use strict';

  // ───────────────────────────── math helpers ─────────────────────────────
  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const damp = (a, b, rate, dt) => a + (b - a) * (1 - Math.exp(-rate * dt));
  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[(Math.random() * arr.length) | 0];
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const len = (x, y) => Math.hypot(x, y);
  const Ease = {
    inOutSine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
    inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
    outCubic: (t) => 1 - Math.pow(1 - t, 3),
    outBack: (t) => { const s = 1.25; return 1 + (s + 1) * Math.pow(t - 1, 3) + s * Math.pow(t - 1, 2); },
  };

  /** Damped spring, sub-stepped so large frame gaps stay stable. */
  class Spring {
    constructor(k, c, x = 0) { this.k = k; this.c = c; this.x = x; this.v = 0; }
    step(target, dt) {
      const n = Math.max(1, Math.ceil(dt / 0.006));
      const h = dt / n;
      for (let i = 0; i < n; i++) {
        this.v += (-this.k * (this.x - target) - this.c * this.v) * h;
        this.x += this.v * h;
      }
      return this.x;
    }
    set(x) { this.x = x; this.v = 0; }
  }
  class Spring2 {
    constructor(k, c) { this.sx = new Spring(k, c); this.sy = new Spring(k, c); }
    step(tx, ty, dt) { this.sx.step(tx, dt); this.sy.step(ty, dt); }
    set(x, y) { this.sx.set(x); this.sy.set(y); }
    get x() { return this.sx.x; }
    get y() { return this.sy.x; }
    tune(k, c) { this.sx.k = this.sy.k = k; this.sx.c = this.sy.c = c; }
  }

  // ───────────────────────────── palette ─────────────────────────────
  const INK = '#1a1d4a';
  const PINK = '#ff5fa2';
  const PINK_HI = '#ffa3cf';
  const PINK_LO = '#e0357f';
  const ARM_FILL = '#e4dcff';
  // effects that drift slowly enough to look the same at 30 fps (sleep "z"s, little bubbles, a finished red circle)
  const CALM_FX = new Set(['z', 'mini', 'scribble']);

  const THEMES = {
    rainbow: { tint: [0.72, 0.86, 1.0], amt: 0.0 },
    pink: { tint: [1.0, 0.56, 0.82], amt: 0.32 },
    ocean: { tint: [0.36, 0.72, 1.0], amt: 0.34 },
    gold: { tint: [1.0, 0.8, 0.38], amt: 0.38 },
    mint: { tint: [0.45, 1.0, 0.8], amt: 0.3 },
  };

  // ───────────────────────────── moods ─────────────────────────────
  // face: eyes, brows, mouth.  body: motion + film colour.  arms/legs: pose names.
  const FACE0 = {
    eyeOpen: 1, lidTilt: 0, happyEye: 0, eyeScale: 1, pupil: 1,
    browY: 0, browTilt: 0, browAsym: 0,
    mouthW: 0.2, mouthOpen: 0, mouthCurve: 0.7, mouthRound: 0, tongue: 0, blush: 0.3,
  };
  const BODY0 = { bob: 1, bobFreq: 1.5, hop: 0, sag: 0, sat: 1, bright: 1, tintAmt: 0, wob: 0.012 };
  const MOODS = {
    idle: { arms: ['float', 'float'], legs: 'dangle', look: 'cursor' },
    happy: {
      face: { happyEye: 1, mouthW: 0.25, mouthOpen: 0.1, mouthCurve: 1, blush: 0.7, browY: 0.45 },
      body: { bob: 0, hop: 1, bright: 1.12, sat: 1.25, wob: 0.022 },
      arms: ['cheer', 'cheer'], legs: 'kick', look: 'cursor', fx: { sparks: 2.2 },
    },
    proud: {
      face: { eyeOpen: 0.62, lidTilt: -0.15, mouthW: 0.2, mouthCurve: 1, blush: 0.55, browY: 0.35 },
      body: { bob: 0.7, bright: 1.08, sat: 1.15 },
      arms: ['hips', 'hips'], legs: 'dangle', look: 'cursor', fx: { sparks: 0.8 },
    },
    bored: {
      face: { eyeOpen: 0.42, lidTilt: -0.3, browY: -0.35, browTilt: -0.25, mouthW: 0.12, mouthCurve: -0.12, blush: 0.05 },
      body: { bob: 0.35, bobFreq: 0.6, sag: 0.3, sat: 0.55, bright: 0.9, wob: 0.006 },
      arms: ['droop', 'droop'], legs: 'tap', look: 'down', fx: { puff: 0.18 },
    },
    thinking: {
      face: { eyeOpen: 0.92, browAsym: 1, mouthW: 0.085, mouthOpen: 0.035, mouthCurve: 0, mouthRound: 1, blush: 0.22 },
      body: { bob: 0.6, bobFreq: 0.9 },
      arms: ['float', 'chin'], legs: 'cross', look: 'up', fx: { dots: 1 },
    },
    listening: {
      face: { eyeOpen: 1.1, eyeScale: 1.06, pupil: 1.14, browY: 0.55, mouthW: 0.12, mouthCurve: 0.5 },
      body: { bob: 0.6 },
      arms: ['float', 'ear'], legs: 'dangle', look: 'cursor', fx: { rings: 1 },
    },
    sleeping: {
      face: { eyeOpen: 0, mouthW: 0.07, mouthOpen: 0.035, mouthRound: 1, blush: 0.4, browY: -0.1 },
      body: { bob: 0.45, bobFreq: 0.45, sag: 0.34, sat: 0.7, bright: 0.86, wob: 0.005 },
      arms: ['tuck', 'tuck'], legs: 'curl', look: 'none', fx: { z: 1 },
    },
    surprised: {
      face: { eyeOpen: 1.22, eyeScale: 1.12, pupil: 0.7, browY: 1, mouthW: 0.12, mouthOpen: 0.15, mouthRound: 1, blush: 0.2 },
      body: { bob: 0.2, wob: 0.035 },
      arms: ['up', 'up'], legs: 'spread', look: 'cursor',
    },
    angry: {
      face: { eyeOpen: 0.7, lidTilt: 1, browTilt: 1, browY: -0.2, mouthW: 0.12, mouthCurve: -0.75, blush: 0.12 },
      body: { bob: 0.3, tintAmt: 0.42, sat: 1.1, wob: 0.014 },
      tint: [1.0, 0.32, 0.36],
      arms: ['cross', 'cross'], legs: 'dangle', look: 'away',
    },
    sad: {
      face: { eyeOpen: 0.9, browTilt: -0.9, browY: 0.2, pupil: 1.2, mouthW: 0.12, mouthCurve: -0.6, blush: 0.15 },
      body: { bob: 0.4, bobFreq: 0.8, sag: 0.15, sat: 0.6, bright: 0.92 },
      arms: ['droop', 'droop'], legs: 'dangle', look: 'down',
    },
    working: {
      face: { eyeOpen: 0.86, browTilt: 0.3, browY: -0.08, mouthW: 0.1, mouthCurve: 0.25, tongue: 1, blush: 0.22 },
      body: { bob: 0.45 },
      arms: ['float', 'float'], legs: 'dangle', look: 'target',
    },
  };

  // Arm poses in body units (R = 1). side = -1 left, +1 right. y grows downward.
  const ARM = {
    float: (s, t) => ({ x: s * 1.22, y: 0.34 + Math.sin(t * 1.6 + s * 1.3) * 0.07, g: 'open', sag: 0.3 }),
    cheer: (s, t) => ({ x: s * (1.12 + 0.05 * Math.sin(t * 10)), y: -0.8 + 0.08 * Math.sin(t * 10 + s), g: 'wave', sag: -0.2 }),
    wave: (s, t) => (s > 0 ? { x: 1.28 + 0.1 * Math.sin(t * 11), y: -0.74, g: 'wave', sag: -0.25, rot: -1.35 + Math.sin(t * 11) * 0.45 } : ARM.float(s, t)),
    thumbsup: (s, t) => (s > 0 ? { x: 1.22, y: -0.35, g: 'thumb', sag: 0.5, rot: 0 } : ARM.float(s, t)),
    peace: (s, t) => (s > 0 ? { x: 1.25, y: -0.62, g: 'peace', sag: -0.1, rot: -1.45 + Math.sin(t * 3) * 0.08 } : ARM.float(s, t)),
    droop: (s, t) => ({ x: s * 1.0, y: 1.02 + Math.sin(t * 0.7 + s) * 0.03, g: 'open', sag: 0.1 }),
    chin: (s, t) => (s > 0 ? { x: 0.3, y: 0.68, g: 'fist', sag: 0.55, rot: -1.9 } : ARM.float(s, t)),
    ear: (s, t) => (s > 0 ? { x: 1.08, y: -0.2, g: 'cup', sag: 0.6, rot: -2.3 } : ARM.float(s, t)),
    cross: (s) => ({ x: -s * 0.3, y: 0.55 + (s > 0 ? 0 : 0.07), g: 'fist', sag: 0.45 }),
    tuck: (s) => ({ x: s * 0.62, y: 0.98, g: 'fist', sag: 0.3 }),
    up: (s) => ({ x: s * 1.2, y: -0.96, g: 'wave', sag: -0.1 }),
    hips: (s) => ({ x: s * 0.98, y: 0.42, g: 'fist', sag: 1.0, elbowOut: 1 }),
    clap: (s, t) => ({ x: s * (0.14 + 0.14 * Math.abs(Math.sin(t * 8))), y: 0.66, g: 'open', sag: 0.45 }),
    stretch: (s) => ({ x: s * 1.02, y: -1.2, g: 'open', sag: 0 }),
    carry: (s) => ({ x: s * 0.42, y: 1.02, g: 'grab', sag: 0.35 }),
  };
  const LEG = {
    dangle: (s, t) => ({ x: s * 0.34 + Math.sin(t * 1.3 + s) * 0.04, y: 1.6 }),
    kick: (s, t) => ({ x: s * 0.46, y: 1.46 - 0.22 * Math.max(0, Math.sin(t * 9 + (s > 0 ? 0 : Math.PI))) }),
    tap: (s, t) => (s > 0 ? { x: 0.42, y: 1.58 - 0.12 * Math.max(0, Math.sin(t * 7)) } : { x: -0.34, y: 1.6 }),
    curl: (s) => ({ x: s * 0.24, y: 1.32 }),
    spread: (s) => ({ x: s * 0.72, y: 1.45 }),
    cross: (s) => ({ x: -s * 0.1, y: 1.6 }),
    sit: (s) => ({ x: s * 0.64, y: 1.2 }),
  };

  // ───────────────────────────── WebGL bubble ─────────────────────────────
  const VERT = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';
  const FRAG = `
precision highp float;
uniform vec2 uRes; uniform vec2 uC; uniform float uR;
uniform vec2 uDir; uniform float uA; uniform float uB;
uniform float uT; uniform float uWob; uniform float uSat; uniform float uBright;
uniform vec3 uTint; uniform float uTintAmt;
uniform float uPop; uniform vec2 uPopO; uniform float uDpr; uniform float uSeed;

float sdBox(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
vec3 film(float h){ return 0.5 + 0.5 * cos(6.28318 * (h + vec3(0.0, 0.33, 0.67))); }

void main(){
  vec2 p = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec2 d = p - uC;
  vec2 pd = vec2(-uDir.y, uDir.x);
  vec2 q = vec2(dot(d, uDir) / uA, dot(d, pd) / uB) / uR;
  float th = atan(q.y, q.x);
  float t = uT + uSeed;
  float w = 1.0
    + uWob * (0.55 * sin(3.0 * th + t * 2.3) + 0.3 * sin(5.0 * th - t * 3.1 + 1.3) + 0.15 * sin(2.0 * th + t * 1.7 + 2.1))
    + 0.008 * sin(4.0 * th + t * 1.9);
  float r = length(q) / w;
  float px = 1.0 / (uR * min(uA, uB));
  float cover = 1.0 - smoothstep(1.0 - 1.1 * px, 1.0 + 0.7 * px, r);
  if (cover <= 0.0) { gl_FragColor = vec4(0.0); return; }

  vec2 qn = q / w;
  float rr = min(r, 0.9995);
  float z = sqrt(1.0 - rr * rr);
  vec2 sxy = (qn.x * uDir + qn.y * pd) / max(length(qn), 1e-4) * rr;   // unit-disc point in screen frame
  vec3 n = normalize(vec3(sxy, z));
  float cv = n.z;
  float F = pow(1.0 - cv, 2.2);

  // thin-film thickness: slow swirls + gravity drainage (thicker toward the bottom)
  float h = 0.36
    + 0.22 * sin(n.x * 3.0 + t * 0.55 + sin(n.y * 2.6 - t * 0.35) * 1.6)
    + 0.16 * sin(n.y * 4.4 - t * 0.45 + n.x * 1.9)
    + 0.08 * sin((n.x + n.y) * 9.0 + t * 1.2)
    + 0.30 * n.y;
  vec3 fc = film(h * 1.35 + (1.0 - cv) * 0.55);
  float lum = dot(fc, vec3(0.299, 0.587, 0.114));
  fc = mix(vec3(lum), fc, uSat);
  fc = mix(fc, uTint, uTintAmt);

  // environment: soft sky, a window reflection, a rim crescent and a hot spot
  vec3 rf = vec3(2.0 * n.z * n.xy, 2.0 * n.z * n.z - 1.0);
  vec3 env = mix(vec3(0.62, 0.78, 1.0), vec3(1.0, 0.86, 0.95), clamp(rf.y * 0.5 + 0.5, 0.0, 1.0));
  vec2 hp = n.xy - vec2(-0.40, -0.46);
  float ca = cos(-0.45), sa = sin(-0.45);
  hp = vec2(ca * hp.x - sa * hp.y, sa * hp.x + ca * hp.y);
  float win = 1.0 - smoothstep(-0.006, 0.02, sdBox(hp, vec2(0.105, 0.06), 0.035));
  float bars = max(1.0 - smoothstep(0.0, 0.014, abs(hp.x + 0.01)), 1.0 - smoothstep(0.0, 0.012, abs(hp.y + 0.005)));
  win *= 1.0 - bars * 0.85;
  float dot1 = 1.0 - smoothstep(0.018, 0.034, length(n.xy - vec2(-0.13, -0.66)));
  float dir45 = dot(normalize(n.xy + 1e-4), normalize(vec2(0.62, 0.78)));
  float cres = smoothstep(0.86, 0.96, rr) * (1.0 - smoothstep(0.985, 1.0, rr)) * smoothstep(0.35, 0.95, dir45);
  vec3 L = normalize(vec3(-0.45, -0.6, 0.66));
  float spec = pow(max(dot(n, normalize(L + vec3(0.0, 0.0, 1.0))), 0.0), 140.0);

  vec3 col = vec3(0.0); float a = 0.0;
  vec3 bodyTint = mix(vec3(0.7, 0.88, 1.0), uTint, uTintAmt * 0.7);
  float bodyA = 0.06 + 0.06 * (1.0 - cv);
  col += bodyTint * bodyA; a += bodyA;
  float fa = 0.1 + 0.72 * F;
  col += fc * fa * uBright; a += fa * 0.82;
  col += env * F * 0.3; a += F * 0.14;
  float hi = win * 0.9 + dot1 * 0.95 + cres * 0.55 + spec * 0.8;
  col += vec3(hi); a += hi;

  // crisp cartoon outline so she reads on white and on black
  float line = 1.35 * uDpr * px;
  float ring = smoothstep(1.0 - line - 1.2 * px, 1.0 - line, rr);
  vec3 lineC = mix(vec3(0.1, 0.12, 0.3), fc * 0.55, 0.3);
  col = col * (1.0 - ring * 0.82) + lineC * ring * 0.82;
  a = a * (1.0 - ring * 0.82) + ring * 0.82;

  // pop: membrane tears open from one point
  if (uPop > 0.0) {
    float hole = distance(qn, uPopO) + 0.07 * sin(th * 7.0 + t * 12.0);
    float rad = uPop * 2.4;
    float keep = smoothstep(rad - 0.02, rad + 0.05, hole);
    float lip = smoothstep(rad + 0.14, rad + 0.03, hole) * keep * (1.0 - uPop);
    col = col * keep + vec3(1.0) * lip;
    a = a * keep + lip;
  }

  a = clamp(a, 0.0, 1.0);
  col = min(col, vec3(a));
  gl_FragColor = vec4(col * cover, a * cover);
}`;

  class BubbleGL {
    constructor(canvas) {
      const gl = canvas.getContext('webgl', { premultipliedAlpha: true, alpha: true, antialias: false })
        || canvas.getContext('experimental-webgl', { premultipliedAlpha: true, alpha: true });
      if (!gl) throw new Error('no webgl');
      this.gl = gl;
      const sh = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src); gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
        return s;
      };
      const prog = gl.createProgram();
      gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
      gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
      gl.useProgram(prog);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, 'p');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      this.u = {};
      ['uRes', 'uC', 'uR', 'uDir', 'uA', 'uB', 'uT', 'uWob', 'uSat', 'uBright', 'uTint', 'uTintAmt', 'uPop', 'uPopO', 'uDpr', 'uSeed']
        .forEach((n) => { this.u[n] = gl.getUniformLocation(prog, n); });
      gl.clearColor(0, 0, 0, 0);
    }
    render(w, h, s) {
      const gl = this.gl, u = this.u;
      gl.viewport(0, 0, w, h);
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (s.hidden) return;
      gl.uniform2f(u.uRes, w, h);
      gl.uniform2f(u.uC, s.cx, s.cy);
      gl.uniform1f(u.uR, s.r);
      gl.uniform2f(u.uDir, s.dx, s.dy);
      gl.uniform1f(u.uA, s.a);
      gl.uniform1f(u.uB, s.b);
      gl.uniform1f(u.uT, s.t);
      gl.uniform1f(u.uWob, s.wob);
      gl.uniform1f(u.uSat, s.sat);
      gl.uniform1f(u.uBright, s.bright);
      gl.uniform3f(u.uTint, s.tint[0], s.tint[1], s.tint[2]);
      gl.uniform1f(u.uTintAmt, s.tintAmt);
      gl.uniform1f(u.uPop, s.pop);
      gl.uniform2f(u.uPopO, s.popX, s.popY);
      gl.uniform1f(u.uDpr, s.dpr);
      gl.uniform1f(u.uSeed, s.seed);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  }

  // Canvas-2D fallback when WebGL is unavailable: same silhouette, rim, film colours and highlights.
  function drawBubble2D(ctx, s, t) {
    if (s.hidden || !ctx) return;
    const r = s.r;
    ctx.save();
    ctx.translate(s.cx, s.cy);
    ctx.rotate(Math.atan2(s.dy, s.dx));
    ctx.scale(s.a, s.b);
    ctx.rotate(-Math.atan2(s.dy, s.dx));
    // body: faint milky fill so the face reads on any background
    const body = ctx.createRadialGradient(-r * 0.25, -r * 0.3, r * 0.05, 0, 0, r);
    body.addColorStop(0, 'rgba(235,245,255,0.10)');
    body.addColorStop(0.72, 'rgba(210,230,255,0.16)');
    body.addColorStop(1, 'rgba(190,215,255,0.30)');
    ctx.fillStyle = body;
    ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fill();
    // thin-film rim: a rotating rainbow ring
    const sat = Math.round(90 * Math.min(1.3, s.sat));
    const film = ctx.createConicGradient ? ctx.createConicGradient(t * 0.4, 0, 0) : null;
    if (film) {
      for (let i = 0; i <= 6; i++) film.addColorStop(i / 6, `hsla(${(i * 60 + t * 25) % 360},${sat}%,72%,0.85)`);
      ctx.strokeStyle = film;
    } else ctx.strokeStyle = `hsla(${(t * 40) % 360},${sat}%,72%,0.85)`;
    ctx.lineWidth = r * 0.16;
    ctx.globalAlpha = 0.75;
    ctx.beginPath(); ctx.arc(0, 0, r * 0.9, 0, TAU); ctx.stroke();
    ctx.globalAlpha = 1;
    // crisp outline
    ctx.strokeStyle = 'rgba(26,29,74,0.85)';
    ctx.lineWidth = Math.max(1.2, r * 0.035);
    ctx.beginPath(); ctx.arc(0, 0, r - ctx.lineWidth / 2, 0, TAU); ctx.stroke();
    // window highlight + hot spot
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.save(); ctx.translate(-r * 0.4, -r * 0.46); ctx.rotate(-0.45);
    ctx.beginPath(); ctx.ellipse(0, 0, r * 0.13, r * 0.075, 0, 0, TAU); ctx.fill();
    ctx.restore();
    ctx.beginPath(); ctx.arc(-r * 0.13, -r * 0.66, r * 0.03, 0, TAU); ctx.fill();
    ctx.restore();
  }

  // ───────────────────────────── styles ─────────────────────────────
  const CSS = `
.mb-layer{position:absolute;inset:0;overflow:hidden;pointer-events:none;contain:strict;z-index:2147483000}
.mb-fx{position:absolute;left:0;top:0}
.mb-char{position:absolute;left:0;top:0;will-change:transform}
.mb-char canvas{position:absolute;display:block}
.mb-hit{position:absolute;border-radius:50%;pointer-events:auto;cursor:grab;touch-action:none;-webkit-tap-highlight-color:transparent}
.mb-hit:active{cursor:grabbing}
.mb-hit:focus-visible{outline:2px solid #8f7bff;outline-offset:4px}
.mb-say{position:absolute;left:0;top:0;max-width:min(320px,70vw);padding:10px 14px 11px;border-radius:18px;
  background:#fff;color:${INK};font:600 15px/1.55 var(--mb-font,system-ui,-apple-system,"Segoe UI",Tahoma,sans-serif);
  box-shadow:0 10px 30px -8px rgba(20,24,70,.35),0 0 0 1.5px rgba(26,29,74,.9);pointer-events:auto;
  transform-origin:50% 100%;transition:opacity .18s ease,transform .22s cubic-bezier(.2,1.4,.4,1);will-change:transform}
.mb-say.off{opacity:0;transform:scale(.6);pointer-events:none}
.mb-say .mb-line{white-space:pre-line}
.mb-say::after{content:"";position:absolute;left:var(--tail,50%);bottom:-8px;width:14px;height:14px;background:#fff;
  transform:translateX(-50%) rotate(45deg);box-shadow:1.5px 1.5px 0 0 rgba(26,29,74,.9);border-radius:0 0 3px 0}
.mb-say.below{transform-origin:50% 0}
.mb-say.below::after{bottom:auto;top:-8px;box-shadow:-1.5px -1.5px 0 0 rgba(26,29,74,.9);border-radius:3px 0 0 0}
.mb-say .mb-btns{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}
.mb-say button{font:inherit;font-size:13px;border:1.5px solid ${INK};border-radius:99px;padding:3px 12px;background:#fff;color:${INK};cursor:pointer}
.mb-say button.primary{background:${INK};color:#fff}
.mb-say button:focus-visible{outline:2px solid ${PINK};outline-offset:2px}
/* a line about work in progress ("looking for app.js…"): lighter than her speech, with a small spinner */
.mb-say.busy{background:#f7f4ff;font-size:14px;padding:7px 13px 8px;box-shadow:0 8px 22px -10px rgba(20,24,70,.3),0 0 0 1.5px rgba(143,123,255,.55)}
.mb-say.busy::after{background:#f7f4ff;box-shadow:1.5px 1.5px 0 0 rgba(143,123,255,.55)}
.mb-say.busy.below::after{box-shadow:-1.5px -1.5px 0 0 rgba(143,123,255,.55)}
.mb-say.busy .mb-line::before{content:"";display:inline-block;width:11px;height:11px;margin-inline-end:8px;vertical-align:-1px;
  border-radius:50%;border:2px solid rgba(143,123,255,.35);border-top-color:${PINK};animation:mb-spin .8s linear infinite}
@keyframes mb-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.mb-say.busy .mb-line::before{animation:none}}
`;

  // ───────────────────────────── the character ─────────────────────────────
  class MissBlupsy {
    constructor(container, options = {}) {
      this.opt = Object.assign({
        size: 46,                 // bubble radius in CSS px
        theme: 'rainbow',         // rainbow | pink | ocean | gold | mint
        look: 'girl',             // girl (bow + lashes) | boy (cap) | neutral
        fast: false,              // speed mode: shortest flights, no idle chatter
        boredAfter: 30,           // seconds of no activity before she gets bored (0 = never)
        sleepAfter: 75,           // seconds before she falls asleep (0 = never)
        font: null,
        lines: {},
        onInteractive: null,      // (bool) — pointer entered / left an interactive part
        onPoke: null,
        onDoubleTap: null,        // two quick taps on her (e.g. open a box to type to her)
        onTap: null,              // one tap (a second may follow: e.g. get that box ready)
        onMenu: null,             // right click on her (e.g. her menu)
        sound: null,              // a BlupsySound instance (see sound.js), or null for silence
      }, options);
      this.lines = Object.assign({
        poke: ['هيه! 😆', 'تدغدغني! 🫧', 'هلا والله! وش نسوي؟', 'بُب!'],
        angry: 'لا تفقعني! 😤',
        forgive: '…طيب خلاص سامحتك 🫧',
        wake: 'هاه!! ما نمت، كنت أفكر 😳',
        bored: ['طفشت… ما عندك شي نسويه؟ 🥱', 'ترى أعرف أرتّب ملفاتك، بس أقول 👀', 'بسوي فقاعات لين تتذكرني 🫧'],
        thrown: ['ويييي! 🎢', 'مرة ثانية! 😆', 'دختت… 😵‍💫'],
      }, this.opt.lines);

      this.container = container;
      if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
      if (!document.getElementById('mb-css')) {
        const st = document.createElement('style');
        st.id = 'mb-css'; st.textContent = CSS;
        document.head.appendChild(st);
      }
      this.reduced = !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches);

      this.layer = el('div', 'mb-layer');
      if (this.opt.font) this.layer.style.setProperty('--mb-font', this.opt.font);
      this.fxCanvas = el('canvas', 'mb-fx');
      this.box = el('div', 'mb-char');
      this.cBack = el('canvas');
      this.cGL = el('canvas');
      this.cFront = el('canvas');
      this.hit = el('div', 'mb-hit');
      this.hit.tabIndex = 0;
      this.hit.setAttribute('role', 'button');
      this.hit.setAttribute('aria-label', 'Miss Blupsy');
      this.sayEl = el('div', 'mb-say off');
      this.sayEl.setAttribute('role', 'status');
      this.sayEl.setAttribute('aria-live', 'polite');
      this.sayText = el('div', 'mb-line');
      this.sayText.dir = 'auto';
      this.sayEl.appendChild(this.sayText);
      this.box.append(this.cBack, this.cGL, this.cFront, this.hit);
      this.layer.append(this.box, this.fxCanvas, this.sayEl);
      container.appendChild(this.layer);

      this.bctx = this.cBack.getContext('2d');
      this.fctx = this.cFront.getContext('2d');
      this.xctx = this.fxCanvas.getContext('2d');
      try { this.bubble = new BubbleGL(this.cGL); } catch (e) { this._fallback2D(); }
      this.cGL.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this._fallback2D(); });

      // state
      this.t = 0;
      this.seed = Math.random() * 100;
      this.pos = { x: 0, y: 0 };
      this.disp = { x: 0, y: 0 };
      this.vel = { x: 0, y: 0 };
      this.anchor = { x: 0, y: 0 };
      this.mode = 'hidden';            // hidden | hover | fly | drag | throw
      this.flight = null;
      this.dir = { x: 0, y: -1 };
      this.stretch = 0;
      this.squash = new Spring(260, 11);
      this.appear = new Spring(210, 15, 0);
      this.appearTarget = 0;
      this.pop = 0;
      this.popO = { x: 0.5, y: -0.5 };
      this.wobAmp = 0;
      this.face = Object.assign({}, FACE0);
      this.body = Object.assign({}, BODY0);
      this.tint = THEMES[this.opt.theme] ? THEMES[this.opt.theme].tint.slice() : THEMES.rainbow.tint.slice();
      this.moodName = 'idle';
      this.mood = MOODS.idle;
      this.look = { x: 0, y: 0 };
      this.cursor = null;
      this.lookPoint = null;
      this.saccade = { x: 0, y: 0, until: 0 };
      this.blink = { next: rand(1.5, 4), t: -1, double: false };
      this.talk = null;
      this.talkOpen = 0;
      this.hands = [new Spring2(210, 20), new Spring2(210, 20)];
      this.feet = [new Spring2(80, 8.5), new Spring2(80, 8.5)];
      this.handInfo = [{}, {}];
      this.fingers = [cloneHand(HANDS.open), cloneHand(HANDS.open)];
      this.bow = new Spring(90, 6);
      this.bowPrev = 0;
      this.pointTarget = null;
      this.armOverride = null;
      this.fx = [];
      this.fxBox = null;
      this.lastActive = performance.now();
      this.idleStage = 0;
      this.busy = 0;
      this.pokes = [];
      this.nextIdleAct = 6;
      this.hover = false;
      this.dragInfo = null;
      this._sayToken = 0;
      this._sayResolve = null;   // settles the line now in the bubble (see say)
      this._running = true;
      this._last = performance.now();

      this._bindInput();
      this.setSize(this.opt.size);
      this._resize();
      if (root.ResizeObserver) {
        this._ro = new ResizeObserver(() => this._resize());
        this._ro.observe(container);
      } else {
        root.addEventListener('resize', () => this._resize());
      }
      this._frame = this._frame.bind(this);
      this._schedule(0);
    }

    // ───────────── public API ─────────────

    /** Rise into view from the bottom edge and say hello. */
    async enter(x, y, greeting) {
      const W = this.W, H = this.H, R = this.R;
      const tx = x != null ? x : W - R * 3.2;
      const ty = y != null ? y : H - R * 3.6;
      this._place(tx, H + R * 3);
      this.mode = 'hover';
      this.appearTarget = 1;
      this.appear.set(1);
      this._sfx('hello');
      await this.flyTo(tx, ty, { style: 'soft', duration: 1.1, trail: true });
      this.wave(1400);
      if (greeting) await this.say(greeting);
    }

    /** Pop out of existence. */
    async hide() {
      this._sfx('bye');
      await this._popOut();
      this.mode = 'hidden';
    }

    /** Reappear with a little "blup" at (x, y), or where she was. */
    async show(x, y) {
      await this._popIn(x != null ? x : this.pos.x, y != null ? y : this.pos.y);
    }

    setMood(name, holdMs) {
      if (!MOODS[name]) return;
      const prev = this.moodName;
      this.moodName = name;
      this._sfx('mood', { name, prev });
      this.mood = MOODS[name];
      if (this.mood.tint) this.moodTint = this.mood.tint; else this.moodTint = null;
      clearTimeout(this._moodTimer);
      if (holdMs) this._moodTimer = setTimeout(() => { if (this.moodName === name) this.setMood('idle'); }, holdMs);
      if (name !== 'bored' && name !== 'sleeping') this._touch(false);
    }

    setTheme(name) {
      if (!THEMES[name]) return;
      this.opt.theme = name;
    }
    setLook(look) { this.opt.look = look; }
    setFast(on) { this.opt.fast = !!on; }

    setSize(r) {
      const R = typeof r === 'string' ? ({ s: 34, m: 46, l: 60 }[r] || 46) : r;
      this.R = R;
      this.S = Math.ceil(R * 7.2);
      this.G = Math.ceil(R * 3.2);
      this._sizeCanvases();
    }

    /** Feed the global cursor position (container coords) so her eyes follow it. */
    setCursor(x, y) { this.cursor = x == null ? null : { x, y }; }

    /** Look at a point for a while (or null to go back to the cursor). */
    lookAt(x, y) { this.lookPoint = x == null ? null : { x, y }; }

    /**
     * Fly to (x, y). style: 'soft' (floaty) | 'cartoon' (snappy with anticipation).
     * In fast mode every flight is capped at ~0.35 s and long trips become a pop-teleport.
     */
    flyTo(x, y, o = {}) {
      this._touch();
      const R = this.R;
      x = clamp(x, R * 1.4, this.W - R * 1.4);
      y = clamp(y, R * 1.9, this.H - R * 1.8);
      const from = { x: this.pos.x, y: this.pos.y };
      const dist = len(x - from.x, y - from.y);
      if (this.mode === 'hidden') { this._place(x, y); return this._popIn(x, y); }
      if (dist < 2) return Promise.resolve();
      const style = o.style || (this.mood.flight) || (this.moodName === 'happy' || this.moodName === 'angry' ? 'cartoon' : 'soft');
      const fast = o.fast != null ? o.fast : this.opt.fast;
      if (this.reduced || (fast && dist > Math.max(this.W, this.H) * 0.55) || o.teleport) {
        return this._teleport(x, y);
      }
      let dur;
      if (o.duration) dur = o.duration;
      else if (fast) dur = Math.min(0.35, 0.14 + dist / 3200);
      else if (style === 'cartoon') dur = Math.min(0.75, 0.26 + dist / 1700);
      else dur = Math.min(1.8, 0.55 + dist / 850);
      // arc: bow the path upward a little, more for longer trips
      const mx = (from.x + x) / 2, my = (from.y + y) / 2;
      const nx = -(y - from.y) / (dist || 1), ny = (x - from.x) / (dist || 1);
      const bend = Math.min(dist * 0.18, R * 2.5) * (ny < 0 ? 1 : -1) * (style === 'soft' ? 1 : 0.6);
      const ctrl = { x: mx + nx * bend, y: my + ny * bend };
      if (this.flight && this.flight.resolve) this.flight.resolve();
      return new Promise((resolve) => {
        this.flight = {
          from, to: { x, y }, ctrl, t: 0, dur, style,
          antic: style === 'cartoon' && !fast ? 0.09 : 0,
          trail: o.trail != null ? o.trail : dist > R * 3,
          resolve,
        };
        this.mode = 'fly';
        this._sfx('fly', { dist, dur, style });
      });
    }

    /** Pop here, reappear there. */
    async _teleport(x, y) {
      await this._popOut();
      await this._popIn(x, y);
    }

    /** Say something in her speech bubble. Resolves after it has been read (or when a button is chosen). */
    say(text, o = {}) {
      this._touch();
      // the line before is answered "nothing" when this one takes the bubble (its buttons or its wait end here)
      this._settleSay(null);
      const token = ++this._sayToken;
      const el0 = this.sayEl;
      const buttons = o.buttons || null;
      this.sayText.textContent = '';
      const old = el0.querySelector('.mb-btns');
      if (old) old.remove();
      el0.classList.remove('off', 'busy');
      const chars = Array.from(text);
      const mood = this.moodName;
      const snd = this.opt.sound;
      const voiceMode = snd && snd.opt ? snd.opt.voice : 'off';
      let handle = null;
      // silent: words in the bubble only (while she listens, her own voice must not reach the microphone)
      if (snd && !o.silent) { try { handle = snd.speakLine(text, mood); } catch (e) { handle = null; } }
      const babble = !!snd && !o.silent && voiceMode === 'babble';
      // the mouth follows the real loudness for neural audio and babble, a letter pattern otherwise
      this.talk = { pattern: lipPattern(text), t: 0, rate: o.rate || 30, babble, voiced: !!handle, handle };
      let perChar = this.reduced ? 0 : 1000 / (o.rate || 30);
      // without a voice to keep in step with, a long line still shows whole in about a second
      if (!handle) perChar = Math.min(perChar, 1100 / Math.max(1, chars.length));
      return new Promise((settle) => {
        // every way this line ends goes through here, so a new line, hush() or status() never leaves it hanging
        const resolve = (v) => { if (this._sayResolve === resolve) this._sayResolve = null; settle(v); };
        this._sayResolve = resolve;
        let i = 0;
        const reveal = (n) => {
          i = Math.max(i, Math.min(chars.length, n));
          this.sayText.textContent = chars.slice(0, i).join('');
          this._placeSay();
        };
        if (handle) {
          // keep the words in the bubble in step with the voice
          handle.onBoundary = (ci) => {
            if (token !== this._sayToken) return;
            reveal(Math.round((ci / Math.max(1, handle.cleanLength)) * chars.length));
          };
          handle.started.then((dur) => {
            if (dur && token === this._sayToken && !this.reduced) perChar = Math.max(10, (dur * 1000 * 0.9) / Math.max(1, chars.length - i));
          });
        }
        const finish = () => {
          const endTalk = () => { if (token === this._sayToken) this.talk = null; };
          if (handle) handle.done.then(endTalk); else endTalk();
          if (!handle && /(بُب|\bBub\b|Бульк|啵|ぷくっ|뽁)/.test(text)) this._sfx('bub');
          if (buttons) {
            this._sfx('ask');
            const row = el('div', 'mb-btns');
            buttons.forEach((b, k) => {
              const btn = el('button', k === 0 ? 'primary' : '');
              btn.type = 'button';
              btn.textContent = b;
              btn.addEventListener('click', () => { if (token !== this._sayToken) return; resolve(b); this.hush(); });
              row.appendChild(btn);
            });
            el0.appendChild(row);
            this._placeSay();
            this._setInteractive(true);
            return;
          }
          const hold = o.hold != null ? o.hold : clamp(chars.length * 55, 1200, 5000);
          const after = () => {
            this._sayTimer = setTimeout(() => {
              if (token !== this._sayToken) return resolve(null);
              // answered first: hush() would otherwise settle it as cut short
              resolve(true);
              if (!o.keep) this.hush();
            // spoken words were heard: a short pause after. Babble says no words, and o.read asks for time to read it
            }, handle && !babble && !o.read ? Math.min(hold, 900) : hold);
          };
          // with a voice, wait for her to finish speaking (never more than 30 s)
          if (handle) Promise.race([handle.done, wait(30000)]).then(() => { if (token === this._sayToken) after(); else resolve(null); });
          else after();
        };
        const typeNext = () => {
          if (token !== this._sayToken) return resolve(null);
          if (i < chars.length) {
            if (babble) { try { snd.talk(chars[i], mood); } catch (e) { /* ignore */ } }
            reveal(i + 1);
            this._sayTimer = setTimeout(typeNext, perChar);
            return;
          }
          finish();
        };
        // a neural voice needs a moment to arrive: start typing when it starts playing
        if (handle && handle.kind === 'natural') Promise.race([handle.started, wait(2500)]).then(() => { if (token === this._sayToken) typeNext(); else resolve(null); });
        else typeNext();
      });
    }

    /** Ask with buttons; resolves with the chosen label. */
    ask(text, buttons, o = {}) { return this.say(text, { ...o, buttons }); }

    /**
     * A line that changes in place, without typing or speaking it: how far something has got
     * ("46% · 112 MB/s"). It stays until she says something else or is hushed.
     */
    status(text, o = {}) {
      this._touch();
      // busy: work under way (a spinner and a lighter look); plain: a figure such as a percentage
      this.sayEl.classList.toggle('busy', !!o.busy);
      this._settleSay(null);
      this._sayToken++;
      clearTimeout(this._sayTimer);
      const old = this.sayEl.querySelector('.mb-btns');
      if (old) old.remove();
      this.sayText.textContent = String(text || '');
      this.sayEl.classList.remove('off');
      this._placeSay();
    }

    hush() {
      this._settleSay(null);
      if (this.opt.sound) { try { this.opt.sound.stopSpeech(); } catch (e) { /* ignore */ } }
      this._sayToken++;
      clearTimeout(this._sayTimer);
      this.talk = null;
      this.sayEl.classList.add('off');
      this._setInteractive(this.hover);
    }

    /** End the line in the bubble now: whoever waits on it hears v (null: it was cut short). */
    _settleSay(v) {
      const r = this._sayResolve;
      this._sayResolve = null;
      if (r) r(v);
    }

    wave(ms = 1500) { return this._armsFor(['float', 'wave'], ms); }
    thumbsUp(ms = 1500) { this._sfx('done'); return this._armsFor(['float', 'thumbsup'], ms); }
    peace(ms = 1500) { return this._armsFor(['float', 'peace'], ms); }
    clap(ms = 1200) { this._sfx('clapping', { ms }); return this._armsFor(['clap', 'clap'], ms); }
    stretchYawn(ms = 1600) { return this._armsFor(['stretch', 'stretch'], ms); }

    /** Fly next to (x, y) and point at it with her glove. */
    async pointAt(x, y, o = {}) {
      this._touch();
      const R = this.R;
      // o.from: 'left' = stand left of the target and point right, 'right' = the opposite
      const side = o.from === 'left' ? 1 : o.from === 'right' ? -1 : (x >= this.pos.x ? 1 : -1);
      // o.at: where she stands (else beside the target)
      const bx = o.at ? o.at.x : clamp(x - side * R * (o.reach || 2.15), R * 1.4, this.W - R * 1.4);
      const by = o.at ? o.at.y : clamp(y + R * 0.35, R * 1.9, this.H - R * 1.8);
      if (len(bx - this.pos.x, by - this.pos.y) > R * 0.4) await this.flyTo(bx, by, { style: 'cartoon', fast: o.fast });
      const s2 = x >= this.pos.x ? 1 : -1;
      this.pointTarget = { x, y, side: s2 };
      this.lookPoint = { x, y };
      this._emit('target', x, y, { max: (o.hold || 1800) / 1000 + 0.4 });
      if (o.say) await this.say(o.say, { hold: o.hold, silent: o.silent });
      else await wait(o.hold || 1800);
      if (!o.keep) this.release();
    }

    /**
     * Point at a box on the page ({x, y, w, h}) without covering it: from beside it when there is room
     * for her there, otherwise from below it (or above, near the bottom of the screen). Her words keep
     * off the box too. o.arrow: end her words with a hand pointing the way she points (👉 👈 👆 👇).
     */
    async pointAtBox(rect, o = {}) {
      const R = this.R, W = this.W, H = this.H;
      const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
      // beside it: at arm's length, or a little closer when that is all the room there is
      const fit = (room) => [2.15, 1.85, 1.6].find((k) => room - 6 - R * k >= R * 1.4) || 0;
      const kL = fit(rect.x), kR = fit(W - rect.x - rect.w);
      const roomL = kL > 0, roomR = kR > 0;
      const pref = o.from || (this.pos.x < cx ? 'left' : 'right');
      this._avoid = rect;
      const say = (h) => (o.arrow && o.say ? { ...o, say: o.say + ' ' + h } : o);
      try {
        if (roomL && (pref === 'left' || !roomR)) return await this.pointAt(rect.x - 6, cy, { ...say('👉'), from: 'left', reach: kL });
        if (roomR) return await this.pointAt(rect.x + rect.w + 6, cy, { ...say('👈'), from: 'right', reach: kR });
        // no room beside it: stand under (or over) its near end and point at its edge
        const left = pref === 'left';
        const tx = clamp(left ? rect.x + Math.min(rect.w * 0.2, R * 1.5) : rect.x + rect.w - Math.min(rect.w * 0.2, R * 1.5), R, W - R);
        const under = rect.y + rect.h + R * 2.3 <= H - R * 1.8;
        const ty = under ? rect.y + rect.h + 4 : rect.y - 4;
        const at = { x: clamp(tx + (left ? -1 : 1) * R * 0.9, R * 1.4, W - R * 1.4), y: under ? rect.y + rect.h + R * 2.1 : rect.y - R * 2.1 };
        return await this.pointAt(tx, ty, { ...say(under ? '👆' : '👇'), at });
      } finally { this._avoid = null; }
    }

    /** Show that she hears sound (level 0…1): little waves by her ear and a tiny bounce. */
    hear(level) {
      if (!(level > 0.04) || this.mode === 'hidden') return;
      const now = performance.now();
      if (now - (this._hearT || 0) < 110) return;
      this._hearT = now;
      const p = this._bodyToWorld(1.1, -0.25);
      this._emit('wave', p.x, p.y, { max: 0.45 + Math.min(1, level) * 0.5 });
      this.squash.v -= Math.min(1, level) * 0.5;
      this._touch();
    }

    /** Override both arm poses, e.g. ['carry','carry']; null returns to the mood's arms. */
    setArms(poses) { clearTimeout(this._armTimer); this.armOverride = poses; }

    /** World position of a glove (side -1 = left, 1 = right). */
    handPosition(side = 1) { const h = this.hands[side < 0 ? 0 : 1]; return { x: h.x, y: h.y }; }

    /** Stop pointing. */
    release() { this.pointTarget = null; this.lookPoint = null; }

    /** Reach over and tap a point (ripple + squish). */
    async tap(x, y) {
      this._touch();
      const R = this.R;
      const side = x >= this.pos.x ? 1 : -1;
      const bx = x - side * R * 1.95, by = y + R * 0.3;
      if (len(bx - this.pos.x, by - this.pos.y) > R * 0.4) await this.flyTo(bx, by, { style: 'cartoon', fast: true });
      this.pointTarget = { x, y, side: x >= this.pos.x ? 1 : -1, tap: true };
      this.lookPoint = { x, y };
      await wait(120);
      this._emit('ripple', x, y, { max: 0.55 });
      this._sfx('tap');
      this.squash.v -= 1.2;
      await wait(200);
      this.release();
    }

    /** Circle a mistake with a hand-drawn red loop; optionally explain it. */
    async markMistake(rect, text, o = {}) {
      this._touch();
      const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
      this.setMood('working');
      // point at the near edge of the box from outside, so her body never covers the circle
      const fromLeft = this.pos.x < cx ? rect.x - 30 > this.R * 3 : rect.x + rect.w + 30 > this.W - this.R * 3;
      const tx = fromLeft ? rect.x - 30 : rect.x + rect.w + 30;
      await this.pointAt(tx, cy, { keep: true, hold: 300, from: fromLeft ? 'left' : 'right' });
      this._sfx('scribble', { dur: 0.6 });
      this._emit('scribble', cx, cy, { max: 30, data: { w: rect.w, h: rect.h, seed: Math.random() * 10 } });
      if (text) await this.say(text, { hold: 2600, silent: o.silent });
      else await wait(1500);
      this.release();
      this.setMood('idle');
    }

    /** Play one of her sounds by name (hosts use it for 'remind', 'grab', 'drop', 'done'…). */
    sfx(name, data) { this._sfx(name, data); }

    /** Swap or remove the sound engine at runtime. */
    setSound(sound) { if (this.opt.sound) this.opt.sound.stopSpeech(); this.opt.sound = sound || null; }

    _sfx(name, data) {
      const snd = this.opt.sound;
      if (!snd) return;
      try { snd.play(name, data || {}); } catch (e) { /* sound must never break her */ }
    }

    /** Remove any red mistake circles still on screen. */
    clearMarks() { this.fx = this.fx.filter((p) => p.type !== 'scribble'); }

    /** Blow a little bubble that floats up and pops. */
    blowBubble() {
      this._sfx('blup', { size: 0.55 });
      const m = this._mouthWorld();
      this._emit('mini', m.x, m.y, { vx: rand(-15, 15), vy: -35, r: this.R * rand(0.14, 0.22), max: rand(2.2, 3.2), popAtEnd: true });
    }

    /** Start / stop the frame loop (e.g. when the overlay is hidden). */
    pause() { this._running = false; }
    resume() { if (!this._running) { this._running = true; this._last = performance.now(); this._schedule(0); } }

    destroy() {
      this._running = false;
      if (this._ro) this._ro.disconnect();
      this.layer.remove();
    }

    get position() { return { x: this.pos.x, y: this.pos.y }; }
    get isBusy() { return this.mode === 'fly' || !!this.talk; }

    /** Swap the WebGL canvas for a plain 2D one (no GPU, blocked WebGL, or a lost context). */
    _fallback2D() {
      this.bubble = null;
      const c = el('canvas');
      c.style.cssText = this.cGL.style.cssText;
      c.width = this.cGL.width; c.height = this.cGL.height;
      this.cGL.replaceWith(c);
      this.cGL = c;
      this.gctx = c.getContext('2d');
    }

    // ───────────── internals: layout ─────────────

    _resize() {
      const r = this.container.getBoundingClientRect();
      this.W = Math.max(1, r.width);
      this.H = Math.max(1, r.height);
      this.dpr = Math.min(root.devicePixelRatio || 1, 3);
      this.fxCanvas.width = Math.round(this.W * this.dpr);
      this.fxCanvas.height = Math.round(this.H * this.dpr);
      this.fxCanvas.style.width = this.W + 'px';
      this.fxCanvas.style.height = this.H + 'px';
      this.fxBox = null;
      this._sizeCanvases();
      if (this.mode !== 'hidden') {
        const R = this.R;
        this.anchor.x = clamp(this.anchor.x, R * 1.4, this.W - R * 1.4);
        this.anchor.y = clamp(this.anchor.y, R * 1.9, this.H - R * 1.8);
      }
    }

    _sizeCanvases() {
      if (!this.dpr) return;
      const S = this.S, G = this.G, d = this.dpr;
      for (const c of [this.cBack, this.cFront]) {
        c.width = Math.round(S * d); c.height = Math.round(S * d);
        c.style.width = S + 'px'; c.style.height = S + 'px';
        c.style.left = '0px'; c.style.top = '0px';
      }
      this.cGL.width = Math.round(G * d); this.cGL.height = Math.round(G * d);
      this.cGL.style.width = G + 'px'; this.cGL.style.height = G + 'px';
      this.cGL.style.left = (S - G) / 2 + 'px'; this.cGL.style.top = (S - G) / 2 + 'px';
      this.box.style.width = S + 'px'; this.box.style.height = S + 'px';
      const hs = this.R * 2.3;
      Object.assign(this.hit.style, { width: hs + 'px', height: hs + 'px', left: (S - hs) / 2 + 'px', top: (S - hs) / 2 + 'px' });
    }

    _place(x, y) {
      this.pos.x = this.anchor.x = x;
      this.pos.y = this.anchor.y = y;
      this.disp.x = x; this.disp.y = y;
      this.vel.x = this.vel.y = 0;
      const R = this.R;
      for (let i = 0; i < 2; i++) {
        const s = i === 0 ? -1 : 1;
        this.hands[i].set(x + s * R * 1.2, y + R * 0.35);
        this.feet[i].set(x + s * R * 0.34, y + R * 1.6);
      }
    }

    // ───────────── internals: input ─────────────

    _bindInput() {
      const hit = this.hit;
      hit.addEventListener('pointerenter', () => { this.hover = true; this._wake(); this._setInteractive(true); });
      hit.addEventListener('pointerleave', () => { this.hover = false; if (!this.dragInfo) this._setInteractive(this._sayHasButtons()); });
      this.sayEl.addEventListener('pointerenter', () => this._setInteractive(true));
      this.sayEl.addEventListener('pointerleave', () => this._setInteractive(this.hover || this._sayHasButtons()));
      hit.addEventListener('pointerdown', (e) => {
        // only the main button taps and drags her; the right one opens her menu (contextmenu below)
        if (e.button !== 0) return;
        e.preventDefault();
        hit.setPointerCapture && hit.setPointerCapture(e.pointerId);
        this.dragInfo = { id: e.pointerId, sx: e.clientX, sy: e.clientY, moved: false, samples: [], ox: 0, oy: 0 };
        this._wake();
        const r = this.container.getBoundingClientRect();
        this.dragInfo.ox = this.pos.x - (e.clientX - r.left);
        this.dragInfo.oy = this.pos.y - (e.clientY - r.top);
      });
      hit.addEventListener('pointermove', (e) => {
        const d = this.dragInfo;
        if (!d || d.id !== e.pointerId) return;
        if (!d.moved && len(e.clientX - d.sx, e.clientY - d.sy) > 5) {
          d.moved = true;
          this.mode = 'drag';
          if (this.flight) { this.flight.resolve(); this.flight = null; }
          this._wakeIfNeeded(true);
          this.setMood('surprised');
        }
        if (d.moved) {
          const r = this.container.getBoundingClientRect();
          const x = e.clientX - r.left + d.ox, y = e.clientY - r.top + d.oy;
          d.samples.push({ x, y, t: performance.now() });
          if (d.samples.length > 6) d.samples.shift();
          this.pos.x = x; this.pos.y = y;
        }
      });
      const end = (e) => {
        const d = this.dragInfo;
        if (!d || d.id !== e.pointerId) return;
        this.dragInfo = null;
        if (!d.moved) {
          // two quick taps: the host may open a box to type to her
          const now = performance.now();
          if (this.opt.onDoubleTap && now - (this._lastTap || 0) < 380) { this._lastTap = 0; this.opt.onDoubleTap(); return; }
          this._lastTap = now;
          if (this.opt.onTap) this.opt.onTap();
          this._poke();
          return;
        }
        const s = d.samples;
        let vx = 0, vy = 0;
        if (s.length >= 2) {
          const a = s[0], b = s[s.length - 1];
          const dt = Math.max(16, b.t - a.t) / 1000;
          vx = (b.x - a.x) / dt; vy = (b.y - a.y) / dt;
        }
        const sp = len(vx, vy);
        if (sp > 350) {
          const k = Math.min(1, 3200 / sp);
          this.vel.x = vx * k; this.vel.y = vy * k;
          this.mode = 'throw';
          this.setMood('happy');
          this._thrownSaid = false;
        } else {
          this.anchor.x = this.pos.x; this.anchor.y = this.pos.y;
          this.mode = 'hover';
          this.setMood('idle');
        }
        if (!this.hover) this._setInteractive(false);
      };
      hit.addEventListener('pointerup', end);
      hit.addEventListener('pointercancel', end);
      // the right button (or a long press's menu): the host may show her menu right there
      hit.addEventListener('contextmenu', (e) => { e.preventDefault(); if (this.opt.onMenu) this.opt.onMenu(); });
      hit.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this._poke(); }
      });
    }

    _sayHasButtons() { return !this.sayEl.classList.contains('off') && !!this.sayEl.querySelector('.mb-btns'); }

    _setInteractive(on) {
      if (this._interactive === on) return;
      this._interactive = on;
      if (this.opt.onInteractive) this.opt.onInteractive(on);
    }

    _poke() {
      const now = performance.now();
      if (this._wakeIfNeeded(true)) return;
      this.pokes = this.pokes.filter((t) => now - t < 2500);
      this.pokes.push(now);
      this.squash.v -= 2.2;
      this.wobAmp += 0.04;
      if (this.opt.onPoke) this.opt.onPoke();
      if (this.pokes.length >= 4) {
        this.pokes = [];
        this.setMood('angry');
        this.say(this.lines.angry, { hold: 1600 }).then(() => {
          if (this.moodName !== 'angry') return;
          this.setMood('happy', 1400);
          this.say(this.lines.forgive, { hold: 1200 });
        });
        return;
      }
      this.setMood('happy', 1500);
      this._sfx('giggle');
      for (let i = 0; i < 5; i++) this._emit('spark', this.disp.x + rand(-1.3, 1.3) * this.R, this.disp.y + rand(-1.3, 0.6) * this.R, { max: rand(0.5, 0.9) });
      this.say(pick(this.lines.poke), { hold: 1100 });
    }

    /** Wake from sleep/boredom; returns true if she was asleep. */
    _wakeIfNeeded(startle) {
      const was = this.moodName;
      this._touch();
      if (was === 'sleeping') {
        if (startle) {
          this.setMood('surprised', 900);
          this.squash.v += 2.5;
          this.say(this.lines.wake, { hold: 1300 });
        } else this.setMood('idle');
        return true;
      }
      if (was === 'bored') this.setMood('idle');
      return false;
    }

    _touch(wake = true) {
      this.lastActive = performance.now();
      this.idleStage = 0;
      this._wake();
      if (wake && (this.moodName === 'bored' || this.moodName === 'sleeping') && !this._inIdleChange) {
        this.moodName = 'idle'; this.mood = MOODS.idle; this.moodTint = null;
      }
    }

    // ───────────── internals: pop / appear ─────────────

    _popOut() {
      return new Promise((resolve) => {
        const a = rand(0, TAU);
        this.popO = { x: Math.cos(a) * 0.7, y: Math.sin(a) * 0.7 };
        const start = performance.now();
        const R = this.R, cx = this.disp.x, cy = this.disp.y;
        const tick = () => {
          const u = Math.min(1, (performance.now() - start) / 170);
          this.pop = u;
          if (u < 1) return requestAnimationFrame(tick);
          for (let i = 0; i < 16; i++) {
            const ang = rand(0, TAU), sp = rand(120, 380);
            this._emit('drop', cx + Math.cos(ang) * R * 0.9, cy + Math.sin(ang) * R * 0.9, { vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp - 80, r: rand(1.5, 3.5), max: rand(0.35, 0.6) });
          }
          this._emit('pop', cx, cy, { max: 0.3 });
          this._sfx('pop');
          this.appear.set(0); this.appearTarget = 0;
          this.pop = 0;
          this.mode = 'hidden';
          if (this.flight) { this.flight.resolve(); this.flight = null; }
          resolve();
        };
        tick();
      });
    }

    _popIn(x, y) {
      this._place(x, y);
      this.mode = 'hover';
      this.appear.set(0);
      this.appear.v = 9;
      this.appearTarget = 1;
      this.wobAmp += 0.05;
      this._sfx('blup', { size: 1.2 });
      this._emit('ring', x, y, { max: 0.45 });
      for (let i = 0; i < 6; i++) this._emit('mini', x + rand(-1, 1) * this.R, y + rand(-1, 1) * this.R, { vy: -20, r: this.R * rand(0.06, 0.12), max: rand(0.5, 0.9) });
      return wait(260);
    }

    _armsFor(poses, ms) {
      this.armOverride = poses;
      clearTimeout(this._armTimer);
      return new Promise((r) => { this._armTimer = setTimeout(() => { this.armOverride = null; r(); }, ms); });
    }

    // ───────────── internals: frame loop ─────────────

    /**
     * How often to draw right now, in seconds. She lives on screen all day, so frames are spent only where
     * they show: full smoothness (capped at 60 fps, also on 120/144 Hz screens) while she moves, talks, is
     * touched or plays an effect; 30 fps for her slow float; 20 fps bored (she barely moves); 15 fps
     * asleep; almost nothing when hidden.
     */
    _frameInterval(now) {
      if (this.mode === 'hidden' && !this.fx.length && !(this._S > 0.01)) return 0.25;
      if (this.mode !== 'hover' || this.talk || this.dragInfo || this.hover || this.pointTarget || this.armOverride || this.pop > 0.001) return 1 / 60;
      if (now - (this.lastActive || 0) < 1500) return 1 / 60;
      for (const p of this.fx) if (!CALM_FX.has(p.type) || (p.type === 'scribble' && p.life < 1.2)) return 1 / 60;
      return this.moodName === 'sleeping' ? 1 / 15 : this.moodName === 'bored' ? 1 / 20 : 1 / 30;
    }

    /**
     * Ask for the next frame. While she moves it comes at the screen's next refresh; when she is calm
     * (30 fps or less) a timer wakes her a little before it is due, so the page sleeps between her frames
     * instead of being woken at every refresh of the screen for nothing.
     */
    _schedule(wait) {
      if (!this._running || this._rafPending) return;
      if (wait > 0.02) {
        if (!this._wakeT) this._wakeT = setTimeout(() => { this._wakeT = 0; this._due = true; this._schedule(0); }, (Math.min(wait, 0.25) - 0.002) * 1000);
        return;
      }
      this._rafPending = true;
      requestAnimationFrame(this._frame);
    }

    /** Something happened (she was called, touched, given something to do): the next frame comes at once. */
    _wake() {
      if (!this._wakeT) return;
      clearTimeout(this._wakeT);
      this._wakeT = 0;
      this._schedule(0);
    }

    _frame(now) {
      this._rafPending = false;
      if (!this._running) return;
      // asked for by the calm timer: the frame is due now. Its time stamp can be the screen refresh
      // before the timer, so the clock is read instead.
      const due = this._due;
      this._due = false;
      if (due) now = Math.max(now, performance.now());
      if (document.hidden) { this._last = now; this._schedule(0.25); return; }
      const step = (now - this._last) / 1000;
      this._last = now;
      if (step <= 0) { this._schedule(0); return; }
      const interval = this._frameInterval(now);
      // a frame comes early now and then (the screen's refresh): it waits for the next one
      this._acc = (this._acc || 0) + step;
      if (!due && this._acc < interval - 0.004) { this._schedule(interval - this._acc); return; }
      const dt = Math.min(this._acc, Math.max(1 / 20, interval));
      this._acc = 0;
      this.t += dt;
      // the next frame is asked for first: whatever happens in this one, she keeps living
      this._schedule(interval);
      this._update(dt, now);
      // fully hidden with nothing left on screen: timers keep working, and nothing is drawn after the
      // one frame that clears her away
      if (interval === 0.25) {
        if (!this._hiddenDrawn) { this._render(); this._hiddenDrawn = true; }
        return;
      }
      this._hiddenDrawn = false;
      this._render();
    }

    _update(dt, now) {
      const R = this.R, t = this.t;
      const face = this.face, body = this.body;
      const mf = Object.assign({}, FACE0, this.mood.face || {});
      const mb = Object.assign({}, BODY0, this.mood.body || {});

      // ─ idle life: boredom → sleep, small random acts
      this._idleLife(dt, now);

      // ─ blend face/body params toward the mood
      for (const k in mf) face[k] = damp(face[k], mf[k], 9, dt);
      for (const k in mb) body[k] = damp(body[k], mb[k], 5, dt);
      const th = THEMES[this.opt.theme] || THEMES.rainbow;
      const tintT = this.moodTint || th.tint;
      for (let i = 0; i < 3; i++) this.tint[i] = damp(this.tint[i], tintT[i], 4, dt);
      this.tintAmtBase = damp(this.tintAmtBase || 0, this.moodTint ? 0 : th.amt, 4, dt);

      // ─ movement
      const prevX = this.pos.x, prevY = this.pos.y;
      if (this.mode === 'fly' && this.flight) this._stepFlight(dt);
      else if (this.mode === 'hover') {
        this.pos.x = damp(this.pos.x, this.anchor.x, 6, dt);
        this.pos.y = damp(this.pos.y, this.anchor.y, 6, dt);
      } else if (this.mode === 'throw') this._stepThrow(dt);
      if (this.mode !== 'throw') {
        this.vel.x = (this.pos.x - prevX) / dt;
        this.vel.y = (this.pos.y - prevY) / dt;
      }

      // ─ bob / hop / sag offsets
      let ox = 0, oy = 0, hopSquash = 0;
      if (this.mode === 'hover') {
        ox = Math.sin(t * body.bobFreq * 0.5 + 1.1) * R * 0.035 * body.bob;
        oy = Math.sin(t * body.bobFreq) * R * 0.075 * body.bob + body.sag * R;
        if (body.hop > 0.01) {
          const ph = Math.abs(Math.sin(t * 5.2));
          oy -= ph * R * 0.32 * body.hop;
          hopSquash = -Math.pow(1 - ph, 6) * 0.14 * body.hop;
        }
      }
      this.disp.x = this.pos.x + ox;
      this.disp.y = this.pos.y + oy;

      // ─ squash & stretch from velocity
      const sp = len(this.vel.x, this.vel.y);
      if (sp > 30) { this.dir.x = damp(this.dir.x, this.vel.x / sp, 14, dt); this.dir.y = damp(this.dir.y, this.vel.y / sp, 14, dt); }
      else if (this.mode === 'hover') { this.dir.x = damp(this.dir.x, 0, 3, dt); this.dir.y = damp(this.dir.y, 1, 3, dt); }
      const dl = len(this.dir.x, this.dir.y) || 1;
      this.dir.x /= dl; this.dir.y /= dl;
      const velStretch = this.mode === 'drag' ? clamp(sp / 3000, 0, 0.3) : clamp(sp / 2600, 0, 0.34);
      this.stretch = damp(this.stretch, velStretch, 18, dt);
      this.squash.step(0, dt);
      this.appear.step(this.appearTarget, dt);
      this.wobAmp = Math.max(body.wob, this.wobAmp * Math.exp(-dt * 2.6));
      if (this.wobAmp < body.wob) this.wobAmp = damp(this.wobAmp, body.wob, 3, dt);

      // ─ eyes: look target + saccades + blink
      let lx = 0, ly = 0;
      const lookMode = this.mood.look;
      const target = this.lookPoint || (this.pointTarget) || (lookMode === 'cursor' || lookMode === 'target' ? this.cursor : null);
      if (this.mode === 'fly' && !this.lookPoint) { lx = this.dir.x * 0.8; ly = this.dir.y * 0.6; }
      else if (target) {
        const dx = target.x - this.disp.x, dy = target.y - this.disp.y;
        const d = len(dx, dy) || 1;
        const k = Math.min(1, d / (R * 5));
        lx = dx / d * k; ly = dy / d * k;
      } else if (lookMode === 'up') { lx = 0.55; ly = -0.8; }
      else if (lookMode === 'down') { lx = -0.45; ly = 0.75; }
      else if (lookMode === 'away') { lx = -0.85; ly = -0.1; }
      if (lookMode !== 'none' && !this.pointTarget) {
        if (now > this.saccade.until) {
          this.saccade = { x: rand(-0.18, 0.18), y: rand(-0.12, 0.12), until: now + rand(700, 2600) };
        }
        lx += this.saccade.x; ly += this.saccade.y;
      }
      this.look.x = damp(this.look.x, clamp(lx, -1, 1), 14, dt);
      this.look.y = damp(this.look.y, clamp(ly, -1, 1), 14, dt);

      this.blink.next -= dt;
      if (this.blink.t < 0 && this.blink.next <= 0) { this.blink.t = 0; this.blink.double = Math.random() < 0.2; }
      let blinkOpen = 1;
      if (this.blink.t >= 0) {
        this.blink.t += dt;
        const bt = this.blink.t;
        blinkOpen = bt < 0.07 ? 1 - bt / 0.07 : bt < 0.15 ? (bt - 0.07) / 0.08 : 1;
        if (bt >= 0.15) {
          if (this.blink.double) { this.blink.double = false; this.blink.t = 0; }
          else { this.blink.t = -1; this.blink.next = rand(2.2, 6); }
        }
      }
      this.blinkOpen = blinkOpen;

      // ─ talking mouth
      if (this.talk) {
        this.talk.t += dt;
        let v;
        const h = this.talk.handle;
        // checked every frame: a neural line can fall back to the computer voice mid-way
        const useLevel = this.talk.babble || (h && h.kind === 'natural');
        if (useLevel && this.opt.sound) v = Math.min(1, this.opt.sound.level() * 1.4);
        else {
          const idx = Math.floor(this.talk.t * this.talk.rate);
          const p = this.talk.pattern;
          // a computer voice may still be talking after the text is typed: keep the mouth moving until it stops
          v = idx < p.length ? p[idx] : (this.talk.voiced && p.length ? p[idx % p.length] : 0);
        }
        this.talkOpen = damp(this.talkOpen, v, 28, dt);
      } else this.talkOpen = damp(this.talkOpen, 0, 20, dt);

      // ─ bow secondary motion
      const acc = this.vel.x - (this._pvx || 0);
      this._pvx = this.vel.x;
      this.bow.v -= acc * 0.0009;
      this.bow.v += (hopSquash ? hopSquash * 0.4 : 0);
      this.bow.step(0, dt);

      // ─ limbs
      this._updateLimbs(dt, t, hopSquash);

      // ─ effects emitters
      this._emitters(dt);
      this._updateFx(dt);

      this._hopSquash = hopSquash;
    }

    _stepFlight(dt) {
      const f = this.flight;
      f.t += dt;
      const R = this.R;
      if (f.antic && f.t < f.antic) {
        // anticipation: crouch back a little
        const k = f.t / f.antic;
        const dx = f.to.x - f.from.x, dy = f.to.y - f.from.y, d = len(dx, dy) || 1;
        this.pos.x = f.from.x - dx / d * R * 0.14 * Ease.outCubic(k);
        this.pos.y = f.from.y - dy / d * R * 0.14 * Ease.outCubic(k);
        this.squash.v -= dt * 18;
        return;
      }
      const u = clamp((f.t - f.antic) / f.dur, 0, 1);
      const e = f.style === 'cartoon' ? Ease.outBack(u) : Ease.inOutSine(u);
      const a = f.from, b = f.to, c = f.ctrl;
      const ie = 1 - e;
      this.pos.x = ie * ie * a.x + 2 * ie * e * c.x + e * e * b.x;
      this.pos.y = ie * ie * a.y + 2 * ie * e * c.y + e * e * b.y;
      if (f.trail && !this.reduced && Math.random() < dt * 22) {
        this._emit('mini', this.disp.x - this.dir.x * R * 0.9 + rand(-0.4, 0.4) * R, this.disp.y - this.dir.y * R * 0.9 + rand(-0.4, 0.4) * R,
          { vx: rand(-10, 10), vy: rand(-30, -10), r: R * rand(0.07, 0.16), max: rand(0.6, 1.1) });
      }
      if (u >= 1) {
        const impact = len(this.vel.x, this.vel.y);
        this._sfx('land', { impact });
        this.squash.v -= Math.min(4, impact / 700);
        this.wobAmp += Math.min(0.05, impact / 30000);
        this.anchor.x = b.x; this.anchor.y = b.y;
        this.mode = 'hover';
        const r = f.resolve;
        this.flight = null;
        r();
      }
    }

    _stepThrow(dt) {
      const R = this.R;
      const fr = Math.exp(-dt * 1.5);
      this.vel.x *= fr; this.vel.y *= fr;
      this.pos.x += this.vel.x * dt;
      this.pos.y += this.vel.y * dt;
      const minX = R * 1.3, maxX = this.W - R * 1.3, minY = R * 1.8, maxY = this.H - R * 1.7;
      const bounce = (axisV, dirX, dirY) => {
        this.dir.x = dirX; this.dir.y = dirY;
        this.squash.v -= Math.min(5, Math.abs(axisV) / 500);
        this._sfx('boing', { impact: Math.abs(axisV) });
        this.wobAmp += 0.03;
        this._emit('ripple', this.pos.x + dirX * R, this.pos.y + dirY * R, { max: 0.4, small: true });
      };
      if (this.pos.x < minX) { this.pos.x = minX; bounce(this.vel.x, -1, 0); this.vel.x = -this.vel.x * 0.72; }
      if (this.pos.x > maxX) { this.pos.x = maxX; bounce(this.vel.x, 1, 0); this.vel.x = -this.vel.x * 0.72; }
      if (this.pos.y < minY) { this.pos.y = minY; bounce(this.vel.y, 0, -1); this.vel.y = -this.vel.y * 0.72; }
      if (this.pos.y > maxY) { this.pos.y = maxY; bounce(this.vel.y, 0, 1); this.vel.y = -this.vel.y * 0.72; }
      if (Math.random() < dt * 25) this._emit('mini', this.pos.x + rand(-0.5, 0.5) * R, this.pos.y + rand(-0.5, 0.5) * R, { vy: -15, r: R * rand(0.06, 0.12), max: 0.7 });
      if (len(this.vel.x, this.vel.y) < 70) {
        this.anchor.x = this.pos.x; this.anchor.y = this.pos.y;
        this.mode = 'hover';
        if (!this._thrownSaid) { this._thrownSaid = true; this.setMood('happy', 1300); this.say(pick(this.lines.thrown), { hold: 1100 }); }
      }
    }

    _idleLife(dt, now) {
      if (this.mode !== 'hover' || this.talk || this.pointTarget || this.dragInfo) return;
      const idle = (now - this.lastActive) / 1000;
      const o = this.opt;
      this._inIdleChange = true;
      if (o.sleepAfter && idle > o.sleepAfter && this.moodName !== 'sleeping' && (this.moodName === 'bored' || this.moodName === 'idle')) {
        this.hush();
        this.setMood('sleeping');
        this.anchor.y = clamp(this.anchor.y + this.R * 0.6, this.R * 1.9, this.H - this.R * 1.8);
      } else if (o.boredAfter && idle > o.boredAfter && this.moodName === 'idle' && this.idleStage < 1) {
        this.idleStage = 1;
        this.setMood('bored');
        if (!o.fast) this.say(pick(this.lines.bored), { hold: 2600 });
      }
      this._inIdleChange = false;

      // small idle acts
      if (this.moodName === 'idle' && !o.fast) {
        this.nextIdleAct -= dt;
        if (this.nextIdleAct <= 0) {
          this.nextIdleAct = rand(5, 11);
          const act = pick(['look', 'look', 'wave', 'bubble', 'stretch', 'drift']);
          if (act === 'wave' && this.cursor) this.wave(1300);
          else if (act === 'bubble') this.blowBubble();
          else if (act === 'stretch') { this.stretchYawn(1400); }
          else if (act === 'drift') {
            const R = this.R;
            this.anchor.x = clamp(this.anchor.x + rand(-1.6, 1.6) * R, R * 1.4, this.W - R * 1.4);
            this.anchor.y = clamp(this.anchor.y + rand(-0.8, 0.8) * R, R * 1.9, this.H - R * 1.8);
          } else this.saccade = { x: rand(-0.8, 0.8), y: rand(-0.6, 0.4), until: now + 1300 };
        }
      }
    }

    // body-frame point (R units) → world
    _bodyToWorld(bx, by) {
      const M = this._M || [1, 0, 0, 1];
      const R = this.R;
      return { x: this.disp.x + (M[0] * bx + M[1] * by) * R, y: this.disp.y + (M[2] * bx + M[3] * by) * R };
    }

    _mouthWorld() { return this._bodyToWorld(this.look.x * 0.07, 0.3 + this.look.y * 0.05); }

    _computeM(hopSquash) {
      const st = this.stretch + this.squash.x + (hopSquash || 0);
      const a = clamp(1 + st, 0.62, 1.42);
      const b = 1 / Math.sqrt(a);
      const breath = 1 + Math.sin(this.t * (this.moodName === 'sleeping' ? 1.3 : 2.1)) * 0.012;
      const s = Math.max(0, this.appear.x) * breath;
      const dx = this.dir.x, dy = this.dir.y;
      const m00 = a * dx * dx + b * dy * dy, m01 = (a - b) * dx * dy, m11 = a * dy * dy + b * dx * dx;
      this._A = a; this._B = b; this._S = s;
      this._M = [m00 * s, m01 * s, m01 * s, m11 * s];
    }

    _updateLimbs(dt, t, hopSquash) {
      const R = this.R;
      this._computeM(hopSquash);
      const armNames = this.armOverride || this.mood.arms || ['float', 'float'];
      const legName = this.mood.legs || 'dangle';
      const moving = this.mode === 'fly' || this.mode === 'throw' || this.mode === 'drag';
      for (let i = 0; i < 2; i++) {
        const s = i === 0 ? -1 : 1;
        // arms
        let pose = (ARM[armNames[i]] || ARM.float)(s, t);
        let tx, ty;
        const hand = this.hands[i];
        const pt = this.pointTarget;
        if (pt && pt.side === s) {
          const sh = this._bodyToWorld(s * 0.965, 0.16);
          let dx = pt.x - sh.x, dy = pt.y - sh.y;
          const d = len(dx, dy) || 1;
          const reach = Math.min(d - R * 0.3, pt.tap ? R * 2.35 : R * 1.55);
          tx = sh.x + dx / d * reach; ty = sh.y + dy / d * reach;
          pose = { g: 'point', sag: pt.tap ? 0.12 : 0.55, rot: Math.atan2(dy, dx) };
          hand.tune(pt.tap ? 520 : 320, pt.tap ? 30 : 26);
        } else {
          if (moving && !this.armOverride && this.mode !== 'drag') {
            pose = { x: s * 1.18 - this.dir.x * 0.45, y: 0.2 - this.dir.y * 0.45, g: 'open', sag: 0.35 };
          }
          if (this.mode === 'drag') pose = ARM.up(s, t);
          const w = this._bodyToWorld(pose.x, pose.y);
          tx = w.x; ty = w.y;
          hand.tune(210, 20);
        }
        hand.step(tx, ty, dt);
        this.handInfo[i] = pose;
        // fingers move one by one toward the pose (index first, last finger last)
        const want = HANDS[pose.g] || HANDS.open;
        const fs = this.fingers[i];
        for (let k = 0; k < FINGERS.length; k++) {
          fs.curl[k] = damp(fs.curl[k], want.curl[k], 16 - k * 2.5, dt);
          fs.dir[k] = damp(fs.dir[k], want.dir[k], 14, dt);
        }
        fs.thumb = damp(fs.thumb, want.thumb, 12, dt);
        fs.spread = damp(fs.spread, want.spread, 12, dt);
        fs.reach = damp(fs.reach, want.reach || 1, 14, dt);
        fs.pointing = damp(fs.pointing, want.pointing || 0, 18, dt);
        // legs
        const lp = (LEG[this.mode === 'drag' ? 'spread' : legName] || LEG.dangle)(s, t);
        let fx = lp.x, fy = lp.y;
        if (moving) { fx -= this.dir.x * 0.5; fy -= this.dir.y * 0.35; }
        const fw = this._bodyToWorld(fx, fy);
        this.feet[i].step(fw.x, fw.y, dt);
        // keep feet within leg reach
        const hip = this._bodyToWorld(s * 0.34, 0.93);
        const ft = this.feet[i];
        const dxf = ft.x - hip.x, dyf = ft.y - hip.y, dl = len(dxf, dyf);
        const maxL = R * 0.95;
        if (dl > maxL) { ft.sx.x = hip.x + dxf / dl * maxL; ft.sy.x = hip.y + dyf / dl * maxL; }
        // keep hands within arm reach
        const sh = this._bodyToWorld(s * 0.965, 0.16);
        const dxh = hand.x - sh.x, dyh = hand.y - sh.y, dh = len(dxh, dyh);
        const maxA = R * 2.4;
        if (dh > maxA) { hand.sx.x = sh.x + dxh / dh * maxA; hand.sy.x = sh.y + dyh / dh * maxA; }
      }
    }

    // ───────────── internals: particles ─────────────

    _emitters(dt) {
      const fx = this.mood.fx || {};
      const R = this.R;
      if (this.mode === 'hidden' || this.reduced) return;
      if (fx.sparks && Math.random() < dt * fx.sparks) {
        this._sfx('sparkle');
        this._emit('spark', this.disp.x + rand(-1.5, 1.5) * R, this.disp.y + rand(-1.4, 0.4) * R, { max: rand(0.5, 0.9) });
      }
      if (fx.z && Math.random() < dt * 0.7) {
        const p = this._bodyToWorld(0.55, -0.9);
        this._emit('z', p.x, p.y, { vx: 12, vy: -22, max: 2.4, r: R * rand(0.42, 0.6) });
      }
      if (fx.rings && Math.random() < dt * 1.3) {
        const p = this._bodyToWorld(1.1, -0.25);
        this._emit('wave', p.x, p.y, { max: 0.9 });
      }
      if (fx.puff && Math.random() < dt * fx.puff) {
        this._sfx('sigh');
        const m = this._mouthWorld();
        this._emit('puff', m.x, m.y + R * 0.05, { vx: rand(-20, 20), vy: 18, max: 1.1 });
      }
    }

    _emit(type, x, y, o = {}) {
      if (this.fx.length > 220) this.fx.shift();
      this.fx.push({
        type, x, y, vx: o.vx || 0, vy: o.vy || 0, life: 0, max: o.max || 1,
        r: o.r || this.R * 0.15, hue: o.hue != null ? o.hue : rand(0, 360), rot: rand(0, TAU),
        vr: rand(-3, 3), data: o.data || null, popAtEnd: !!o.popAtEnd, small: !!o.small,
      });
    }

    _updateFx(dt) {
      const out = [];
      for (const p of this.fx) {
        p.life += dt;
        if (p.life >= p.max) {
          if (p.type === 'mini' && p.popAtEnd) {
            this._sfx('tinypop');
            for (let i = 0; i < 6; i++) {
              const a = rand(0, TAU);
              out.push({ type: 'drop', x: p.x, y: p.y, vx: Math.cos(a) * 90, vy: Math.sin(a) * 90, life: 0, max: 0.35, r: 1.6, hue: p.hue, rot: 0, vr: 0 });
            }
          }
          continue;
        }
        switch (p.type) {
          case 'mini': p.vy -= 12 * dt; p.vx *= 0.99; p.x += Math.sin(p.life * 3 + p.rot) * 8 * dt; break;
          case 'drop': p.vy += 1000 * dt; break;
          case 'z': p.x += Math.sin(p.life * 2.6) * 14 * dt; break;
          case 'spark': p.rot += p.vr * dt; break;
          case 'puff': p.vy *= 0.95; p.vx *= 0.95; break;
          default: break;
        }
        p.x += p.vx * dt; p.y += p.vy * dt;
        out.push(p);
      }
      this.fx = out;
    }

    // ───────────── internals: rendering ─────────────

    _render() {
      const R = this.R, S = this.S, G = this.G, d = this.dpr;
      const cx = S / 2, cy = S / 2;
      const hidden = this.mode === 'hidden' || this._S < 0.01;
      this.box.style.transform = `translate3d(${(this.disp.x - cx).toFixed(2)}px,${(this.disp.y - cy).toFixed(2)}px,0)`;
      this.box.style.visibility = hidden ? 'hidden' : 'visible';

      // back layer: shadow + limbs
      const b = this.bctx;
      b.setTransform(d, 0, 0, d, 0, 0);
      b.clearRect(0, 0, S, S);
      if (!hidden) {
        this._drawShadow(b, cx, cy);
        this._drawLimbs(b, cx, cy);
      }

      // bubble
      const body = this.body;
      const u = {
        hidden, cx: G / 2 * d, cy: G / 2 * d, r: R * this._S * d, dx: this.dir.x, dy: this.dir.y,
        a: this._A, b: this._B, t: this.t, wob: this.wobAmp, sat: body.sat, bright: body.bright,
        tint: this.tint, tintAmt: clamp(body.tintAmt + (this.tintAmtBase || 0), 0, 1), pop: this.pop,
        popX: this.popO.x, popY: this.popO.y, dpr: d, seed: this.seed,
      };
      if (this.bubble) this.bubble.render(this.cGL.width, this.cGL.height, u);
      else {
        const g = this.gctx;
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.clearRect(0, 0, this.cGL.width, this.cGL.height);
        drawBubble2D(g, u, this.t);
      }

      // front layer: face, bow, gloves, shoes
      const f = this.fctx;
      f.setTransform(d, 0, 0, d, 0, 0);
      f.clearRect(0, 0, S, S);
      if (!hidden && this.pop < 0.35) {
        const M = this._M;
        f.save();
        f.setTransform(d * M[0] * R, d * M[2] * R, d * M[1] * R, d * M[3] * R, d * cx, d * cy);
        this._drawFace(f);
        if (this.opt.look === 'girl') this._drawBow(f);
        else if (this.opt.look === 'boy') this._drawCap(f);
        if (this.mood.fx && this.mood.fx.dots) this._drawThinkDots(f);
        f.restore();
        this._drawHandsFeet(f, cx, cy);
      }

      this._drawFx();
      if (!this.sayEl.classList.contains('off')) this._placeSay();
    }

    _local(wx, wy, cx, cy) { return { x: wx - this.disp.x + cx, y: wy - this.disp.y + cy }; }

    _drawShadow(c, cx, cy) {
      const R = this.R * this._S;
      const g = c.createRadialGradient(cx, cy + R * 0.35, R * 0.2, cx, cy + R * 0.35, R * 1.35);
      g.addColorStop(0, 'rgba(18,20,60,0.16)');
      g.addColorStop(1, 'rgba(18,20,60,0)');
      c.fillStyle = g;
      c.beginPath(); c.ellipse(cx, cy + R * 0.35, R * 1.35, R * 1.2, 0, 0, TAU); c.fill();
    }

    _drawLimbs(c, cx, cy) {
      const R = this.R;
      c.save();
      this._halo(c);
      c.lineCap = 'round';
      c.lineJoin = 'round';
      c.strokeStyle = INK;
      for (let i = 0; i < 2; i++) {
        const s = i === 0 ? -1 : 1;
        // leg
        const hipW = this._bodyToWorld(s * 0.34, 0.93);
        const hip = this._local(hipW.x, hipW.y, cx, cy);
        const ft = this._local(this.feet[i].x, this.feet[i].y, cx, cy);
        const mxl = (hip.x + ft.x) / 2 + s * R * 0.12, myl = (hip.y + ft.y) / 2;
        c.lineWidth = R * 0.075;
        c.beginPath(); c.moveTo(hip.x, hip.y); c.quadraticCurveTo(mxl, myl, ft.x, ft.y); c.stroke();
        // arm
        const shW = this._bodyToWorld(s * 0.965, 0.16);
        const sh = this._local(shW.x, shW.y, cx, cy);
        const hd = this._local(this.hands[i].x, this.hands[i].y, cx, cy);
        const pose = this.handInfo[i] || {};
        const dx = hd.x - sh.x, dy = hd.y - sh.y, dl = len(dx, dy) || 1;
        const slack = clamp(1 - dl / (R * 2.4), 0, 1);
        const sag = (pose.sag != null ? pose.sag : 0.3) * (0.4 + slack);
        const out = pose.elbowOut ? s * dl * 0.35 : 0;
        const ctrlX = (sh.x + hd.x) / 2 + out, ctrlY = (sh.y + hd.y) / 2 + dl * sag * 0.55 + (pose.elbowOut ? -dl * 0.1 : 0);
        // rubber-hose arm: a soft lilac tube with an ink outline and striped wrist bands
        c.lineWidth = R * 0.115;
        c.beginPath(); c.moveTo(sh.x, sh.y); c.quadraticCurveTo(ctrlX, ctrlY, hd.x, hd.y); c.stroke();
        c.save();
        c.shadowBlur = 0;
        c.strokeStyle = ARM_FILL; c.lineWidth = R * 0.07;
        c.beginPath(); c.moveTo(sh.x, sh.y); c.quadraticCurveTo(ctrlX, ctrlY, hd.x, hd.y); c.stroke();
        c.strokeStyle = INK; c.lineWidth = R * 0.022; c.lineCap = 'butt';
        for (const t of [0.6, 0.66, 0.72]) {
          const it = 1 - t;
          const bx = it * it * sh.x + 2 * it * t * ctrlX + t * t * hd.x;
          const by = it * it * sh.y + 2 * it * t * ctrlY + t * t * hd.y;
          const tx = 2 * it * (ctrlX - sh.x) + 2 * t * (hd.x - ctrlX), ty = 2 * it * (ctrlY - sh.y) + 2 * t * (hd.y - ctrlY);
          const tl = len(tx, ty) || 1, nx = -ty / tl * R * 0.045, ny = tx / tl * R * 0.045;
          c.beginPath(); c.moveTo(bx + nx, by + ny); c.lineTo(bx - nx, by - ny); c.stroke();
        }
        c.restore();
        this._armCtrl = this._armCtrl || [{}, {}];
        this._armCtrl[i] = { x: ctrlX, y: ctrlY };
      }
      c.restore();
    }

    /** Soft white halo under ink lines so she stays readable on dark backgrounds. */
    _halo(c) {
      c.shadowColor = 'rgba(255,255,255,0.85)';
      c.shadowBlur = 2.6 * this.dpr;
      c.shadowOffsetX = 0; c.shadowOffsetY = 0;
    }

    _drawHandsFeet(c, cx, cy) {
      const R = this.R;
      for (let i = 0; i < 2; i++) {
        const s = i === 0 ? -1 : 1;
        const ft = this._local(this.feet[i].x, this.feet[i].y, cx, cy);
        const hipW = this._bodyToWorld(s * 0.34, 0.93);
        const hip = this._local(hipW.x, hipW.y, cx, cy);
        const legAng = Math.atan2(ft.y - hip.y, ft.x - hip.x);
        drawShoe(c, ft.x, ft.y, R * 0.3, s, legAng);
        const hd = this._local(this.hands[i].x, this.hands[i].y, cx, cy);
        const ctrl = (this._armCtrl && this._armCtrl[i]) || { x: cx, y: cy };
        const pose = this.handInfo[i] || {};
        let ang = Math.atan2(hd.y - ctrl.y, hd.x - ctrl.x);
        if (pose.rot != null && pose.g !== 'point') ang = pose.rot + (s < 0 && pose.g !== 'cup' ? 0 : 0);
        if (pose.g === 'point' && this.pointTarget && this.pointTarget.side === s) {
          ang = Math.atan2(this.pointTarget.y - this.hands[i].y, this.pointTarget.x - this.hands[i].x);
        } else if (pose.g === 'point' && pose.rot != null) ang = pose.rot;
        drawGlove(c, hd.x, hd.y, R * 0.42, ang, this.fingers[i], s);
      }
    }

    _drawFace(c) {
      const f = this.face;
      const lx = this.look.x, ly = this.look.y;
      c.save();
      this._halo(c);
      c.translate(lx * 0.085, ly * 0.06);
      c.scale(1 - Math.abs(lx) * 0.07, 1 - Math.abs(ly) * 0.03);
      c.lineCap = 'round';
      c.lineJoin = 'round';
      // blush
      if (f.blush > 0.02) {
        for (const s of [-1, 1]) {
          const g = c.createRadialGradient(s * 0.5, 0.16, 0, s * 0.5, 0.16, 0.13);
          g.addColorStop(0, `rgba(255,105,160,${0.55 * f.blush})`);
          g.addColorStop(1, 'rgba(255,105,160,0)');
          c.fillStyle = g;
          c.beginPath(); c.ellipse(s * 0.5, 0.16, 0.14, 0.085, 0, 0, TAU); c.fill();
        }
      }
      for (const s of [-1, 1]) this._drawEye(c, s * 0.305, -0.08, s);
      for (const s of [-1, 1]) this._drawBrow(c, s);
      this._drawMouth(c);
      c.restore();
    }

    _drawEye(c, x, y, side) {
      const f = this.face;
      const girl = this.opt.look === 'girl';
      const open = clamp(f.eyeOpen, 0, 1.3) * this.blinkOpen;
      const happy = f.happyEye;
      const sc = f.eyeScale;
      const rx = 0.175 * sc, ry = 0.235 * sc;
      c.save();
      c.translate(x, y);
      const ink = INK;
      const lw = 0.032;
      if (happy < 0.98 && open > 0.08) {
        c.globalAlpha = 1 - happy;
        // white
        c.beginPath(); c.ellipse(0, 0, rx, ry, 0, 0, TAU);
        const g = c.createLinearGradient(0, -ry, 0, ry);
        g.addColorStop(0, '#ffffff'); g.addColorStop(1, '#e3e7fb');
        c.fillStyle = g; c.fill();
        c.save();
        c.clip();
        // iris + pupil
        const px = clamp(this.look.x * 0.075, -rx * 0.45, rx * 0.45);
        const py = clamp(this.look.y * 0.08, -ry * 0.4, ry * 0.45) + 0.015;
        const ir = 0.118 * sc * clamp(f.pupil, 0.7, 1.25);
        const ig = c.createRadialGradient(px, py + ir * 0.35, ir * 0.1, px, py, ir);
        ig.addColorStop(0, '#b59bff'); ig.addColorStop(0.55, '#6d4ae6'); ig.addColorStop(1, '#241860');
        c.fillStyle = ig;
        c.beginPath(); c.arc(px, py, ir, 0, TAU); c.fill();
        c.fillStyle = '#0c0a24';
        c.beginPath(); c.arc(px, py, ir * 0.55, 0, TAU); c.fill();
        c.fillStyle = '#fff';
        c.beginPath(); c.ellipse(px + ir * 0.38, py - ir * 0.4, ir * 0.34, ir * 0.3, -0.5, 0, TAU); c.fill();
        c.beginPath(); c.arc(px - ir * 0.35, py + ir * 0.42, ir * 0.14, 0, TAU); c.fill();
        // upper lid
        const lidY = -ry + (1 - clamp(open, 0, 1)) * 2 * ry;
        const tilt = f.lidTilt * 0.09;
        // yA = left end, yB = right end; a positive tilt lowers the inner corners (cross look)
        const yA = lidY + tilt * side, yB = lidY - tilt * side;
        c.beginPath();
        c.moveTo(-rx - 0.02, -ry - 0.05);
        c.lineTo(rx + 0.02, -ry - 0.05);
        c.lineTo(rx + 0.02, yB);
        c.quadraticCurveTo(0, (yA + yB) / 2 + 0.03, -rx - 0.02, yA);
        c.closePath();
        c.fillStyle = '#e6e3ff';
        c.fill();
        if (open < 0.98 || Math.abs(f.lidTilt) > 0.05) {
          c.strokeStyle = ink; c.lineWidth = lw * 1.3;
          c.beginPath(); c.moveTo(rx + 0.02, yB); c.quadraticCurveTo(0, (yA + yB) / 2 + 0.03, -rx - 0.02, yA); c.stroke();
        }
        c.restore();
        // outline
        c.strokeStyle = ink; c.lineWidth = lw;
        c.beginPath(); c.ellipse(0, 0, rx, ry, 0, 0, TAU); c.stroke();
        // lashes at the outer top, riding the lid line
        if (girl) {
          const lid = -ry + (1 - clamp(open, 0, 1)) * 2 * ry;
          const baseY = Math.max(lid, -ry * 0.72);
          c.lineWidth = lw * 0.95;
          for (let k = 0; k < 3; k++) {
            const bx = side * (rx * (0.55 + k * 0.2));
            const by = baseY + k * 0.035 - (open > 0.5 ? 0.02 : 0);
            c.beginPath();
            c.moveTo(bx, by);
            c.quadraticCurveTo(bx + side * 0.05, by - 0.03, bx + side * (0.07 + k * 0.01), by - 0.07 + k * 0.02);
            c.stroke();
          }
        }
        c.globalAlpha = 1;
      }
      if (happy > 0.02 || open <= 0.08) {
        c.globalAlpha = open <= 0.08 ? 1 : happy;
        c.strokeStyle = ink; c.lineWidth = lw * 1.45;
        c.beginPath();
        if (happy > 0.02) {
          c.moveTo(-rx * 0.95, 0.03); c.quadraticCurveTo(0, -0.14, rx * 0.95, 0.03);
        } else {
          c.moveTo(-rx, 0.0); c.quadraticCurveTo(0, 0.1, rx, 0.0);
        }
        c.stroke();
        if (girl) {
          c.lineWidth = lw * 0.95;
          const yb = happy > 0.02 ? -0.02 : 0.01;
          for (let k = 0; k < 2; k++) {
            const bx = side * rx * (0.75 + k * 0.28);
            c.beginPath(); c.moveTo(bx, yb + k * 0.02);
            c.lineTo(bx + side * 0.06, yb + k * 0.02 + (happy > 0.02 ? -0.05 : 0.05));
            c.stroke();
          }
        }
        c.globalAlpha = 1;
      }
      c.restore();
    }

    _drawBrow(c, side) {
      const f = this.face;
      let y = -0.44 - f.browY * 0.07 - (f.browAsym > 0 && side > 0 ? f.browAsym * 0.09 : 0);
      const ang = -f.browTilt * side * 0.42 + (f.browAsym > 0 && side < 0 ? 0.12 * side * f.browAsym : 0);
      c.save();
      c.translate(side * 0.31, y);
      c.rotate(ang);
      c.strokeStyle = INK; c.lineWidth = 0.036;
      c.beginPath(); c.moveTo(-0.075, 0.012); c.quadraticCurveTo(0, -0.028, 0.075, 0.012); c.stroke();
      c.restore();
    }

    _drawMouth(c) {
      const f = this.face;
      const talk = this.talkOpen;
      const w = f.mouthW + talk * 0.05;
      let o = Math.max(f.mouthOpen, talk * (0.1 + 0.05 * f.happyEye));
      const cv = f.mouthCurve;
      const round = f.mouthRound;
      c.save();
      c.translate(0, 0.3);
      c.strokeStyle = INK; c.lineWidth = 0.034;
      if (round > 0.5) {
        const rw = w * 0.5, rh = Math.max(0.03, o * 0.7 + 0.02);
        c.beginPath(); c.ellipse(0, 0.02, rw, rh, 0, 0, TAU);
        c.fillStyle = '#4a1236'; c.fill(); c.stroke();
        c.restore();
        return;
      }
      const hw = w / 2;
      const cy = -cv * 0.035;
      if (o < 0.018) {
        c.beginPath(); c.moveTo(-hw, cy); c.quadraticCurveTo(0, cy + cv * 0.1, hw, cy); c.stroke();
        if (cv > 0.6) {
          c.lineWidth = 0.024;
          c.beginPath(); c.moveTo(-hw - 0.02, cy - 0.02); c.lineTo(-hw + 0.005, cy + 0.008); c.stroke();
          c.beginPath(); c.moveTo(hw + 0.02, cy - 0.02); c.lineTo(hw - 0.005, cy + 0.008); c.stroke();
        }
        if (f.tongue > 0.5) {
          c.fillStyle = '#ff7fae';
          c.beginPath(); c.ellipse(hw * 0.55, cy + cv * 0.05 + 0.028, 0.03, 0.036, 0.3, 0, TAU); c.fill();
          c.lineWidth = 0.022; c.stroke();
        }
      } else {
        const upY = cy + cv * 0.045 - o * 0.12;
        const loY = cy + cv * 0.1 + o * 1.05;
        const mouthPath = () => {
          c.beginPath();
          c.moveTo(-hw, cy);
          c.quadraticCurveTo(0, upY, hw, cy);
          c.quadraticCurveTo(0, loY, -hw, cy);
          c.closePath();
        };
        mouthPath();
        c.fillStyle = '#4a1236'; c.fill();
        c.save(); c.clip();
        c.fillStyle = '#ff7fae';
        c.beginPath(); c.ellipse(0, loY * 0.72 + 0.01, hw * 0.62, Math.max(0.02, o * 0.5), 0, 0, TAU); c.fill();
        if (o > 0.06) {
          c.fillStyle = '#fff';
          c.fillRect(-hw * 0.6, (upY + cy) / 2 - 0.012, hw * 1.2, 0.032);
        }
        c.restore();
        mouthPath();
        c.stroke();
      }
      c.restore();
    }

    _drawBow(c) {
      c.save();
      c.translate(0.5, -0.8);
      c.rotate(0.38 + this.bow.x);
      c.scale(0.95, 0.95);
      c.lineJoin = 'round'; c.lineCap = 'round';
      const loop = (s) => {
        c.beginPath();
        c.moveTo(0, 0);
        c.bezierCurveTo(s * 0.1, -0.18, s * 0.36, -0.15, s * 0.32, 0.02);
        c.bezierCurveTo(s * 0.3, 0.16, s * 0.1, 0.1, 0, 0);
        c.closePath();
      };
      const tail = (s) => {
        c.beginPath();
        c.moveTo(s * 0.02, 0.03);
        c.quadraticCurveTo(s * 0.08, 0.16, s * 0.14, 0.24);
        c.lineTo(s * 0.06, 0.22);
        c.lineTo(s * 0.03, 0.27);
        c.quadraticCurveTo(s * 0.0, 0.14, s * -0.02, 0.04);
        c.closePath();
      };
      const g = c.createLinearGradient(0, -0.16, 0, 0.16);
      g.addColorStop(0, PINK_HI); g.addColorStop(1, PINK_LO);
      // outline pass then fill pass for a clean union silhouette
      c.strokeStyle = INK; c.lineWidth = 0.06;
      for (const s of [-1, 1]) { tail(s); c.stroke(); loop(s); c.stroke(); }
      c.fillStyle = g;
      for (const s of [-1, 1]) { tail(s); c.fill(); loop(s); c.fill(); }
      // folds
      c.strokeStyle = 'rgba(26,29,74,0.45)'; c.lineWidth = 0.02;
      for (const s of [-1, 1]) {
        c.beginPath(); c.moveTo(s * 0.06, -0.01); c.quadraticCurveTo(s * 0.16, -0.06, s * 0.22, 0.0); c.stroke();
      }
      // knot
      c.fillStyle = PINK; c.strokeStyle = INK; c.lineWidth = 0.03;
      c.beginPath(); roundRect(c, -0.055, -0.06, 0.11, 0.12, 0.04); c.fill(); c.stroke();
      // shine
      c.fillStyle = 'rgba(255,255,255,0.7)';
      c.beginPath(); c.ellipse(-0.2, -0.06, 0.05, 0.022, -0.5, 0, TAU); c.fill();
      c.restore();
    }

    _drawCap(c) {
      c.save();
      c.translate(0.05, -0.86);
      c.rotate(-0.12 + this.bow.x * 0.5);
      c.strokeStyle = INK; c.lineWidth = 0.032; c.lineJoin = 'round';
      c.fillStyle = '#4c7dff';
      c.beginPath(); c.moveTo(-0.42, 0.1); c.quadraticCurveTo(-0.38, -0.3, 0.02, -0.32); c.quadraticCurveTo(0.4, -0.3, 0.44, 0.1); c.closePath(); c.fill(); c.stroke();
      c.fillStyle = '#2f5ae0';
      c.beginPath(); c.moveTo(0.3, 0.06); c.quadraticCurveTo(0.62, 0.02, 0.7, 0.14); c.quadraticCurveTo(0.5, 0.2, 0.3, 0.14); c.closePath(); c.fill(); c.stroke();
      c.fillStyle = '#fff';
      c.beginPath(); c.arc(0.02, -0.32, 0.04, 0, TAU); c.fill(); c.stroke();
      c.restore();
    }

    _drawThinkDots(c) {
      const t = this.t;
      for (let k = 0; k < 3; k++) {
        const ph = (t * 1.4 + k * 0.33) % 1;
        const a = Math.sin(ph * Math.PI);
        c.globalAlpha = a;
        c.fillStyle = '#fff'; c.strokeStyle = INK; c.lineWidth = 0.025;
        c.beginPath(); c.arc(0.7 + k * 0.17, -1.05 - k * 0.16 - ph * 0.05, 0.045 + k * 0.018, 0, TAU); c.fill(); c.stroke();
      }
      c.globalAlpha = 1;
    }

    _drawFx() {
      const c = this.xctx, d = this.dpr;
      c.setTransform(d, 0, 0, d, 0, 0);
      const box = this.fxBox;
      if (box) c.clearRect(box.x0 - 2, box.y0 - 2, box.x1 - box.x0 + 4, box.y1 - box.y0 + 4);
      if (!this.fx.length) { this.fxBox = null; return; }
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      const grow = (x, y, r) => { if (x - r < x0) x0 = x - r; if (y - r < y0) y0 = y - r; if (x + r > x1) x1 = x + r; if (y + r > y1) y1 = y + r; };
      for (const p of this.fx) {
        const k = p.life / p.max;
        const fade = 1 - k;
        switch (p.type) {
          case 'mini': drawMini(c, p.x, p.y, p.r, p.hue + p.life * 60, Math.min(1, fade * 2.5)); grow(p.x, p.y, p.r + 2); break;
          case 'drop': {
            c.fillStyle = `hsla(${p.hue},90%,78%,${fade})`;
            c.beginPath(); c.arc(p.x, p.y, p.r, 0, TAU); c.fill();
            grow(p.x, p.y, p.r + 1); break;
          }
          case 'spark': {
            const s = this.R * 0.13 * Math.sin(k * Math.PI);
            drawSpark(c, p.x, p.y, s, p.rot, `hsl(${p.hue},100%,75%)`);
            grow(p.x, p.y, s + 2); break;
          }
          case 'z': {
            c.save();
            c.globalAlpha = Math.min(1, fade * 1.6) * Math.min(1, p.life * 3);
            c.font = `700 ${p.r * (0.7 + k * 0.5)}px system-ui, sans-serif`;
            c.fillStyle = '#fff'; c.strokeStyle = INK; c.lineWidth = 2.2;
            c.textAlign = 'center'; c.textBaseline = 'middle';
            c.strokeText('z', p.x, p.y); c.fillText('z', p.x, p.y);
            c.restore();
            grow(p.x, p.y, p.r * 1.3); break;
          }
          case 'puff': {
            c.fillStyle = `rgba(210,220,255,${0.55 * fade})`;
            const r = this.R * (0.08 + k * 0.14);
            c.beginPath(); c.arc(p.x, p.y, r, 0, TAU); c.arc(p.x + r * 0.8, p.y + r * 0.2, r * 0.7, 0, TAU); c.fill();
            grow(p.x, p.y, r * 2); break;
          }
          case 'ripple': {
            const r = (p.small ? this.R * 0.5 : this.R * 0.9) * (0.2 + k);
            c.strokeStyle = `rgba(150,235,255,${fade})`; c.lineWidth = 3 * fade + 1;
            c.beginPath(); c.arc(p.x, p.y, r, 0, TAU); c.stroke();
            grow(p.x, p.y, r + 4); break;
          }
          case 'ring': {
            const r = this.R * (0.6 + k * 1.2);
            c.strokeStyle = `hsla(${(this.t * 90) % 360},100%,80%,${fade * 0.9})`; c.lineWidth = 3 * fade + 0.5;
            c.beginPath(); c.arc(p.x, p.y, r, 0, TAU); c.stroke();
            grow(p.x, p.y, r + 4); break;
          }
          case 'pop': {
            c.strokeStyle = `rgba(255,255,255,${fade})`; c.lineWidth = 2;
            const r = this.R * (0.9 + k * 0.7);
            for (let i = 0; i < 10; i++) {
              const a = i / 10 * TAU;
              c.beginPath(); c.moveTo(p.x + Math.cos(a) * r * 0.8, p.y + Math.sin(a) * r * 0.8);
              c.lineTo(p.x + Math.cos(a) * r, p.y + Math.sin(a) * r); c.stroke();
            }
            grow(p.x, p.y, r + 4); break;
          }
          case 'wave': {
            const r = this.R * (0.2 + k * 0.6);
            c.strokeStyle = `rgba(160,235,255,${fade})`; c.lineWidth = 2.5;
            c.beginPath(); c.arc(p.x, p.y, r, -0.7, 0.7); c.stroke();
            grow(p.x, p.y, r + 3); break;
          }
          case 'target': {
            const pulse = (this.t * 1.6) % 1;
            const r = this.R * (0.35 + pulse * 0.5);
            const a = Math.min(1, fade * 3) * (1 - pulse);
            c.strokeStyle = `rgba(255,95,162,${a})`; c.lineWidth = 3;
            c.beginPath(); c.arc(p.x, p.y, r, 0, TAU); c.stroke();
            c.fillStyle = `rgba(255,95,162,${Math.min(1, fade * 3) * 0.9})`;
            c.beginPath(); c.arc(p.x, p.y, 4, 0, TAU); c.fill();
            grow(p.x, p.y, this.R * 0.9); break;
          }
          case 'scribble': {
            const { w, h, seed } = p.data;
            const prog = clamp(p.life / 0.6, 0, 1);
            const a = Math.min(1, fade * 4);
            c.strokeStyle = `rgba(255,59,92,${a})`; c.lineWidth = 3.2; c.lineCap = 'round'; c.lineJoin = 'round';
            c.beginPath();
            const turns = 1.15 * prog, steps = 80;
            for (let i = 0; i <= steps * turns; i++) {
              const u = i / steps;
              const ang = -2.4 + u * TAU;
              const jit = 1 + 0.06 * Math.sin(u * 17 + seed) + 0.04 * Math.sin(u * 5 + seed * 2) + u * 0.05;
              const x = p.x + Math.cos(ang) * (w / 2 + 12) * jit;
              const y = p.y + Math.sin(ang) * (h / 2 + 10) * jit;
              if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
            }
            c.stroke();
            grow(p.x, p.y, Math.max(w, h) / 2 + 24); break;
          }
          default: break;
        }
      }
      this.fxBox = { x0, y0, x1, y1 };
    }

    _placeSay() {
      const el0 = this.sayEl;
      const R = this.R;
      const w = el0.offsetWidth, h = el0.offsetHeight;
      // follow her body, not her bob, so the bubble (and its buttons) stays still enough to read and click
      const bx = Math.round(this.pos.x), by = Math.round(this.pos.y + (this.mode === 'hover' ? this.body.sag * R : 0));
      const top = by - R * 1.75;
      let below = top - h - 12 < 4;
      let x = clamp(bx - w / 2, 6, this.W - w - 6);
      // while she points at a box, her words keep off it
      const a = this._avoid;
      const hits = (yy) => a && x < a.x + a.w && x + w > a.x && yy < a.y + a.h && yy + h > a.y;
      if (a && hits(below ? by + R * 2.1 : top - h - 10)) {
        const other = !below;
        if (!hits(other ? by + R * 2.1 : top - h - 10) && (other ? by + R * 2.1 + h < this.H - 4 : top - h - 12 >= 4)) below = other;
      }
      const y = below ? by + R * 2.1 : top - h - 10;
      el0.classList.toggle('below', below);
      el0.style.left = x + 'px';
      el0.style.top = y + 'px';
      const tail = clamp(bx - x, 18, w - 18);
      el0.style.setProperty('--tail', tail + 'px');
    }
  }

  // ───────────────────────────── drawing helpers ─────────────────────────────

  function cloneHand(h) { return { curl: h.curl.slice(), thumb: h.thumb, spread: h.spread, dir: h.dir.slice(), reach: h.reach || 1, pointing: h.pointing || 0 }; }

  function el(tag, cls) { const e = document.createElement(tag); if (cls) e.className = cls; return e; }

  function roundRect(c, x, y, w, h, r) {
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  // Finger poses: curl 0 = straight … 1 = folded into the palm; order is index, middle, last finger.
  // Classic cartoon glove: three fingers and a thumb.
  const HANDS = {
    open: { curl: [0.05, 0.03, 0.06], thumb: 0.1, spread: 0.8, dir: [0, 0, 0] },
    wave: { curl: [0, 0, 0], thumb: 0.02, spread: 1.25, dir: [0, 0, 0] },
    point: { curl: [0, 1, 1], thumb: 0.8, spread: 0.5, dir: [0, 0, 0], reach: 1, pointing: 1 },
    fist: { curl: [1, 1, 1], thumb: 0.72, spread: 0.5, dir: [0, 0, 0] },
    cup: { curl: [0.45, 0.42, 0.48], thumb: 0.35, spread: 0.7, dir: [0, 0, 0] },
    thumb: { curl: [1, 1, 1], thumb: -0.35, spread: 0.5, dir: [0, 0, 0] },
    peace: { curl: [0, 0, 1], thumb: 0.8, spread: 1.6, dir: [-0.02, 0.1, 0] },
    grab: { curl: [0.3, 0.28, 0.32], thumb: 0.25, spread: 0.8, dir: [0, 0, 0] },
  };
  // Resting layout of each finger on the palm (glove units, pointing along +x, thumb on -y).
  // Fat, rounded "rubber-hose" fingers that touch each other, like 1930s cartoon gloves.
  const FINGERS = [
    { base: -0.52, dir: -0.3, len: 0.4, w: 0.25 },  // index
    { base: 0.0, dir: 0.0, len: 0.44, w: 0.255 },   // middle
    { base: 0.52, dir: 0.32, len: 0.38, w: 0.245 }, // last
  ];

  /**
   * Cartoon glove: three puffy fingers and a thumb. Straight fingers sit behind the palm; folded
   * fingers become a row of knuckles on top of it, with the thumb wrapped across (like a fist).
   * `fs` is the live finger state ({ curl: [3], thumb, spread, dir: [3], reach }).
   */
  function drawGlove(c, x, y, size, ang, fs, side) {
    const k = fs.pointing || 0;
    if (k > 0.02) {
      c.save(); c.globalAlpha *= k;
      drawPointingGlove(c, x, y, size * 1.2, ang, side);
      c.restore();
    }
    if (k < 0.98) {
      c.save(); c.globalAlpha *= 1 - k;
      drawOpenGlove(c, x, y, size, ang, fs, side);
      c.restore();
    }
  }

  /**
   * The pointing hand, drawn like a classic cartoon glove seen from the front: a long index finger,
   * the other two fingers curled into the fist as two stacked rolls, and the thumb wrapped around them.
   * Designed upright (finger toward -y, wrist at the origin), then turned toward `ang`.
   */
  function drawPointingGlove(c, x, y, size, ang, side) {
    c.save();
    c.translate(x, y);
    c.rotate(ang + Math.PI / 2);
    c.scale(size * (side < 0 ? -1 : 1), size);
    c.translate(0, -0.4);
    c.lineCap = 'round';
    c.lineJoin = 'round';
    const OL = 0.05;
    const shape = (path) => {
      path(); c.strokeStyle = INK; c.lineWidth = OL * 2; c.stroke();
      path(); c.fillStyle = '#fff'; c.fill();
    };
    const tube = (pts, w) => {
      c.beginPath();
      c.moveTo(pts[0][0], pts[0][1]);
      if (pts.length === 3) c.quadraticCurveTo(pts[1][0], pts[1][1], pts[2][0], pts[2][1]);
      else c.lineTo(pts[1][0], pts[1][1]);
      c.strokeStyle = INK; c.lineWidth = w + OL * 2; c.stroke();
      c.strokeStyle = '#fff'; c.lineWidth = w; c.stroke();
    };
    // cuff at the wrist
    shape(() => { c.beginPath(); roundRect(c, -0.2, 0.3, 0.4, 0.16, 0.07); });
    c.strokeStyle = INK; c.lineWidth = OL * 0.8;
    c.beginPath(); c.moveTo(-0.17, 0.38); c.lineTo(0.17, 0.38); c.stroke();
    // index finger standing up out of the fist, with a knuckle crease
    tube([[0.06, 0.0], [0.06, -0.7]], 0.23);
    c.strokeStyle = INK; c.lineWidth = 0.035;
    c.beginPath(); c.moveTo(-0.02, -0.36); c.quadraticCurveTo(0.06, -0.33, 0.14, -0.36); c.stroke();
    // the fist
    shape(() => { c.beginPath(); c.ellipse(0.02, 0.12, 0.26, 0.23, 0, 0, TAU); });
    // two curled fingers: stacked rolls across the front, rounded ends showing on the right
    tube([[-0.04, 0.04], [0.2, 0.04]], 0.15);
    tube([[-0.04, 0.2], [0.2, 0.2]], 0.15);
    // thumb curls up the left side and over the top roll, tip tucked under the index finger
    tube([[-0.14, 0.27], [-0.3, 0.02], [0.0, -0.06]], 0.15);
    // soft shade
    c.fillStyle = 'rgba(150,160,225,0.22)';
    c.beginPath(); c.ellipse(0.1, 0.29, 0.1, 0.04, 0, 0, TAU); c.fill();
    c.restore();
  }

  function drawOpenGlove(c, x, y, size, ang, fs, side) {
    c.save();
    c.translate(x, y);
    c.rotate(ang);
    c.scale(size, size * (side < 0 ? -1 : 1));
    c.lineCap = 'round';
    c.lineJoin = 'round';
    const OL = 0.052;
    const px = 0.02, py = 0.0, PR = 0.29;
    const tube = (pts, w) => {
      c.beginPath();
      c.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]);
      c.strokeStyle = INK; c.lineWidth = w + OL * 2; c.stroke();
      c.strokeStyle = '#fff'; c.lineWidth = w; c.stroke();
    };
    const straight = (baseAng, dirAng, length, curl) => {
      const bx = px + Math.cos(baseAng) * 0.13, by = py + Math.sin(baseAng) * 0.13;
      const L = length * (1 - 0.5 * clamp(curl / 0.6, 0, 1));
      const d1 = dirAng + 0.15 * curl;
      const mx = bx + Math.cos(d1) * L * 0.6, my = by + Math.sin(d1) * L * 0.6;
      const d2 = d1 + 0.25 * curl;
      return [[bx, by], [mx, my], [mx + Math.cos(d2) * L * 0.4, my + Math.sin(d2) * L * 0.4]];
    };
    // A folded finger: a short fat knuckle hugging the front of the palm.
    const knuckle = (baseAng) => {
      const a = baseAng * 0.62;
      const bx = px + Math.cos(a) * (PR - 0.05), by = py + Math.sin(a) * (PR - 0.05);
      const d = a + 1.35;
      return [[bx, by], [bx + Math.cos(d) * 0.1, by + Math.sin(d) * 0.1]];
    };

    // rolled cuff at the wrist
    c.beginPath(); roundRect(c, -0.4, -0.2, 0.2, 0.4, 0.09);
    c.strokeStyle = INK; c.lineWidth = OL * 2; c.stroke();
    c.fillStyle = '#fff'; c.fill();
    c.strokeStyle = INK; c.lineWidth = OL * 0.8;
    c.beginPath(); c.moveTo(-0.3, -0.17); c.lineTo(-0.3, 0.17); c.stroke();

    const tc = fs.thumb;
    const thumbOut = tc < 0.45;
    const thumbPts = () => {
      if (tc < 0) {
        // thumbs up: straight out of the side of the fist
        return [[px - 0.02, py - 0.14], [px - 0.04, py - 0.36], [px - 0.03, py - 0.52]];
      }
      const d = -1.2 + tc * 0.8;
      const bx = px - 0.06 + Math.cos(-1.9) * 0.12, by = py + Math.sin(-1.9) * 0.12;
      const L = 0.3 * (1 - 0.35 * tc);
      return [[bx, by], [bx + Math.cos(d) * L * 0.6, by + Math.sin(d) * L * 0.6], [bx + Math.cos(d + 0.2) * L, by + Math.sin(d + 0.2) * L]];
    };
    if (thumbOut) tube(thumbPts(), 0.22);

    // straight fingers behind the palm, last finger first so the index sits on top
    for (let i = FINGERS.length - 1; i >= 0; i--) {
      if (fs.curl[i] >= 0.6) continue;
      const f = FINGERS[i];
      tube(straight(f.base * (0.8 + 0.2 * fs.spread), f.dir * fs.spread + (fs.dir[i] || 0), f.len * (i === 0 ? fs.reach : 1), fs.curl[i]), f.w);
    }

    // puffy palm
    c.beginPath(); c.ellipse(px, py, PR, PR * 1.02, 0, 0, TAU);
    c.strokeStyle = INK; c.lineWidth = OL * 2; c.stroke();
    c.fillStyle = '#fff'; c.fill();
    c.fillStyle = 'rgba(150,160,225,0.2)';
    c.beginPath(); c.ellipse(px - 0.03, py + 0.1, 0.2, 0.13, 0, 0, Math.PI); c.fill();

    // folded fingers: a knuckle row on top of the palm
    for (let i = FINGERS.length - 1; i >= 0; i--) {
      if (fs.curl[i] < 0.6) continue;
      tube(knuckle(FINGERS[i].base), 0.2);
    }
    // back-of-glove stitching (hidden under a fist's thumb)
    if (thumbOut) {
      c.strokeStyle = INK; c.lineWidth = 0.032;
      for (let k = -1; k <= 1; k++) { c.beginPath(); c.moveTo(-0.1, py + k * 0.075); c.lineTo(0.04, py + k * 0.085); c.stroke(); }
    }
    // folded thumb wraps across the front
    if (!thumbOut) {
      const a = [px - 0.14, py - 0.2], b = [px + 0.06, py - 0.08], e = [px + 0.2, py + 0.02];
      tube([a, b, e], 0.19);
    }
    c.restore();
  }

  /** Little Mary-Jane shoe. */
  function drawShoe(c, x, y, size, side, legAng) {
    c.save();
    c.translate(x, y);
    const tilt = clamp((legAng - Math.PI / 2) * 0.5, -0.6, 0.6);
    c.rotate(tilt);
    c.scale(size * side, size);
    c.lineJoin = 'round';
    const body = () => {
      c.beginPath();
      c.moveTo(-0.35, -0.18);
      c.quadraticCurveTo(-0.45, 0.18, -0.2, 0.26);
      c.lineTo(0.5, 0.26);
      c.quadraticCurveTo(0.78, 0.2, 0.62, -0.02);
      c.quadraticCurveTo(0.45, -0.22, 0.12, -0.2);
      c.closePath();
    };
    c.strokeStyle = INK; c.lineWidth = 0.2;
    body(); c.stroke();
    const g = c.createLinearGradient(0, -0.2, 0, 0.26);
    g.addColorStop(0, PINK_HI); g.addColorStop(1, PINK_LO);
    c.fillStyle = g; body(); c.fill();
    c.fillStyle = '#fff';
    c.beginPath(); c.moveTo(-0.3, 0.18); c.lineTo(0.58, 0.18); c.quadraticCurveTo(0.62, 0.26, 0.5, 0.28); c.lineTo(-0.2, 0.28); c.closePath(); c.fill();
    c.strokeStyle = INK; c.lineWidth = 0.09; c.lineCap = 'round';
    c.beginPath(); c.moveTo(-0.05, -0.2); c.quadraticCurveTo(0.12, -0.08, 0.3, -0.16); c.stroke();
    c.fillStyle = '#fff';
    c.beginPath(); c.arc(0.3, -0.15, 0.06, 0, TAU); c.fill();
    c.fillStyle = 'rgba(255,255,255,0.7)';
    c.beginPath(); c.ellipse(0.4, -0.05, 0.1, 0.04, -0.3, 0, TAU); c.fill();
    c.restore();
  }

  function drawMini(c, x, y, r, hue, alpha) {
    if (r < 0.5 || alpha <= 0) return;
    const g = c.createRadialGradient(x - r * 0.25, y - r * 0.3, r * 0.1, x, y, r);
    g.addColorStop(0, `hsla(${hue},100%,96%,${0.04 * alpha})`);
    g.addColorStop(0.7, `hsla(${hue + 40},100%,82%,${0.14 * alpha})`);
    g.addColorStop(0.93, `hsla(${hue + 90},100%,72%,${0.65 * alpha})`);
    g.addColorStop(1, `hsla(${hue + 140},100%,70%,0)`);
    c.fillStyle = g;
    c.beginPath(); c.arc(x, y, r, 0, TAU); c.fill();
    c.strokeStyle = `rgba(26,29,74,${0.28 * alpha})`; c.lineWidth = 1;
    c.stroke();
    c.fillStyle = `rgba(255,255,255,${0.85 * alpha})`;
    c.beginPath(); c.ellipse(x - r * 0.38, y - r * 0.42, r * 0.2, r * 0.11, -0.6, 0, TAU); c.fill();
  }

  function drawSpark(c, x, y, s, rot, color) {
    if (s <= 0.3) return;
    c.save();
    c.translate(x, y); c.rotate(rot);
    c.beginPath();
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 2;
      c.lineTo(Math.cos(a) * s, Math.sin(a) * s);
      c.lineTo(Math.cos(a + Math.PI / 4) * s * 0.28, Math.sin(a + Math.PI / 4) * s * 0.28);
    }
    c.closePath();
    c.fillStyle = color; c.fill();
    c.strokeStyle = INK; c.lineWidth = 1.2; c.stroke();
    c.restore();
  }

  /** Very small lip-sync: open vowels, half-open consonants, closed on spaces/punctuation. */
  function lipPattern(text) {
    const out = [];
    for (const ch of text) {
      if (/\s/.test(ch)) out.push(0.08);
      else if (/[.,!?؟،…]/.test(ch)) out.push(0, 0);
      else if (/[اأإآوىيةaeiouAEIOU]/.test(ch)) out.push(1);
      else if (/[\u{1F300}-\u{1FAFF}☀-➿]/u.test(ch)) out.push(0.3);
      else out.push(0.5);
    }
    return out;
  }

  MissBlupsy.moods = Object.keys(MOODS);
  MissBlupsy.themes = Object.keys(THEMES);
  root.MissBlupsy = MissBlupsy;
  if (typeof module !== 'undefined' && module.exports) module.exports = MissBlupsy;
})(typeof window !== 'undefined' ? window : globalThis);
