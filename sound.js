/*!
 * Miss Blupsy — sound engine
 * Every sound is synthesised live with the Web Audio API (no audio files): bubbly blips, pops,
 * whooshes and giggles. She reads her lines aloud with a neural voice (when the host supplies
 * `tts`), or the most natural voice on the computer, or a bubbly "babble" voice.
 *
 *   const sound = new BlupsySound({ voice: 'speech' });   // 'natural' | 'speech' | 'babble' | 'off'
 *   const blupsy = new MissBlupsy(el, { sound });
 *   document.addEventListener('pointerdown', () => sound.unlock(), { once: true });
 */
(function (root) {
  'use strict';

  const rand = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  // A bright, friendly pentatonic scale for the babble voice (semitones above the base pitch).
  const SCALE = [0, 2, 4, 7, 9, 12, 14];
  const NAP_AFTER_MS = 6000; // silence after which the audio engine goes to sleep
  const VOWELS = /[اأإآوىيةaeiouAEIOU]/;
  const QUIET = /[\s.,!?؟،…:;"'«»()\-]/;
  const EMOJI = /[\u{1F000}-\u{1FAFF}☀-➿️‍]/gu;

  // How each mood colours her voice: pitch multiplier, speed multiplier, loudness, timbre.
  const VOICE_MOOD = {
    idle: { pitch: 1, speed: 1, gain: 1, wave: 'triangle' },
    happy: { pitch: 1.14, speed: 1.12, gain: 1.1, wave: 'triangle' },
    proud: { pitch: 1.06, speed: 1, gain: 1.05, wave: 'triangle' },
    thinking: { pitch: 0.96, speed: 0.9, gain: 0.9, wave: 'triangle' },
    listening: { pitch: 1.04, speed: 1, gain: 0.9, wave: 'triangle' },
    working: { pitch: 1, speed: 1.05, gain: 0.95, wave: 'triangle' },
    bored: { pitch: 0.86, speed: 0.78, gain: 0.8, wave: 'sine' },
    sleeping: { pitch: 0.8, speed: 0.7, gain: 0.45, wave: 'sine' },
    surprised: { pitch: 1.2, speed: 1.1, gain: 1.1, wave: 'triangle' },
    angry: { pitch: 0.82, speed: 1.08, gain: 1.05, wave: 'square' },
    sad: { pitch: 0.88, speed: 0.85, gain: 0.85, wave: 'sine' },
  };

  class BlupsySound {
    constructor(o = {}) {
      this.opt = Object.assign({
        sfx: true,            // bubble sound effects
        voice: 'speech',      // 'natural' (neural voice via opt.tts) | 'speech' (the computer's voice) | 'babble' | 'off'
        tts: null,            // async (text, mood) => ({ data: ArrayBuffer|Uint8Array }) for the natural voice
        sfxVolume: 0.55,
        voiceVolume: 0.7,
        basePitch: 560,       // Hz, a young bright voice
        night: true,          // quieter between 22:00 and 07:00
        lang: null,           // force a speech language, e.g. 'ar-SA'
      }, o);
      this.ctx = null;
      this.muted = false;
      this.mood = 'idle';
      this._last = {};
      this._snoreTimer = null;
      this._clapTimer = null;
      this._talkI = 0;
      this._offset = 0; // seconds added to every scheduled sound (for sequencing / offline renders)
    }

    // ───────────── setup ─────────────

    /** Browsers only allow audio after a user gesture: call this from a click/tap/keypress. */
    unlock() {
      if (!this._ensure()) return;
      this._napping = false;
      if (this.ctx.state === 'suspended') this.ctx.resume();
      this._idleSoon();
    }

    // ───────────── sleeping between sounds ─────────────
    // A running AudioContext keeps the system's audio service (and the sound card) busy even in silence.
    // A few seconds after her last sound it is suspended, and the next sound wakes it first (a few ms).

    /** Run fn with the audio awake (resuming it first if it was put to sleep). */
    _awake(fn) {
      if (!this.ctx) return;
      if (this._napping) {
        this._napping = false;
        clearTimeout(this._napTimer);
        this.ctx.resume().then(() => { fn(); this._idleSoon(); }, () => {});
        return;
      }
      fn();
      this._idleSoon();
    }

    _idleSoon() {
      clearTimeout(this._napTimer);
      this._napTimer = setTimeout(() => this._nap(), NAP_AFTER_MS);
    }

    _nap() {
      const c = this.ctx;
      if (!c || c.state !== 'running' || this._current || this._snoreTimer) return;
      if (root.OfflineAudioContext && c instanceof root.OfflineAudioContext) return; // rendering to a file
      this._napping = true;
      c.suspend().catch(() => { this._napping = false; });
    }

    _ensure() {
      if (this.ctx) return true;
      const AC = root.AudioContext || root.webkitAudioContext;
      if (!AC) return false;
      let c;
      try {
        c = new AC({ latencyHint: 'interactive' });
      } catch {
        return false;
      }
      this._build(c);
      return true;
    }

    /** Build the mixer on an AudioContext (also used with an OfflineAudioContext to render sounds to a file). */
    _build(c) {
      this.ctx = c;
      this.master = c.createGain();
      const comp = c.createDynamicsCompressor();
      comp.threshold.value = -16; comp.knee.value = 12; comp.ratio.value = 4; comp.attack.value = 0.003; comp.release.value = 0.2;
      this.master.connect(comp).connect(c.destination);
      this.sfxBus = c.createGain();
      this.voiceBus = c.createGain();
      this.sfxBus.connect(this.master);
      this.voiceBus.connect(this.master);
      // listen to her voice so the mouth can follow it (an analyser must reach the destination to run)
      this.voiceAnalyser = c.createAnalyser();
      this.voiceAnalyser.fftSize = 512;
      const sink = c.createGain(); sink.gain.value = 0;
      this.voiceBus.connect(this.voiceAnalyser).connect(sink).connect(c.destination);
      // a touch of "room": short feedback delay, only on the sfx bus
      const d = c.createDelay(0.5); d.delayTime.value = 0.09;
      const fb = c.createGain(); fb.gain.value = 0.18;
      const wet = c.createGain(); wet.gain.value = 0.16;
      const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3200;
      this.sfxBus.connect(d); d.connect(lp).connect(fb).connect(d); lp.connect(wet).connect(this.master);
      // one second of white noise, reused by every noisy sound
      const buf = c.createBuffer(1, c.sampleRate, c.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      this.noiseBuf = buf;
      this._applyVolume();
    }

    _applyVolume() {
      if (!this.ctx) return;
      const h = new Date().getHours();
      const night = this.opt.night && (h >= 22 || h < 7) ? 0.5 : 1;
      const m = this.muted ? 0 : night;
      this.master.gain.value = m;
      this.sfxBus.gain.value = this.opt.sfx ? this.opt.sfxVolume : 0;
      this.voiceBus.gain.value = this.opt.voiceVolume;
    }

    set(options) {
      Object.assign(this.opt, options);
      this._applyVolume();
      if (this.opt.voice !== 'speech' && this.opt.voice !== 'natural') this.stopSpeech();
    }
    mute(on = true) { this.muted = on; this._applyVolume(); if (on) { this.stopSpeech(); this._stopLoops(); } }

    // asleep between sounds still counts as ready: the next sound wakes it
    get ready() { return !!this.ctx && (this.ctx.state === 'running' || !!this._napping) && !this.muted; }

    // ───────────── building blocks ─────────────

    /** Gain envelope: attack to peak, then exponential-ish decay to silence. */
    _env(g, t, a, peak, dec) {
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(peak, t + a);
      g.gain.setTargetAtTime(0.0001, t + a, dec / 4);
    }

    _tone({ type = 'sine', f0, f1, t = 0, dur = 0.12, peak = 0.3, a = 0.004, bus, vib = 0, vibRate = 0, filter = null }) {
      const c = this.ctx;
      const t0 = c.currentTime + t + this._offset;
      const o = c.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(f0, t0);
      if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
      const g = c.createGain();
      this._env(g, t0, a, peak, dur);
      let node = o;
      if (vib) {
        const l = c.createOscillator(); const lg = c.createGain();
        l.frequency.value = vibRate; lg.gain.value = vib;
        l.connect(lg).connect(o.frequency); l.start(t0); l.stop(t0 + dur + 0.3);
      }
      if (filter) {
        const fl = c.createBiquadFilter();
        fl.type = filter.type; fl.frequency.value = filter.f; fl.Q.value = filter.q || 1;
        node.connect(fl); node = fl;
      }
      node.connect(g).connect(bus || this.sfxBus);
      o.start(t0); o.stop(t0 + dur + 0.35);
    }

    _noise({ t = 0, dur = 0.1, peak = 0.3, a = 0.003, type = 'bandpass', f0 = 2000, f1 = null, q = 1, bus }) {
      const c = this.ctx;
      const t0 = c.currentTime + t + this._offset;
      const s = c.createBufferSource();
      s.buffer = this.noiseBuf;
      s.loop = true;
      const fl = c.createBiquadFilter();
      fl.type = type; fl.Q.value = q;
      fl.frequency.setValueAtTime(f0, t0);
      if (f1) fl.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
      const g = c.createGain();
      this._env(g, t0, a, peak, dur);
      s.connect(fl).connect(g).connect(bus || this.sfxBus);
      s.start(t0, Math.random() * 0.5); s.stop(t0 + dur + 0.35);
    }

    /** Rate limit: at most one `name` every `ms`. */
    _gate(name, ms) {
      const t = now();
      if (this._last[name] && t - this._last[name] < ms) return false;
      this._last[name] = t;
      return true;
    }

    // ───────────── the sound palette ─────────────

    /** Called by the character engine for every event. */
    play(name, d = {}) {
      if (name === 'mood') return this._moodChange(d.name, d.prev);
      if (!this.opt.sfx || !this.ready) return;
      const fn = this['_' + name];
      if (fn) this._awake(() => fn.call(this, d));
    }

    // a bubble being born: rising, liquid "blup"
    _blup({ size = 1, t = 0 } = {}) {
      const f = rand(320, 420) / Math.sqrt(size);
      this._tone({ type: 'sine', f0: f, f1: f * 2.6, t, dur: 0.1, peak: 0.32 * Math.min(1, size) + 0.05 });
      this._tone({ type: 'sine', f0: f * 2, f1: f * 4.2, t: t + 0.012, dur: 0.07, peak: 0.08 });
    }
    // tiny bubble popping
    _tinypop() {
      if (!this._gate('tinypop', 60)) return;
      this._tone({ type: 'sine', f0: rand(1500, 2100), f1: 700, dur: 0.035, peak: 0.1 });
      this._noise({ dur: 0.02, peak: 0.06, f0: 4000, q: 1.2 });
    }
    // her bubble popping out of sight
    _pop() {
      this._noise({ dur: 0.05, peak: 0.45, f0: 2400, f1: 900, q: 0.9 });
      this._tone({ type: 'sine', f0: 1400, f1: 300, dur: 0.06, peak: 0.35 });
      for (let i = 0; i < 4; i++) this._tone({ type: 'sine', f0: rand(1800, 2600), f1: 900, t: 0.03 + i * 0.025, dur: 0.03, peak: 0.07 });
    }
    // her signature "بُب!": two quick rising blips
    _bub({ t = 0 } = {}) {
      this._tone({ type: 'sine', f0: 480, f1: 760, t, dur: 0.06, peak: 0.36 });
      this._tone({ type: 'sine', f0: 760, f1: 1180, t: t + 0.075, dur: 0.08, peak: 0.4 });
      this._tone({ type: 'triangle', f0: 1520, f1: 2360, t: t + 0.075, dur: 0.06, peak: 0.06 });
    }
    // flying: filtered air, plus a slide whistle when she moves cartoon-style
    _fly({ dist = 300, dur = 0.5, style = 'soft' } = {}) {
      if (!this._gate('fly', 120)) return;
      const k = clamp(dist / 900, 0.15, 1);
      const len = clamp(dur, 0.18, 1.6);
      this._noise({ dur: len, peak: 0.24 * k + 0.06, a: len * 0.35, f0: 350, f1: 1700, q: 0.7 });
      if (style === 'cartoon') this._tone({ type: 'sine', f0: 500, f1: 1300, dur: len * 0.8, peak: 0.1 * k + 0.03, a: 0.03, vib: 12, vibRate: 7 });
    }
    // landing: soft squish
    _land({ impact = 400 } = {}) {
      if (impact < 250 || !this._gate('land', 150)) return;
      const k = clamp(impact / 2000, 0.1, 1);
      this._tone({ type: 'sine', f0: 210, f1: 120, dur: 0.07, peak: 0.25 * k });
      this._noise({ dur: 0.05, peak: 0.08 * k, type: 'lowpass', f0: 900 });
    }
    // tapping something
    _tap() {
      this._tone({ type: 'sine', f0: 2300, f1: 1500, dur: 0.02, peak: 0.28 });
      this._noise({ dur: 0.015, peak: 0.1, type: 'highpass', f0: 3000 });
      this._tone({ type: 'sine', f0: 620, f1: 900, t: 0.01, dur: 0.05, peak: 0.12 });
    }
    // bouncing off the edge of the screen
    _boing({ impact = 800 } = {}) {
      if (!this._gate('boing', 90)) return;
      const k = clamp(impact / 2500, 0.2, 1);
      this._tone({ type: 'sine', f0: 280, f1: 150, dur: 0.32, peak: 0.3 * k, vib: 55, vibRate: 17 });
    }
    // giggle when poked
    _giggle() {
      if (!this._gate('giggle', 300)) return;
      const b = this.opt.basePitch * 1.3;
      [0, 3, 1, 4, 2].forEach((s, i) => this._tone({ type: 'triangle', f0: b * Math.pow(2, s / 12), f1: b * Math.pow(2, (s + 2) / 12), t: i * 0.065, dur: 0.05, peak: 0.16, vib: 25, vibRate: 30, bus: this.voiceBus }));
    }
    // sparkles when happy
    _sparkle() {
      if (!this._gate('sparkle', 350)) return;
      const f = rand(2200, 3400);
      this._tone({ type: 'sine', f0: f, dur: 0.18, peak: 0.05 });
      this._tone({ type: 'sine', f0: f * 1.5, t: 0.06, dur: 0.15, peak: 0.035 });
    }
    // bored sigh: air out, voice down
    _sigh() {
      if (!this._gate('sigh', 2500)) return;
      this._noise({ dur: 0.9, peak: 0.1, a: 0.25, type: 'lowpass', f0: 1100, f1: 300, bus: this.voiceBus });
      this._tone({ type: 'sine', f0: this.opt.basePitch * 0.62, f1: this.opt.basePitch * 0.42, t: 0.05, dur: 0.7, peak: 0.07, a: 0.12, bus: this.voiceBus });
    }
    // one snore: breathe in, bubbly breath out
    _snore() {
      this._noise({ dur: 1.0, peak: 0.07, a: 0.5, type: 'bandpass', f0: 300, f1: 700, q: 0.8, bus: this.voiceBus });
      this._tone({ type: 'sine', f0: 95, f1: 80, t: 1.15, dur: 0.9, peak: 0.12, a: 0.1, vib: 18, vibRate: 22, bus: this.voiceBus });
      this._tone({ type: 'sine', f0: rand(500, 700), f1: 1300, t: 2.0, dur: 0.08, peak: 0.08 });
    }
    // "woop!"
    _surprise() {
      this._tone({ type: 'triangle', f0: this.opt.basePitch * 0.8, f1: this.opt.basePitch * 2.2, dur: 0.14, peak: 0.22, bus: this.voiceBus });
    }
    // "hmph!"
    _hmph() {
      this._tone({ type: 'sawtooth', f0: 190, f1: 140, dur: 0.2, peak: 0.16, filter: { type: 'lowpass', f: 800 }, bus: this.voiceBus });
      this._noise({ dur: 0.18, peak: 0.08, type: 'lowpass', f0: 700, bus: this.voiceBus });
    }
    // a little sad "aww"
    _aww() {
      this._tone({ type: 'sine', f0: this.opt.basePitch * 1.05, f1: this.opt.basePitch * 0.72, dur: 0.45, peak: 0.14, a: 0.05, vib: 10, vibRate: 6, bus: this.voiceBus });
    }
    // task done: bubbly arpeggio then her "بُب"
    _done() {
      [523, 659, 784, 1047].forEach((f, i) => this._tone({ type: 'triangle', f0: f * 0.97, f1: f * 1.03, t: i * 0.07, dur: 0.1, peak: 0.13 }));
      this._bub({ t: 0.3 });
    }
    // hello: rising blups · bye: falling blups
    _hello() { [0, 1, 2, 3].forEach((i) => this._blup({ size: 1.3 - i * 0.25, t: i * 0.09 })); }
    _bye() { [12, 7, 4, 0].forEach((s, i) => this._tone({ type: 'sine', f0: 800 * Math.pow(2, s / 12), f1: 400 * Math.pow(2, s / 12), t: i * 0.09, dur: 0.09, peak: 0.2 })); }
    // a question with buttons: two notes going up
    _ask() {
      this._tone({ type: 'sine', f0: 660, dur: 0.12, peak: 0.12 });
      this._tone({ type: 'sine', f0: 990, t: 0.11, dur: 0.18, peak: 0.12 });
    }
    // reminder chime: three soft xylophone notes
    _remind() {
      [784, 659, 1047].forEach((f, i) => {
        this._tone({ type: 'sine', f0: f, t: i * 0.16, dur: 0.5, peak: 0.2 });
        this._tone({ type: 'sine', f0: f * 3, t: i * 0.16, dur: 0.12, peak: 0.04 });
      });
    }
    // circling a mistake: pencil scribble
    _scribble({ dur = 0.6 } = {}) {
      const c = this.ctx;
      const t0 = c.currentTime + this._offset;
      const s = c.createBufferSource(); s.buffer = this.noiseBuf; s.loop = true;
      const hp = c.createBiquadFilter(); hp.type = 'bandpass'; hp.frequency.value = 3800; hp.Q.value = 0.9;
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      for (let i = 0; i < 12; i++) {
        const tt = t0 + (i / 12) * dur;
        g.gain.linearRampToValueAtTime(rand(0.1, 0.2), tt + 0.012);
        g.gain.linearRampToValueAtTime(0.02, tt + dur / 12);
      }
      g.gain.linearRampToValueAtTime(0.0001, t0 + dur + 0.05);
      s.connect(hp).connect(g).connect(this.sfxBus);
      s.start(t0); s.stop(t0 + dur + 0.1);
    }
    // one clap
    _clap() {
      this._noise({ dur: 0.07, peak: 0.55, a: 0.002, f0: 1300, q: 0.7 });
      this._noise({ t: 0.008, dur: 0.05, peak: 0.28, f0: 2600, q: 1.5 });
    }
    // clapping for a while (hands meet about every 0.39 s in the clap pose)
    _clapping({ ms = 1200 } = {}) {
      clearInterval(this._clapTimer);
      const end = now() + ms;
      this._clap();
      this._clapTimer = setInterval(() => {
        if (now() > end || !this.ready) { clearInterval(this._clapTimer); return; }
        this._awake(() => this._clap());
      }, 393);
    }
    // grabbing / dropping a file
    _grab() { this._tone({ type: 'sine', f0: 700, f1: 520, dur: 0.06, peak: 0.12 }); }
    _drop() { this._tone({ type: 'sine', f0: 520, f1: 260, dur: 0.1, peak: 0.16 }); this._noise({ t: 0.05, dur: 0.04, peak: 0.06, type: 'lowpass', f0: 1200 }); }

    // ───────────── moods: one-shot reactions and the snore loop ─────────────

    _moodChange(name, prev) {
      this.mood = name || 'idle';
      if (name === 'sleeping') this._startSnore(); else this._stopSnore();
      if (!this.opt.sfx || !this.ready || name === prev) return;
      const fn = { surprised: this._surprise, angry: this._hmph, sad: this._aww, bored: this._sigh }[name];
      if (fn) this._awake(() => fn.call(this));
    }

    _startSnore() {
      if (this._snoreTimer) return;
      this._snoreTimer = setInterval(() => { if (this.opt.sfx && this.ready) this._awake(() => this._snore()); }, 3600);
    }
    _stopSnore() { clearInterval(this._snoreTimer); this._snoreTimer = null; this._idleSoon(); }
    _stopLoops() { this._stopSnore(); clearInterval(this._clapTimer); }

    // ───────────── her voice ─────────────

    /**
     * Start saying a line out loud (voice 'natural' or 'speech'). Returns null when she should not speak
     * (babble/off/muted/unsupported), otherwise a handle:
     *   { kind: 'natural' | 'speech', cleanLength,
     *     started: Promise<number|null>   resolves when sound starts (audio length in seconds when known),
     *     done: Promise<void>             resolves when she stops talking,
     *     onBoundary: null | (charIndex) => void   set by the caller to follow word boundaries }
     */
    speakLine(text, mood) {
      if (this.muted) return null;
      const mode = this.opt.voice;
      if (mode !== 'speech' && mode !== 'natural') return null;
      const hasBub = BUB.test(text);
      const clean = cleanForSpeech(text);
      if (!clean) { if (hasBub) this.play('bub'); return null; }
      if (mode === 'natural' && typeof this.opt.tts === 'function' && this._ensure()) return this._speakNatural(clean, mood, hasBub);
      return this._speakSystem(clean, mood, hasBub);
    }

    _handle(kind, cleanLength) {
      const h = { kind, cleanLength, onBoundary: null, stopped: false };
      h.started = new Promise((r) => { h._start = r; });
      h.done = new Promise((r) => { h._done = r; });
      return h;
    }

    /** Neural voice: the host's tts(text, mood) returns encoded audio; it plays through the analyser so her mouth follows it. */
    _speakNatural(clean, mood, hasBub) {
      this.stopSpeech();
      const h = this._handle('natural', clean.length);
      this._current = h;
      (async () => {
        try {
          const res = await this.opt.tts(clean, mood);
          if (h.stopped) { h._start(null); h._done(); return; }
          if (!res || !res.data) throw new Error('no audio');
          const bytes = res.data instanceof ArrayBuffer ? res.data : res.data.buffer.slice(res.data.byteOffset, res.data.byteOffset + res.data.byteLength);
          const buf = await this.ctx.decodeAudioData(bytes);
          if (h.stopped) { h._start(null); h._done(); return; }
          this._napping = false;
          clearTimeout(this._napTimer);
          if (this.ctx.state === 'suspended') await this.ctx.resume();
          const src = this.ctx.createBufferSource();
          src.buffer = buf;
          const g = this.ctx.createGain();
          g.gain.value = 1.6; // speech sits a little louder than the bubble sounds
          src.connect(g).connect(this.voiceBus);
          h.source = src;
          src.onended = () => {
            if (hasBub && !h.stopped) this.play('bub');
            if (this._current === h) this._current = null;
            h._done();
            this._idleSoon();
          };
          src.start();
          h._start(buf.duration);
        } catch (e) {
          if (h.stopped) { h._start(null); h._done(); return; }
          // no key, no internet, provider error: fall back to the computer's own voice
          const s = this._speakSystem(clean, mood, hasBub);
          if (!s) { h._start(null); h._done(); return; }
          h.kind = 'speech';
          s.onBoundary = (i) => { if (h.onBoundary) h.onBoundary(i); };
          s.started.then(h._start);
          s.done.then(h._done);
        }
      })();
      return h;
    }

    /** The computer's own speech voices, tuned to sound natural rather than cartoonish. */
    _speakSystem(clean, mood, hasBub) {
      const synth = root.speechSynthesis;
      if (!synth || typeof root.SpeechSynthesisUtterance === 'undefined') return null;
      this.stopSpeech();
      const lang = this.opt.lang || detectLang(clean, userLocale());
      const u = new root.SpeechSynthesisUtterance(clean);
      u.lang = lang;
      const voices = this._voices();
      const voice = pickVoice(voices, lang);
      // no voice for this language on the computer (an English Windows has no Arabic one): another
      // language's voice would read it badly or not at all, so the words stay in the bubble only
      if (!voice && voices.length) {
        if (typeof this.opt.onNoVoice === 'function' && !this._noVoiceSaid) { this._noVoiceSaid = true; try { this.opt.onNoVoice(lang); } catch (e) { /* only a notice */ } }
        if (hasBub) this.play('bub');
        return null;
      }
      if (voice) { u.voice = voice; u.lang = voice.lang || lang; }
      const m = VOICE_MOOD[mood] || VOICE_MOOD.idle;
      // gentle mood colour only: big pitch shifts are what make system voices sound robotic
      u.pitch = clamp(1.04 + (m.pitch - 1) * 0.45, 0.85, 1.25);
      u.rate = clamp(1.0 + (m.speed - 1) * 0.45, 0.85, 1.2);
      u.volume = clamp(this.opt.voiceVolume * Math.min(1, m.gain) * 1.2, 0, 1);
      const h = this._handle('speech', clean.length);
      this._current = h;
      let started = false;
      u.onstart = () => { started = true; h._start(null); };
      u.onboundary = (e) => { if (h.onBoundary && typeof e.charIndex === 'number') h.onBoundary(e.charIndex); };
      const finish = () => { if (hasBub && !h.stopped) this.play('bub'); if (this._current === h) this._current = null; h._start(null); h._done(); };
      u.onend = finish;
      u.onerror = finish;
      synth.cancel();
      synth.speak(u);
      // some systems never fire onstart (no voices installed): don't leave the caller waiting
      setTimeout(() => { if (!started) h._start(null); }, 1500);
      setTimeout(() => { h._start(null); h._done(); }, 1500 + clean.length * 120);
      return h;
    }

    _voices() {
      const synth = root.speechSynthesis;
      if (!synth) return [];
      if (!this._voiceList || !this._voiceList.length) {
        this._voiceList = synth.getVoices();
        if (!this._voiceHook && synth.addEventListener) {
          this._voiceHook = true;
          synth.addEventListener('voiceschanged', () => { this._voiceList = synth.getVoices(); });
        }
      }
      return this._voiceList || [];
    }

    /** The computer voice she would use for a language (for settings screens). */
    systemVoice(lang = 'ar-SA') { const v = pickVoice(this._voices(), lang); return v ? { name: v.name, lang: v.lang } : null; }

    /** Called for every character as the speech bubble types out (babble mode). */
    talk(ch, mood) {
      if (this.muted || this.opt.voice !== 'babble' || !this.ready) return;
      if (QUIET.test(ch) || EMOJI.test(ch)) { EMOJI.lastIndex = 0; return; }
      this._talkI++;
      if (this._talkI % 2) return; // one blip every other letter reads as syllables
      const m = VOICE_MOOD[mood] || VOICE_MOOD.idle;
      const code = ch.codePointAt(0) || 0;
      const step = SCALE[(code * 7 + this._talkI) % SCALE.length];
      const f = this.opt.basePitch * m.pitch * Math.pow(2, step / 12) * rand(0.98, 1.02);
      const open = VOWELS.test(ch);
      const dur = (open ? 0.075 : 0.055) / m.speed;
      this._awake(() => this._blip(f, open, dur, m));
    }

    _blip(f, open, dur, m) {
      this._tone({
        type: m.wave, f0: f * 0.94, f1: f * (open ? 1.08 : 1.02), dur, peak: (open ? 0.24 : 0.18) * m.gain,
        a: 0.006, bus: this.voiceBus, filter: { type: 'bandpass', f: f * 2.2, q: 0.9 },
      });
      // a faint formant so it sounds like a little voice rather than a beep
      this._tone({ type: 'sine', f0: f * 2.01, dur: dur * 0.8, peak: 0.03 * m.gain, bus: this.voiceBus });
    }

    /** How loud her voice is right now, 0…1 (neural audio and babble; the mouth follows it). */
    level() {
      const a = this.voiceAnalyser;
      if (!a || !this.ready) return 0;
      if (!this._lvlBuf) this._lvlBuf = new Float32Array(a.fftSize);
      a.getFloatTimeDomainData(this._lvlBuf);
      let sq = 0;
      for (let i = 0; i < this._lvlBuf.length; i++) sq += this._lvlBuf[i] * this._lvlBuf[i];
      const rms = Math.sqrt(sq / this._lvlBuf.length);
      return clamp((rms - 0.004) * 9, 0, 1);
    }

    stopSpeech() {
      const h = this._current;
      if (h) {
        h.stopped = true;
        if (h.source) { try { h.source.stop(); } catch (e) { /* already stopped */ } }
        if (h._start) h._start(null);
        if (h._done) h._done();
        this._current = null;
      }
      if (root.speechSynthesis) root.speechSynthesis.cancel();
    }
  }

  /** The user's own locale, e.g. 'en-GB', 'fr-FR', 'ar-SA'. */
  function userLocale() {
    const n = root.navigator;
    return (n && (n.languages && n.languages[0] || n.language)) || 'en-US';
  }

  /**
   * Guess the language of a line from its script, so she speaks every language with a matching voice.
   * Latin-script text (English, French, Spanish, Turkish…) can't be told apart by letters alone,
   * so it follows the user's own locale when that is a Latin-script language.
   */
  function detectLang(text, locale = 'en-US') {
    const t = String(text || '');
    const has = (re) => re.test(t);
    if (has(/[\u0600-\u06FF]/)) {
      if (has(/[ٹڈڑںےۓ]/)) return 'ur';
      if (has(/[پچژگکی]/) && !has(/[ةى]/)) return 'fa';
      return 'ar';
    }
    if (has(/[\u0590-\u05FF]/)) return 'he';
    if (has(/[\u3040-\u30FF]/)) return 'ja';
    if (has(/[\uAC00-\uD7AF]/)) return 'ko';
    if (has(/[\u4E00-\u9FFF]/)) return 'zh';
    if (has(/[\u0400-\u04FF]/)) return locale.startsWith('uk') ? 'uk' : 'ru';
    if (has(/[\u0370-\u03FF]/)) return 'el';
    if (has(/[\u0900-\u097F]/)) return 'hi';
    if (has(/[\u0980-\u09FF]/)) return 'bn';
    if (has(/[\u0B80-\u0BFF]/)) return 'ta';
    if (has(/[\u0E00-\u0E7F]/)) return 'th';
    if (has(/[\u10A0-\u10FF]/)) return 'ka';
    if (has(/[\u0530-\u058F]/)) return 'hy';
    const latin = /^(en|fr|es|pt|de|it|nl|tr|id|ms|sv|no|nb|da|fi|pl|cs|sk|ro|hu|vi|tl|sw|hr|sl|lt|lv|et|ca)/i;
    return latin.test(locale) ? locale : 'en-US';
  }

  // her sign-off in each language ("بُب!", "Bub!", "Бульк!", "啵！"…): played as a bubble sound, not spoken
  const BUB = /(بُب|\bBub\b|Бульк|啵|ぷくっ|뽁)/;
  const BUB_ALL = /(بُب|\bBub\b|Бульк|啵|ぷくっ|뽁)\s*[!！]?/g;

  function cleanForSpeech(text) {
    const s = String(text || '').replace(EMOJI, '').replace(BUB_ALL, '').replace(/[«»"]/g, '').replace(/\s+/g, ' ').trim();
    EMOJI.lastIndex = 0;
    return s;
  }

  /**
   * Choose the most natural-sounding voice for a language: neural / premium / enhanced voices first,
   * then female voices; never the novelty or robotic ones. No regional accent is preferred.
   */
  function pickVoice(voices, lang) {
    if (!voices || !voices.length) return null;
    const base = lang.slice(0, 2).toLowerCase();
    // the user's own region for that language (a British user hears a British voice), never a fixed one
    const loc = userLocale().toLowerCase().replace('_', '-');
    const wantRegion = loc.startsWith(base) ? loc : (lang.length > 2 ? lang.toLowerCase() : '');
    const natural = /(natural|neural|premium|enhanced|siri|online|wavenet|studio)/i;
    const female = /(female|woman|hoda|laila|leila|mariam|maryam|salma|zariyah|amira|hala|noura|fatima|amal|samantha|zira|aria|jenny|ava|allison|susan|karen|moira|tessa|victoria|serena|emma|sonia|libby|google.*(us|uk) english)/i;
    const robotic = /(compact|eloquence|novelty|whisper|bad news|bells|boing|bubbles|cellos|zarvox|trinoids|albert|jester|organ|superstar|wobble|grandma|grandpa|rocko|shelley|flo\b|reed|sandy|eddy|espeak)/i;
    let best = null, bestScore = -Infinity;
    for (const v of voices) {
      const vl = (v.lang || '').toLowerCase().replace('_', '-');
      if (!vl.startsWith(base)) continue;
      let sc = 0;
      if (wantRegion && vl === wantRegion) sc += 15;
      if (natural.test(v.name)) sc += 30;
      if (female.test(v.name)) sc += 20;
      if (robotic.test(v.name)) sc -= 60;
      if (v.localService) sc += 3;
      if (sc > bestScore) { bestScore = sc; best = v; }
    }
    return best;
  }

  BlupsySound.pickVoice = pickVoice;
  BlupsySound.cleanForSpeech = cleanForSpeech;
  BlupsySound.detectLang = detectLang;

  root.BlupsySound = BlupsySound;
  if (typeof module !== 'undefined' && module.exports) module.exports = BlupsySound;
})(typeof window !== 'undefined' ? window : globalThis);
