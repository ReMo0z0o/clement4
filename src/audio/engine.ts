/**
 * Castle Siege — moteur audio entièrement procédural.
 *
 * Aucun fichier son, aucun `fetch`, aucun base64 : chaque bruit est fabriqué à
 * la volée avec des oscillateurs, du bruit blanc ou brun et des filtres. Le son
 * est un canal de jeu (§10), pas une décoration :
 *
 *  - le Châtelain doit reconnaître QUEL piège a mordu et OÙ, sans entrer en
 *    Scrutation. Les six pièges ont donc des timbres franchement différents ;
 *  - l'Envahisseur navigue au battement du Cœur, sans minimap. La période du
 *    battement est sa seule boussole de distance.
 *
 * Contraintes techniques :
 *  - rien ne touche `window` ni `AudioContext` au chargement du module (SSR) ;
 *    le contexte naît dans `resume()`, sur un geste du joueur ;
 *  - avant `resume()`, toutes les méthodes ne font rien (elles mémorisent
 *    seulement l'état pour l'appliquer au démarrage) ;
 *  - 24 voix simultanées au maximum : au-delà on coupe la plus ancienne, ce qui
 *    s'entend beaucoup moins qu'un hoquet ;
 *  - un balayage périodique débranche les nœuds terminés : une manche de trois
 *    minutes ne doit rien accumuler.
 */

import { CFG } from '@/game/config';
import {
  clamp,
  lerp,
  type DeviceKind,
  type GameEvent,
  type Role,
  type TrapKind,
} from '@/game/types';

/* ==================================================================== */
/* Constantes de spatialisation                                         */
/* ==================================================================== */

/** Au-delà de cette distance, en tuiles, un son n'existe plus. */
const AUDIBLE_MAX = 14;
/** Échelle d'atténuation : la portée de vue de l'Envahisseur sert de repère. */
const AUDIBLE_REF = CFG.vision.invaderRange;
/** Voix simultanées. La plus ancienne cède la place. */
const MAX_VOICES = 24;
/** Fenêtre d'anticipation du séquenceur, en secondes. */
const LOOKAHEAD = 0.14;
/** Période du balayage de ménage et du séquenceur, en millisecondes. */
const SWEEP_MS = 40;

/**
 * Une voix vivante : sa racine, ses sources (avec leur instant de départ, pour
 * ne jamais leur demander de s'arrêter avant d'avoir commencé) et sa fin.
 */
interface Voice {
  root: GainNode;
  /** Panoramique éventuel, entre la racine et le bus. À débrancher aussi. */
  pan: StereoPannerNode | null;
  srcs: { node: AudioScheduledSourceNode; at: number }[];
  end: number;
}

/** Établi de travail d'un son : tout ce qu'il faut pour poser des nœuds. */
interface Bench {
  ctx: AudioContext;
  /** Instant de départ du son, en temps de contexte. */
  t: number;
  /** Nœud de sortie de la voix, déjà panoramiqué et atténué. */
  out: GainNode;
  osc(type: OscillatorType, freq: number, start: number, stop: number): OscillatorNode;
  noise(start: number, stop: number, kind?: 'white' | 'brown', rate?: number): AudioBufferSourceNode;
}

/** Atténuation par la distance, en tuiles. Douce près, nulle au loin. */
function attenuate(d: number): number {
  if (d >= AUDIBLE_MAX) return 0;
  const roll = 1 / (1 + (d / (AUDIBLE_REF * 0.42)) ** 1.85);
  // Fondu final : rien ne doit s'arrêter net à la limite d'audibilité.
  const edge = clamp((AUDIBLE_MAX - d) / 3.5, 0, 1);
  return roll * edge;
}

export class AudioEngine {
  /* --- Contexte et bus. Tout est `null` avant `resume()`. --- */
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private uiBus: GainNode | null = null;
  private heartBus: GainNode | null = null;
  private ambBus: GainNode | null = null;
  /** Teinte de palette : chaude et large, ou froide et resserrée (§DA 4). */
  private toneLow: BiquadFilterNode | null = null;
  private toneHigh: BiquadFilterNode | null = null;

  private whiteBuf: AudioBuffer | null = null;
  private brownBuf: AudioBuffer | null = null;

  private voices: Voice[] = [];
  /** Voix sacrifiées au plafond de polyphonie : on les débranche au balayage. */
  private dying: Voice[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private starting: Promise<void> | null = null;
  private dead = false;
  private mute = false;

  /* --- Écoute --- */
  private lx = 0;
  private ly = 0;
  private lrole: Role = 'invader';

  /* --- Battement du Cœur --- */
  private hbDist = Infinity;
  private hbTimeLeft = Infinity;
  private hbAlarm = false;
  private hbNext = 0;
  private hbLast = -99;

  /* --- Ambiance --- */
  private ambRole: Role | null = null;
  private ambAlarm = false;
  private ambBuilt = false;
  /** Les six oscillateurs du bourdon : ce sont les seuls qu'on retend. */
  private ambDrone: OscillatorNode[] = [];
  /** Toutes les sources de l'ambiance, à arrêter à la fermeture. */
  private ambNodes: AudioScheduledSourceNode[] = [];
  private ambDroneGain: GainNode | null = null;
  private ambWindFilter: BiquadFilterNode | null = null;
  private ambCalmGain: GainNode | null = null;
  private ambAlarmGain: GainNode | null = null;

  /* ================================================================== */
  /* Cycle de vie                                                       */
  /* ================================================================== */

  /**
   * À appeler sur le premier geste du joueur. Appelable deux fois sans dégât :
   * si le contexte existe déjà, on se contente de le réveiller.
   */
  resume(): Promise<void> {
    if (this.dead) return Promise.resolve();
    if (this.ctx) {
      if (this.ctx.state === 'running') return Promise.resolve();
      return this.ctx.resume().catch(() => undefined);
    }
    if (!this.starting) {
      this.starting = this.boot().finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  private async boot(): Promise<void> {
    if (typeof window === 'undefined') return;
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;

    let ctx: AudioContext;
    try {
      ctx = new Ctor();
    } catch {
      return;
    }
    if (this.dead) {
      ctx.close().catch(() => undefined);
      return;
    }
    this.ctx = ctx;

    // Limiteur de sortie : garde-fou, rien ne doit jamais faire mal.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 14;
    comp.ratio.value = 8;
    comp.attack.value = 0.003;
    comp.release.value = 0.25;
    comp.connect(ctx.destination);

    const master = ctx.createGain();
    master.gain.value = this.mute ? 0 : CFG.audio.master;
    master.connect(comp);
    this.master = master;

    // Teinte de palette appliquée aux seuls sons du monde.
    const low = ctx.createBiquadFilter();
    low.type = 'lowshelf';
    low.frequency.value = 320;
    low.gain.value = 0;
    const high = ctx.createBiquadFilter();
    high.type = 'peaking';
    high.frequency.value = 3200;
    high.Q.value = 0.9;
    high.gain.value = 0;
    low.connect(high);
    high.connect(master);
    this.toneLow = low;
    this.toneHigh = high;

    const sfx = ctx.createGain();
    sfx.gain.value = 1;
    sfx.connect(low);
    this.sfxBus = sfx;

    const ui = ctx.createGain();
    ui.gain.value = 0.85;
    ui.connect(master);
    this.uiBus = ui;

    const heart = ctx.createGain();
    heart.gain.value = 1;
    heart.connect(master);
    this.heartBus = heart;

    const amb = ctx.createGain();
    amb.gain.value = 1;
    amb.connect(master);
    this.ambBus = amb;

    this.whiteBuf = this.makeWhite(ctx);
    this.brownBuf = this.makeBrown(ctx);

    this.applyTone();
    this.timer = setInterval(() => this.sweep(), SWEEP_MS);
    this.hbNext = ctx.currentTime + 0.2;

    if (ctx.state === 'suspended') await ctx.resume().catch(() => undefined);
    // L'ambiance demandée avant le premier geste démarre maintenant.
    if (this.ambRole) this.setAmbience(this.ambRole, this.ambAlarm);
  }

  setMuted(m: boolean): void {
    this.mute = m;
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;
    const t = ctx.currentTime;
    master.gain.cancelScheduledValues(t);
    master.gain.setValueAtTime(master.gain.value, t);
    master.gain.linearRampToValueAtTime(m ? 0 : CFG.audio.master, t + 0.08);
  }

  get muted(): boolean {
    return this.mute;
  }

  dispose(): void {
    this.dead = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const v of this.voices) this.hush(v, true);
    for (const v of this.dying) this.unplug(v);
    this.voices = [];
    this.dying = [];
    for (const o of this.ambNodes) {
      try {
        o.stop();
      } catch {
        /* déjà arrêté */
      }
      o.disconnect();
    }
    this.ambNodes = [];
    this.ambDrone = [];
    this.ambBuilt = false;
    const ctx = this.ctx;
    this.ctx = null;
    this.master = null;
    this.sfxBus = null;
    this.uiBus = null;
    this.heartBus = null;
    this.ambBus = null;
    this.toneLow = null;
    this.toneHigh = null;
    this.whiteBuf = null;
    this.brownBuf = null;
    if (ctx) ctx.close().catch(() => undefined);
  }

  /* ================================================================== */
  /* Écoute et spatialisation                                           */
  /* ================================================================== */

  setListener(pos: { x: number; y: number }, role: Role): void {
    this.lx = pos.x;
    this.ly = pos.y;
    if (role !== this.lrole) {
      this.lrole = role;
      this.applyTone();
    }
  }

  /** Le Châtelain entend chaud et large, l'Envahisseur froid et resserré. */
  private applyTone(): void {
    const ctx = this.ctx;
    const low = this.toneLow;
    const high = this.toneHigh;
    if (!ctx || !low || !high) return;
    const t = ctx.currentTime;
    const warm = this.lrole === 'castellan';
    low.frequency.setTargetAtTime(warm ? 300 : 420, t, 0.4);
    low.gain.setTargetAtTime(warm ? 3.5 : -3.5, t, 0.4);
    high.frequency.setTargetAtTime(warm ? 2400 : 3400, t, 0.4);
    high.gain.setTargetAtTime(warm ? -1.5 : 2.5, t, 0.4);
  }

  /* ================================================================== */
  /* Fabrique de voix                                                   */
  /* ================================================================== */

  private makeWhite(ctx: AudioContext): AudioBuffer {
    const n = Math.floor(ctx.sampleRate * 2);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  /** Bruit brun : l'énergie descend en 1/f², parfait pour la pierre. */
  private makeBrown(ctx: AudioContext): AudioBuffer {
    const n = Math.floor(ctx.sampleRate * 2);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < n; i++) {
      const w = Math.random() * 2 - 1;
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    }
    return buf;
  }

  /**
   * Ouvre une voix. Renvoie `null` si le moteur dort, s'il est muet, ou si la
   * source est trop loin pour être entendue — l'appelant n'a alors rien à faire.
   */
  private begin(
    vol: number,
    dur: number,
    pos?: { x: number; y: number } | null,
    bus?: GainNode | null,
  ): Bench | null {
    const ctx = this.ctx;
    const target = bus ?? this.sfxBus;
    if (!ctx || !target || this.dead || this.mute) return null;

    let amp = vol;
    let pan = 0;
    if (pos) {
      const dx = pos.x - this.lx;
      const dy = pos.y - this.ly;
      const d = Math.hypot(dx, dy);
      amp *= attenuate(d);
      if (amp < 0.0025) return null;
      pan = clamp(dx / (AUDIBLE_REF * 0.55), -1, 1) * 0.85;
    }

    // Petite marge : on ne programme jamais un événement dans le passé.
    const t = ctx.currentTime + 0.006;
    const out = ctx.createGain();
    out.gain.value = Math.min(1, amp);

    let tail: AudioNode = out;
    let panner: StereoPannerNode | null = null;
    if (pos && typeof ctx.createStereoPanner === 'function') {
      panner = ctx.createStereoPanner();
      panner.pan.value = pan;
      out.connect(panner);
      tail = panner;
    }
    tail.connect(target);

    const voice: Voice = { root: out, pan: panner, srcs: [], end: t + dur + 0.12 };
    this.push(voice);

    return {
      ctx,
      t,
      out,
      osc: (type, freq, start, stop) => {
        const o = ctx.createOscillator();
        o.type = type;
        o.frequency.setValueAtTime(Math.max(8, freq), start);
        o.start(start);
        o.stop(stop);
        voice.srcs.push({ node: o, at: start });
        if (stop + 0.05 > voice.end) voice.end = stop + 0.05;
        return o;
      },
      noise: (start, stop, kind = 'white', rate = 1) => {
        const s = ctx.createBufferSource();
        s.buffer = kind === 'brown' ? this.brownBuf : this.whiteBuf;
        s.loop = true;
        s.playbackRate.value = rate;
        // Départ aléatoire dans le tampon : deux bruits ne sont jamais jumeaux.
        const off = Math.random() * 1.5;
        s.start(start, off);
        s.stop(stop);
        voice.srcs.push({ node: s, at: start });
        if (stop + 0.05 > voice.end) voice.end = stop + 0.05;
        return s;
      },
    };
  }

  private push(v: Voice): void {
    const now = this.ctx ? this.ctx.currentTime : 0;
    // Ménage d'abord : les voix éteintes libèrent la place gratuitement.
    for (let i = this.voices.length - 1; i >= 0; i--) {
      const old = this.voices[i];
      if (old.end <= now) {
        this.unplug(old);
        this.voices.splice(i, 1);
      }
    }
    while (this.voices.length >= MAX_VOICES) {
      const oldest = this.voices.shift();
      if (!oldest) break;
      this.hush(oldest, false);
      // Elle n'est plus jouée mais elle est encore branchée : le balayage
      // la débranchera dans quelques dizaines de millisecondes.
      oldest.end = now + 0.06;
      this.dying.push(oldest);
    }
    this.voices.push(v);
  }

  /** Éteint une voix en 20 ms : on coupe, on ne claque pas. */
  private hush(v: Voice, hard: boolean): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const cut = t + (hard ? 0.01 : 0.03);
    try {
      v.root.gain.cancelScheduledValues(t);
      v.root.gain.setValueAtTime(v.root.gain.value, t);
      v.root.gain.linearRampToValueAtTime(0, t + (hard ? 0.005 : 0.02));
    } catch {
      /* paramètre déjà figé */
    }
    for (const s of v.srcs) {
      try {
        // Une source programmée plus tard s'arrête à son propre départ :
        // demander l'inverse est refusé par certains navigateurs.
        s.node.stop(Math.max(cut, s.at));
      } catch {
        /* source déjà terminée */
      }
    }
    if (hard) this.unplug(v);
  }

  /**
   * Débranche tout le sous-graphe d'une voix terminée. Le panoramique doit
   * être coupé explicitement : c'est lui qui tient au bus, pas la racine.
   */
  private unplug(v: Voice): void {
    for (const s of v.srcs) s.node.disconnect();
    v.srcs.length = 0;
    v.root.disconnect();
    if (v.pan) {
      v.pan.disconnect();
      v.pan = null;
    }
  }

  /* ================================================================== */
  /* Enveloppes et briques élémentaires                                 */
  /* ================================================================== */

  /** Enveloppe percussive : attaque linéaire, extinction exponentielle. */
  private env(b: Bench, start: number, peak: number, atk: number, dec: number): GainNode {
    const g = b.ctx.createGain();
    const p = Math.max(0.0002, peak);
    const a = Math.max(0.001, atk);
    const d = Math.max(0.01, dec);
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(p, start + a);
    g.gain.exponentialRampToValueAtTime(p * 0.001, start + a + d);
    g.gain.linearRampToValueAtTime(0, start + a + d + 0.01);
    return g;
  }

  /** Enveloppe de gonflement : monte, tient, redescend. */
  private swell(
    b: Bench,
    start: number,
    peak: number,
    up: number,
    hold: number,
    down: number,
  ): GainNode {
    const g = b.ctx.createGain();
    const p = Math.max(0.0002, peak);
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(p, start + up);
    g.gain.setValueAtTime(p, start + up + hold);
    g.gain.linearRampToValueAtTime(0, start + up + hold + down);
    return g;
  }

  private filter(
    b: Bench,
    type: BiquadFilterType,
    freq: number,
    q = 1,
  ): BiquadFilterNode {
    const f = b.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = Math.max(20, freq);
    f.Q.value = q;
    return f;
  }

  /** Modulation à taux audio d'un paramètre (grain de raclement, vibrato…). */
  private lfo(
    b: Bench,
    type: OscillatorType,
    freq: number,
    depth: number,
    target: AudioParam,
    start: number,
    stop: number,
  ): void {
    const o = b.osc(type, freq, start, stop);
    const g = b.ctx.createGain();
    g.gain.value = depth;
    o.connect(g);
    g.connect(target);
  }

  /** Corps grave d'un impact : une sinusoïde qui plonge. */
  private thump(
    b: Bench,
    start: number,
    from: number,
    to: number,
    peak: number,
    dec: number,
  ): void {
    const o = b.osc('sine', from, start, start + dec + 0.06);
    o.frequency.exponentialRampToValueAtTime(Math.max(12, to), start + dec * 0.8);
    const g = this.env(b, start, peak, 0.004, dec);
    o.connect(g);
    g.connect(b.out);
  }

  /** Souffle : du bruit passé dans une bande qui glisse. */
  private whoosh(
    b: Bench,
    start: number,
    from: number,
    to: number,
    dur: number,
    peak: number,
    q = 1.4,
  ): void {
    const n = b.noise(start, start + dur + 0.05);
    const f = this.filter(b, 'bandpass', from, q);
    f.frequency.exponentialRampToValueAtTime(Math.max(30, to), start + dur);
    const g = this.env(b, start, peak, dur * 0.25, dur * 0.8);
    n.connect(f);
    f.connect(g);
    g.connect(b.out);
  }

  /** Grain sec : un éclat de bruit très court, pour les gravats. */
  private grain(b: Bench, start: number, freq: number, peak: number, dur: number): void {
    const n = b.noise(start, start + dur + 0.03);
    const f = this.filter(b, 'bandpass', freq, 3.5);
    const g = this.env(b, start, peak, 0.002, dur);
    n.connect(f);
    f.connect(g);
    g.connect(b.out);
  }

  /** Partiel de cloche ou de métal : deux sinus légèrement désaccordés. */
  private ring(
    b: Bench,
    start: number,
    freq: number,
    peak: number,
    dec: number,
    detune = 4,
  ): void {
    const g = this.env(b, start, peak, 0.003, dec);
    for (let i = 0; i < 2; i++) {
      const o = b.osc('sine', freq, start, start + dec + 0.08);
      o.detune.value = i === 0 ? -detune : detune;
      o.connect(g);
    }
    g.connect(b.out);
  }

  /** Coup sur du bois : un ton étouffé plus un claquement filtré. */
  private woodKnock(b: Bench, start: number, freq: number, peak: number): void {
    const o = b.osc('triangle', freq, start, start + 0.14);
    o.frequency.exponentialRampToValueAtTime(freq * 0.55, start + 0.06);
    const g = this.env(b, start, peak, 0.002, 0.07);
    o.connect(g);
    g.connect(b.out);
    const o2 = b.osc('sine', freq * 2.68, start, start + 0.08);
    const g2 = this.env(b, start, peak * 0.45, 0.001, 0.035);
    o2.connect(g2);
    g2.connect(b.out);
    this.grain(b, start, 1500, peak * 0.5, 0.03);
  }

  /* ================================================================== */
  /* Événements de jeu                                                  */
  /* ================================================================== */

  /**
   * Joue un événement. L'hôte a déjà filtré : si l'événement arrive ici, le
   * joueur a le droit de l'entendre. Il reste à décider à quelle distance.
   */
  play(e: GameEvent): void {
    if (!this.ctx || this.mute || this.dead) return;
    switch (e.k) {
      case 'trap':
        this.trap(e.trap, { x: e.x, y: e.y }, e.hit ? 1 : 0.7);
        break;
      case 'replay':
        this.replayCue();
        break;
      case 'device':
        this.device(e.device, { x: e.x, y: e.y });
        break;
      case 'hit':
        this.hit(e.dmg, e.target, e.source, { x: e.x, y: e.y });
        break;
      case 'alarm':
        this.alarmBell({ x: e.x, y: e.y });
        break;
      case 'brazier':
        this.brazier({ x: e.x, y: e.y });
        break;
      case 'breach':
        this.breach({ x: e.x, y: e.y });
        break;
      case 'step':
        this.step(e.role, e.loud, { x: e.x, y: e.y });
        break;
      case 'swing':
        this.swing(e.role, { x: e.x, y: e.y });
        break;
      case 'parry':
        this.parry(e.perfect, { x: e.x, y: e.y });
        break;
      case 'dodge':
        this.dodge({ x: e.x, y: e.y });
        break;
      case 'bolt':
        this.bolt({ x: e.x, y: e.y });
        break;
      case 'blast':
        this.blast({ x: e.x, y: e.y });
        break;
      case 'death':
        this.death(e.role, { x: e.x, y: e.y });
        break;
      case 'sensor': {
        // Le guet du Châtelain : deux notes brèves, comme une clochette
        // discrète. Non positionné : c'est un signal d'interface, le Châtelain
        // l'entend où qu'il soit — l'indicateur à l'écran donne le lieu.
        const b = this.begin(0.4, 0.5);
        if (!b) break;
        this.ring(b, b.t, 1040, 0.2, 0.16, 5);
        this.ring(b, b.t + 0.11, 1385, 0.16, 0.22, 5);
        break;
      }
      case 'ricochet': {
        // Claquement métallique bref, positionné : on suit le carreau à
        // l'oreille dans un couloir.
        const b = this.begin(0.3, 0.25, { x: e.x, y: e.y });
        if (!b) break;
        this.ring(b, b.t, 2400, 0.3, 0.05, 12);
        this.grain(b, b.t, 3200, 0.2, 0.02);
        break;
      }

      case 'scry':
        this.scry(e.on);
        break;
      case 'probe':
        this.probe({ x: e.x, y: e.y });
        break;
      case 'door':
        this.door(e.open, { x: e.x, y: e.y });
        break;
      default: {
        // Exhaustivité : un nouveau variant d'événement casse la compilation.
        const never: never = e;
        void never;
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* Pièges — six timbres, aucune confusion possible                   */
  /* ---------------------------------------------------------------- */

  private trap(kind: TrapKind, pos: { x: number; y: number }, scale: number): void {
    switch (kind) {
      case 'spikes':
        this.trapSpikes(pos, scale);
        break;
      case 'arrows':
        this.trapArrows(pos, scale);
        break;
      case 'collapse':
        this.trapCollapse(pos, scale);
        break;
      case 'boulder':
        this.trapBoulder(pos, scale);
        break;
      case 'chest':
        this.trapChest(pos, scale);
        break;
      case 'decoy':
      default:
        // Le faux indice ne se déclenche jamais : il n'a pas de son. C'est
        // exactement ce qui le rend cruel.
        break;
    }
  }

  /** Pics : raclement métallique, puis un choc mou. */
  private trapSpikes(pos: { x: number; y: number }, s: number): void {
    const b = this.begin(0.62 * s, 0.65, pos);
    if (!b) return;
    const t = b.t;

    // Raclement : bande étroite qui descend, hachée par un trémolo rapide.
    const n = b.noise(t, t + 0.24, 'white', 1.2);
    const f = this.filter(b, 'bandpass', 2900, 9);
    f.frequency.exponentialRampToValueAtTime(820, t + 0.2);
    const grind = b.ctx.createGain();
    grind.gain.value = 0.55;
    this.lfo(b, 'square', 62, 0.42, grind.gain, t, t + 0.24);
    const g = this.env(b, t, 0.85, 0.008, 0.2);
    n.connect(f);
    f.connect(grind);
    grind.connect(g);
    g.connect(b.out);

    // Deux lames qui sonnent en glissant l'une sur l'autre.
    for (const fr of [1830, 2410]) {
      const o = b.osc('sawtooth', fr, t, t + 0.2);
      o.frequency.exponentialRampToValueAtTime(fr * 0.62, t + 0.18);
      const hp = this.filter(b, 'highpass', 1200, 0.9);
      const og = this.env(b, t, 0.13, 0.006, 0.16);
      o.connect(hp);
      hp.connect(og);
      og.connect(b.out);
    }

    // Le choc mou : grave qui plonge, plus un bruit sourd et court.
    this.thump(b, t + 0.17, 138, 44, 0.9, 0.2);
    const wet = b.noise(t + 0.17, t + 0.38, 'brown');
    const lp = this.filter(b, 'lowpass', 380, 1.1);
    const wg = this.env(b, t + 0.17, 0.5, 0.006, 0.16);
    wet.connect(lp);
    lp.connect(wg);
    wg.connect(b.out);
  }

  /** Flèches : trois sifflements serrés, puis un choc de bois. */
  private trapArrows(pos: { x: number; y: number }, s: number): void {
    const b = this.begin(0.5 * s, 0.5, pos);
    if (!b) return;
    const t = b.t;
    for (let i = 0; i < 3; i++) {
      const at = t + i * 0.058;
      this.whoosh(b, at, 2600 - i * 260, 720, 0.1, 0.55, 2.4);
    }
    this.woodKnock(b, t + 0.2, 372, 0.8);
    // Le trait qui vibre dans la poutre.
    const o = b.osc('triangle', 640, t + 0.21, t + 0.42);
    const vg = this.env(b, t + 0.21, 0.12, 0.004, 0.18);
    this.lfo(b, 'sine', 34, 90, o.frequency, t + 0.21, t + 0.42);
    o.connect(vg);
    vg.connect(b.out);
  }

  /** Effondrement : gravats secs, hauteur qui s'échappe vers le bas. */
  private trapCollapse(pos: { x: number; y: number }, s: number): void {
    const b = this.begin(0.62 * s, 0.95, pos);
    if (!b) return;
    const t = b.t;

    const n = b.noise(t, t + 0.8, 'white', 0.9);
    const f = this.filter(b, 'bandpass', 1900, 1.3);
    f.frequency.exponentialRampToValueAtTime(170, t + 0.62);
    const g = this.env(b, t, 0.7, 0.01, 0.62);
    n.connect(f);
    f.connect(g);
    g.connect(b.out);

    // Une dizaine d'éclats : la dalle part en morceaux, pas d'un bloc.
    for (let i = 0; i < 11; i++) {
      const at = t + 0.02 + Math.random() * 0.5;
      this.grain(b, at, 2400 - i * 150 + Math.random() * 400, 0.24, 0.035);
    }

    // Le sol n'est plus là : le grave s'en va.
    const sub = b.osc('sine', 96, t + 0.04, t + 0.8);
    sub.frequency.exponentialRampToValueAtTime(26, t + 0.66);
    const sg = this.env(b, t + 0.04, 0.6, 0.02, 0.6);
    sub.connect(sg);
    sg.connect(b.out);
  }

  /** Rocher : grondement qui enfle, puis l'écrasement le plus lourd du jeu. */
  private trapBoulder(pos: { x: number; y: number }, s: number): void {
    const b = this.begin(0.95 * s, 2.1, pos);
    if (!b) return;
    const t = b.t;
    const crash = t + 0.52;

    // Montée : le rocher roule au plafond avant de tomber.
    const roll = b.noise(t, crash + 0.1, 'brown', 0.75);
    const rf = this.filter(b, 'lowpass', 150, 1.2);
    rf.frequency.exponentialRampToValueAtTime(420, crash);
    const rg = this.swell(b, t, 0.75, 0.5, 0.02, 0.12);
    roll.connect(rf);
    rf.connect(rg);
    rg.connect(b.out);

    const drift = b.osc('sine', 34, t, crash + 0.1);
    drift.frequency.linearRampToValueAtTime(48, crash);
    const dg = this.swell(b, t, 0.5, 0.48, 0.02, 0.1);
    drift.connect(dg);
    dg.connect(b.out);

    // L'écrasement.
    const hit = b.noise(crash, crash + 1.3, 'brown', 1);
    const hf = this.filter(b, 'lowpass', 2800, 0.9);
    hf.frequency.exponentialRampToValueAtTime(180, crash + 0.9);
    const hg = this.env(b, crash, 1, 0.006, 1.1);
    hit.connect(hf);
    hf.connect(hg);
    hg.connect(b.out);

    this.thump(b, crash, 78, 24, 1, 0.85);
    this.thump(b, crash + 0.09, 52, 20, 0.55, 0.6);

    // Éclats de pierre projetés autour.
    for (let i = 0; i < 9; i++) {
      this.grain(b, crash + Math.random() * 0.35, 900 + Math.random() * 2600, 0.2, 0.05);
    }
    // La poussière retombe.
    const dust = b.noise(crash + 0.2, crash + 1.5, 'white', 0.6);
    const df = this.filter(b, 'bandpass', 620, 0.8);
    const dgn = this.swell(b, crash + 0.2, 0.13, 0.15, 0.2, 0.85);
    dust.connect(df);
    df.connect(dgn);
    dgn.connect(b.out);
  }

  /** Coffre : un loquet de bois qui claque. Clair, court, presque joyeux. */
  private trapChest(pos: { x: number; y: number }, s: number): void {
    const b = this.begin(0.5 * s, 0.4, pos);
    if (!b) return;
    const t = b.t;
    this.woodKnock(b, t, 640, 0.7);
    this.grain(b, t + 0.03, 3200, 0.3, 0.03);
    // Deux notes claires, comme une invitation. Le piège se moque du joueur.
    this.ring(b, t + 0.05, 1046, 0.24, 0.16);
    this.ring(b, t + 0.11, 1318, 0.2, 0.22);
    this.thump(b, t + 0.02, 190, 90, 0.3, 0.1);
  }

  /** Rejeu offert au Châtelain (§11) : un souvenir feutré, jamais agressif. */
  private replayCue(): void {
    const b = this.begin(0.3, 1.1, null, this.uiBus);
    if (!b) return;
    const t = b.t;
    const n = b.noise(t, t + 0.9, 'white', 0.7);
    const f = this.filter(b, 'bandpass', 480, 1.1);
    f.frequency.exponentialRampToValueAtTime(1500, t + 0.5);
    const g = this.swell(b, t, 0.3, 0.28, 0.1, 0.5);
    n.connect(f);
    f.connect(g);
    g.connect(b.out);
    this.ring(b, t + 0.05, 262, 0.3, 0.8);
    this.ring(b, t + 0.05, 392, 0.18, 0.7);
  }

  /* ---------------------------------------------------------------- */
  /* Mécanismes du Châtelain — un timbre par mécanisme                 */
  /* ---------------------------------------------------------------- */

  private device(kind: DeviceKind, pos: { x: number; y: number }): void {
    switch (kind) {
      case 'portcullis':
        this.devPortcullis(pos);
        break;
      case 'chandelier':
        this.devChandelier(pos);
        break;
      case 'trapdoor':
        this.devTrapdoor(pos);
        break;
      case 'hound':
        this.devHound(pos);
        break;
      case 'cavein':
        this.devCavein(pos);
        break;
      case 'douse':
        this.devDouse(pos);
        break;
      default:
        break;
    }
  }

  /** Herse : la chaîne file, la grille mord le sol. */
  private devPortcullis(pos: { x: number; y: number }): void {
    const b = this.begin(0.72, 1.2, pos);
    if (!b) return;
    const t = b.t;
    // Chaîne : une rafale de maillons de plus en plus rapides.
    for (let i = 0; i < 14; i++) {
      const at = t + (i / 14) ** 1.4 * 0.42;
      this.grain(b, at, 2000 + Math.random() * 2200, 0.22, 0.02);
    }
    const slam = t + 0.44;
    for (const fr of [92, 147, 213]) {
      this.ring(b, slam, fr, 0.4, 0.55, 7);
    }
    this.thump(b, slam, 130, 40, 0.9, 0.35);
    const n = b.noise(slam, slam + 0.4, 'brown');
    const f = this.filter(b, 'lowpass', 700, 1);
    const g = this.env(b, slam, 0.55, 0.004, 0.3);
    n.connect(f);
    f.connect(g);
    g.connect(b.out);
    // La grille vibre encore un instant.
    this.ring(b, slam + 0.02, 640, 0.12, 0.6, 12);
  }

  /** Lustre : le cristal tinte, puis tout se brise. */
  private devChandelier(pos: { x: number; y: number }): void {
    const b = this.begin(0.8, 1.5, pos);
    if (!b) return;
    const t = b.t;
    for (let i = 0; i < 6; i++) {
      this.ring(b, t + i * 0.035, 2400 + i * 320 + Math.random() * 200, 0.16, 0.2, 9);
    }
    const crash = t + 0.34;
    const n = b.noise(crash, crash + 1.1, 'white', 1.1);
    const f = this.filter(b, 'highpass', 1800, 0.8);
    const lp = this.filter(b, 'lowpass', 6000, 0.7);
    lp.frequency.exponentialRampToValueAtTime(900, crash + 0.7);
    const g = this.env(b, crash, 0.75, 0.004, 0.85);
    n.connect(f);
    f.connect(lp);
    lp.connect(g);
    g.connect(b.out);
    for (let i = 0; i < 12; i++) {
      this.grain(b, crash + Math.random() * 0.55, 2600 + Math.random() * 4200, 0.2, 0.04);
    }
    this.thump(b, crash, 160, 55, 0.6, 0.3);
  }

  /** Trappe : la charnière grince, le panneau lâche. */
  private devTrapdoor(pos: { x: number; y: number }): void {
    const b = this.begin(0.66, 1, pos);
    if (!b) return;
    const t = b.t;
    const o = b.osc('sawtooth', 168, t, t + 0.3);
    this.lfo(b, 'sine', 21, 26, o.frequency, t, t + 0.3);
    const f = this.filter(b, 'bandpass', 900, 6);
    f.frequency.linearRampToValueAtTime(1500, t + 0.28);
    const g = this.swell(b, t, 0.4, 0.06, 0.12, 0.14);
    o.connect(f);
    f.connect(g);
    g.connect(b.out);

    this.woodKnock(b, t + 0.3, 210, 0.85);
    this.whoosh(b, t + 0.32, 900, 180, 0.32, 0.4, 1);
    this.thump(b, t + 0.42, 90, 34, 0.7, 0.3);
  }

  /** Molosse : un grondement, puis deux aboiements secs. */
  private devHound(pos: { x: number; y: number }): void {
    const b = this.begin(0.7, 1.2, pos);
    if (!b) return;
    const t = b.t;

    const growl = b.osc('sawtooth', 88, t, t + 0.36);
    this.lfo(b, 'sine', 27, 14, growl.frequency, t, t + 0.36);
    const gf = this.filter(b, 'bandpass', 420, 3);
    const gg = this.swell(b, t, 0.45, 0.08, 0.14, 0.14);
    growl.connect(gf);
    gf.connect(gg);
    gg.connect(b.out);

    for (let i = 0; i < 2; i++) {
      const at = t + 0.4 + i * 0.24;
      const o = b.osc('sawtooth', 300, at, at + 0.16);
      o.frequency.exponentialRampToValueAtTime(120, at + 0.11);
      const f1 = this.filter(b, 'bandpass', 760, 4);
      const f2 = this.filter(b, 'bandpass', 1850, 5);
      const eg = this.env(b, at, 0.8, 0.005, 0.11);
      o.connect(f1);
      f1.connect(f2);
      f2.connect(eg);
      eg.connect(b.out);
      this.grain(b, at, 1400, 0.3, 0.04);
    }
  }

  /** Éboulement : une longue coulée de pierres qui s'éteint d'elle-même. */
  private devCavein(pos: { x: number; y: number }): void {
    const b = this.begin(0.85, 1.9, pos);
    if (!b) return;
    const t = b.t;
    const n = b.noise(t, t + 1.6, 'brown', 1);
    const f = this.filter(b, 'lowpass', 900, 1);
    f.frequency.exponentialRampToValueAtTime(120, t + 1.35);
    const g = this.swell(b, t, 0.85, 0.1, 0.35, 1.05);
    n.connect(f);
    f.connect(g);
    g.connect(b.out);
    for (let i = 0; i < 22; i++) {
      const at = t + Math.random() ** 0.7 * 1.15;
      this.grain(b, at, 300 + Math.random() * 1800, 0.2, 0.05);
    }
    this.thump(b, t + 0.15, 62, 22, 0.75, 0.9);
  }

  /** Extinction : un grand souffle mouillé, les flammes meurent. */
  private devDouse(pos: { x: number; y: number }): void {
    const b = this.begin(0.6, 1.4, pos);
    if (!b) return;
    const t = b.t;
    const n = b.noise(t, t + 1.2, 'white', 1);
    const f = this.filter(b, 'bandpass', 3400, 0.8);
    f.frequency.exponentialRampToValueAtTime(420, t + 1);
    const g = this.env(b, t, 0.7, 0.03, 1);
    n.connect(f);
    f.connect(g);
    g.connect(b.out);
    // L'air aspiré par le vide laissé par le feu.
    this.thump(b, t + 0.02, 150, 60, 0.35, 0.35);
    this.whoosh(b, t + 0.05, 700, 240, 0.5, 0.25, 0.9);
  }

  /* ---------------------------------------------------------------- */
  /* Combat, corps, portes                                             */
  /* ---------------------------------------------------------------- */

  private swing(role: Role, pos: { x: number; y: number }): void {
    const b = this.begin(role === 'invader' ? 0.4 : 0.44, 0.4, pos);
    if (!b) return;
    const t = b.t;
    if (role === 'invader') {
      // Épée légère : vif, aigu, bref.
      this.whoosh(b, t, 420, 2100, 0.16, 0.8, 1.6);
      this.ring(b, t + 0.06, 2600, 0.07, 0.12, 10);
    } else {
      // Lame du Châtelain : plus lourde, plus lente, plus grave.
      this.whoosh(b, t, 260, 980, 0.28, 0.85, 1.1);
      this.ring(b, t + 0.12, 1400, 0.08, 0.18, 8);
    }
  }

  private hit(dmg: number, target: Role, source: string, pos: { x: number; y: number }): void {
    const k = clamp(dmg / 45, 0.3, 1.25);
    const b = this.begin(0.4 + 0.45 * k, 0.6, pos);
    if (!b) return;
    const t = b.t;
    const metal = /épée|lame|arbal|flèche|fleche|lustre|pic/i.test(source);

    const n = b.noise(t, t + 0.3, 'brown');
    const f = this.filter(b, 'lowpass', 700 + 700 * k, 1.1);
    const g = this.env(b, t, 0.85, 0.003, 0.1 + 0.06 * k);
    n.connect(f);
    f.connect(g);
    g.connect(b.out);

    // Le Châtelain encaisse plus grave : c'est un corps plus lourd.
    const base = target === 'castellan' ? 175 : 205;
    this.thump(b, t, base - 40 * k, 52, 0.85, 0.16 + 0.14 * k);

    if (metal) {
      this.ring(b, t, 2350, 0.2 * k, 0.16, 11);
      this.ring(b, t, 3180, 0.12 * k, 0.1, 14);
    }
    if (k > 0.85) {
      // Gros dégât : un grave supplémentaire, qui se sent dans la poitrine.
      this.thump(b, t + 0.02, 78, 30, 0.55, 0.34);
    }
  }

  private parry(perfect: boolean, pos: { x: number; y: number }): void {
    const b = this.begin(perfect ? 0.62 : 0.44, perfect ? 1.4 : 0.5, pos);
    if (!b) return;
    const t = b.t;
    this.grain(b, t, 4200, 0.3, 0.02);
    if (perfect) {
      // Parade parfaite : plus clair, plus long, ça chante.
      const parts = [1290, 1930, 2570, 3410, 4700, 6100];
      for (let i = 0; i < parts.length; i++) {
        this.ring(b, t, parts[i], 0.34 / (1 + i * 0.55), 1.15 - i * 0.14, 5 + i);
      }
      // Une montée franche : l'attaquant est renvoyé.
      const o = b.osc('triangle', 780, t + 0.02, t + 0.4);
      o.frequency.exponentialRampToValueAtTime(1560, t + 0.24);
      const g = this.env(b, t + 0.02, 0.16, 0.01, 0.3);
      o.connect(g);
      g.connect(b.out);
    } else {
      const parts = [980, 1470, 2110];
      for (let i = 0; i < parts.length; i++) {
        this.ring(b, t, parts[i], 0.3 / (1 + i * 0.7), 0.3 - i * 0.07, 6 + i * 2);
      }
      this.thump(b, t, 180, 90, 0.35, 0.1);
    }
  }

  private dodge(pos: { x: number; y: number }): void {
    const b = this.begin(0.3, 0.35, pos);
    if (!b) return;
    const t = b.t;
    // Étoffe et appui : on part de côté, on ne frappe rien.
    this.whoosh(b, t, 1700, 320, 0.24, 0.7, 0.9);
    this.thump(b, t, 120, 62, 0.28, 0.09);
  }

  private bolt(pos: { x: number; y: number }): void {
    const b = this.begin(0.5, 0.45, pos);
    if (!b) return;
    const t = b.t;
    // Le déclic de la noix, la corde qui claque, le trait qui part.
    this.grain(b, t, 2600, 0.35, 0.02);
    const o = b.osc('sawtooth', 260, t, t + 0.16);
    o.frequency.exponentialRampToValueAtTime(90, t + 0.12);
    const f = this.filter(b, 'bandpass', 520, 3.5);
    const g = this.env(b, t, 0.7, 0.002, 0.12);
    o.connect(f);
    f.connect(g);
    g.connect(b.out);
    this.whoosh(b, t + 0.03, 1300, 3000, 0.2, 0.3, 2.6);
  }

  private blast(pos: { x: number; y: number }): void {
    const b = this.begin(0.88, 1.4, pos);
    if (!b) return;
    const t = b.t;
    const n = b.noise(t, t + 1.1, 'white', 1);
    const f = this.filter(b, 'lowpass', 7000, 0.8);
    f.frequency.exponentialRampToValueAtTime(230, t + 0.6);
    const g = this.env(b, t, 1, 0.002, 0.75);
    n.connect(f);
    f.connect(g);
    g.connect(b.out);
    this.thump(b, t, 110, 26, 1, 0.55);
    // Le mur qui s'ouvre : quelques éclats après le souffle.
    for (let i = 0; i < 8; i++) {
      this.grain(b, t + 0.06 + Math.random() * 0.4, 700 + Math.random() * 2600, 0.18, 0.05);
    }
  }

  /** Cloche d'alarme : plusieurs partiels désaccordés, deux volées. */
  private alarmBell(pos: { x: number; y: number }): void {
    const b = this.begin(0.85, 4.6, pos);
    if (!b) return;
    const t = b.t;
    const partials: [number, number, number][] = [
      [0.5, 0.5, 3.4],
      [1, 1, 2.9],
      [1.19, 0.62, 2.1],
      [1.56, 0.44, 1.6],
      [2.0, 0.5, 1.3],
      [2.66, 0.26, 0.85],
      [3.01, 0.2, 0.65],
      [4.07, 0.14, 0.4],
    ];
    const base = 296;
    for (let strike = 0; strike < 2; strike++) {
      const at = t + strike * 1.35;
      const amp = strike === 0 ? 1 : 0.72;
      // Le battant frappe le bronze.
      this.grain(b, at, 3400, 0.3 * amp, 0.03);
      this.grain(b, at, 1200, 0.24 * amp, 0.05);
      for (let i = 0; i < partials.length; i++) {
        const [mul, g, dec] = partials[i];
        this.ring(b, at, base * mul, 0.34 * g * amp, dec, 3 + i * 1.5);
      }
    }
  }

  /** Brasero : l'amorce prend, le feu monte. */
  private brazier(pos: { x: number; y: number }): void {
    const b = this.begin(0.6, 1.3, pos);
    if (!b) return;
    const t = b.t;
    const n = b.noise(t, t + 1.1, 'white', 0.9);
    const f = this.filter(b, 'lowpass', 300, 1);
    f.frequency.exponentialRampToValueAtTime(2100, t + 0.32);
    f.frequency.exponentialRampToValueAtTime(600, t + 1);
    const g = this.swell(b, t, 0.6, 0.14, 0.16, 0.75);
    n.connect(f);
    f.connect(g);
    g.connect(b.out);
    // Le souffle chaud du départ de flamme.
    this.thump(b, t, 130, 58, 0.45, 0.4);
    // Crépitements.
    for (let i = 0; i < 14; i++) {
      this.grain(b, t + 0.1 + Math.random() * 0.9, 1600 + Math.random() * 3000, 0.13, 0.02);
    }
  }

  /** Brèche à 50 % : la pierre gémit, quelque chose a cédé pour de bon. */
  private breach(pos: { x: number; y: number }): void {
    const b = this.begin(0.9, 2.4, pos);
    if (!b) return;
    const t = b.t;
    for (const fr of [44, 44.9, 66]) {
      const o = b.osc('sawtooth', fr, t, t + 2.1);
      o.frequency.exponentialRampToValueAtTime(fr * 0.62, t + 1.7);
      const f = this.filter(b, 'lowpass', 320, 1.3);
      f.frequency.exponentialRampToValueAtTime(95, t + 1.6);
      const g = this.swell(b, t, 0.4, 0.1, 0.5, 1.4);
      o.connect(f);
      f.connect(g);
      g.connect(b.out);
    }
    this.thump(b, t, 92, 22, 0.95, 1.2);
    const n = b.noise(t, t + 2, 'brown', 0.8);
    const nf = this.filter(b, 'lowpass', 420, 0.9);
    nf.frequency.exponentialRampToValueAtTime(110, t + 1.6);
    const ng = this.swell(b, t, 0.5, 0.16, 0.4, 1.3);
    n.connect(nf);
    nf.connect(ng);
    ng.connect(b.out);
    // Un dernier coup de cloche très grave : le seuil est franchi.
    this.ring(b, t + 0.05, 110, 0.3, 1.9, 4);
    this.ring(b, t + 0.05, 131, 0.18, 1.5, 6);
  }

  private death(role: Role, pos: { x: number; y: number }): void {
    const b = this.begin(0.75, 1.8, pos);
    if (!b) return;
    const t = b.t;
    const heavy = role === 'castellan';

    // Le corps tombe : deux chocs, le second plus mat.
    this.thump(b, t, heavy ? 150 : 175, 42, 0.85, 0.24);
    this.thump(b, t + 0.14, heavy ? 100 : 120, 34, 0.5, 0.2);
    for (const at of [t, t + 0.14]) {
      const n = b.noise(at, at + 0.3, 'brown');
      const f = this.filter(b, 'lowpass', 460, 1);
      const g = this.env(b, at, 0.5, 0.004, 0.18);
      n.connect(f);
      f.connect(g);
      g.connect(b.out);
    }

    // Le ton qui s'éteint : ça descend et ça ne remonte pas.
    const o = b.osc('sawtooth', heavy ? 150 : 176, t + 0.02, t + 1.5);
    o.frequency.exponentialRampToValueAtTime(heavy ? 46 : 55, t + 0.85);
    const f = this.filter(b, 'lowpass', 800, 1.4);
    f.frequency.exponentialRampToValueAtTime(180, t + 1.1);
    const g = this.swell(b, t + 0.02, 0.35, 0.05, 0.25, 1.1);
    o.connect(f);
    f.connect(g);
    g.connect(b.out);
    this.ring(b, t + 0.05, heavy ? 87 : 104, 0.22, 1.4, 5);
  }

  /**
   * Pas. L'Envahisseur qui court est bien plus fort et plus grave que l'allure
   * normale — c'est ce qui permet au Châtelain de le suivre à l'oreille. Le
   * Châtelain, lui, a le pas lourd et traînant.
   */
  private step(role: Role, loud: boolean, pos: { x: number; y: number }): void {
    if (role === 'castellan') {
      const b = this.begin(0.34, 0.4, pos);
      if (!b) return;
      const t = b.t;
      this.thump(b, t, 86, 40, 0.8, 0.2);
      const n = b.noise(t, t + 0.28, 'brown');
      const f = this.filter(b, 'lowpass', 620, 1);
      const g = this.env(b, t, 0.5, 0.005, 0.16);
      n.connect(f);
      f.connect(g);
      g.connect(b.out);
      // Le cuir de la botte qui travaille : le Châtelain traîne son pas.
      const o = b.osc('triangle', 330, t + 0.05, t + 0.26);
      o.frequency.exponentialRampToValueAtTime(220, t + 0.2);
      const og = this.env(b, t + 0.05, 0.08, 0.03, 0.15);
      o.connect(og);
      og.connect(b.out);
      return;
    }

    if (loud) {
      // Course : franc, lourd, impossible à confondre.
      const b = this.begin(0.5, 0.3, pos);
      if (!b) return;
      const t = b.t;
      this.thump(b, t, 118, 52, 0.9, 0.14);
      const n = b.noise(t, t + 0.2, 'brown', 1.1);
      const f = this.filter(b, 'lowpass', 1300, 1.2);
      const g = this.env(b, t, 0.65, 0.003, 0.11);
      n.connect(f);
      f.connect(g);
      g.connect(b.out);
      this.grain(b, t, 2200, 0.18, 0.03);
      return;
    }

    // Allure normale : léger, sec, vite oublié.
    const b = this.begin(0.2, 0.18, pos);
    if (!b) return;
    const t = b.t;
    this.grain(b, t, 1050, 0.5, 0.045);
    this.thump(b, t, 165, 110, 0.3, 0.055);
  }

  /** Scrutation : un gonflement aérien qui monte, ou qui redescend. */
  private scry(on: boolean): void {
    const b = this.begin(0.42, 0.9, null, this.uiBus);
    if (!b) return;
    const t = b.t;
    const n = b.noise(t, t + 0.75, 'white', 1);
    const f = this.filter(b, 'bandpass', on ? 300 : 3000, 1.2);
    f.frequency.exponentialRampToValueAtTime(on ? 3200 : 280, t + 0.5);
    const g = this.swell(b, t, 0.5, on ? 0.3 : 0.06, 0.06, on ? 0.28 : 0.42);
    n.connect(f);
    f.connect(g);
    g.connect(b.out);

    for (let i = 0; i < 3; i++) {
      const from = on ? 220 * (i + 1) : 660 / (i + 1);
      const to = on ? 660 * (i + 1) * 0.55 : 190 / (i + 1);
      const o = b.osc('sine', from, t, t + 0.7);
      o.frequency.exponentialRampToValueAtTime(Math.max(30, to), t + 0.45);
      const og = this.swell(b, t, 0.16 / (i + 1), on ? 0.3 : 0.05, 0.05, 0.3);
      o.connect(og);
      og.connect(b.out);
    }
  }

  /** Sonde : une impulsion qui part et un écho qui revient. */
  private probe(pos: { x: number; y: number }): void {
    const b = this.begin(0.45, 1.2, pos);
    if (!b) return;
    const t = b.t;
    for (let i = 0; i < 2; i++) {
      const at = t + i * 0.26;
      const amp = i === 0 ? 0.45 : 0.2;
      const o = b.osc('sine', 1180, at, at + 0.55);
      o.frequency.exponentialRampToValueAtTime(1560, at + 0.06);
      o.frequency.exponentialRampToValueAtTime(1320, at + 0.4);
      const g = this.env(b, at, amp, 0.006, 0.42);
      o.connect(g);
      g.connect(b.out);
      const o2 = b.osc('sine', 2360, at, at + 0.3);
      const g2 = this.env(b, at, amp * 0.3, 0.004, 0.22);
      o2.connect(g2);
      g2.connect(b.out);
    }
  }

  private door(open: boolean, pos: { x: number; y: number }): void {
    const b = this.begin(0.42, 0.9, pos);
    if (!b) return;
    const t = b.t;
    if (open) {
      // Le gond force, puis la porte bat contre la pierre.
      const o = b.osc('sawtooth', 195, t, t + 0.34);
      this.lfo(b, 'sine', 17, 30, o.frequency, t, t + 0.34);
      const f = this.filter(b, 'bandpass', 780, 7);
      f.frequency.linearRampToValueAtTime(1250, t + 0.32);
      const g = this.swell(b, t, 0.34, 0.07, 0.14, 0.13);
      o.connect(f);
      f.connect(g);
      g.connect(b.out);
      this.woodKnock(b, t + 0.36, 172, 0.55);
    } else {
      this.woodKnock(b, t, 148, 0.8);
      this.thump(b, t, 110, 48, 0.6, 0.22);
      this.grain(b, t + 0.06, 2400, 0.22, 0.03);
    }
  }

  /* ================================================================== */
  /* Battement du Cœur — la boussole de l'Envahisseur (§10)             */
  /* ================================================================== */

  /**
   * À rappeler à chaque rafraîchissement du HUD. Si l'appel cesse, le battement
   * s'arrête tout seul au bout d'une demi-seconde.
   */
  setHeartbeat(distanceTiles: number, timeLeft: number, alarmOn: boolean): void {
    this.hbDist = Number.isFinite(distanceTiles) ? Math.max(0, distanceTiles) : Infinity;
    this.hbTimeLeft = Number.isFinite(timeLeft) ? timeLeft : Infinity;
    this.hbAlarm = alarmOn;
    if (this.ctx) this.hbLast = this.ctx.currentTime;
  }

  /** Période et volume du battement, selon la distance et le temps restant. */
  private heartbeatShape(): { period: number; level: number } {
    const radius = CFG.heart.heartbeatRadius;
    const k = clamp(this.hbDist / radius, 0, 1);
    let period = lerp(CFG.audio.heartbeatFast, CFG.audio.heartbeatSlow, k);
    // Plus on est loin, plus c'est sourd ; au-delà du rayon, plus rien.
    let level = this.hbDist >= radius ? 0 : 0.9 * (1 - k * k * 0.78);

    // Dernières secondes : le Cœur s'emballe pour les deux joueurs, où qu'ils
    // soient. C'est l'horloge du match, pas une information de position.
    if (this.hbTimeLeft <= CFG.audio.finalRush && this.hbTimeLeft > 0) {
      const urg = 1 - clamp(this.hbTimeLeft / CFG.audio.finalRush, 0, 1);
      period = Math.min(period, lerp(CFG.audio.heartbeatFast, 0.33, urg));
      level = Math.max(level, lerp(0.42, 0.95, urg));
    }
    if (this.hbAlarm) level *= 1.12;
    return { period: Math.max(0.25, period), level: clamp(level, 0, 1) };
  }

  /** Un battement : « toum » franc, puis « toum » plus court et plus grave. */
  private beat(at: number, level: number, period: number): void {
    const b = this.begin(0.85 * level, 0.6, null, this.heartBus);
    if (!b) return;
    const t = Math.max(b.t, at);
    const gap = Math.min(0.24, period * 0.3);

    const thumps: [number, number, number, number][] = [
      [t, 1, 64, 0.2],
      [t + gap, 0.62, 54, 0.16],
    ];
    for (const [start, amp, from, dec] of thumps) {
      const o = b.osc('sine', from, start, start + dec + 0.1);
      o.frequency.exponentialRampToValueAtTime(from * 0.62, start + dec * 0.85);
      const lp = this.filter(b, 'lowpass', 180, 1.1);
      const g = this.env(b, start, amp, 0.012, dec);
      o.connect(lp);
      lp.connect(g);
      g.connect(b.out);

      // Un souffle de corps sous le grave : ça respire, ce n'est pas un bip.
      const n = b.noise(start, start + dec + 0.05, 'brown');
      const nf = this.filter(b, 'lowpass', 220, 0.9);
      const ng = this.env(b, start, amp * 0.35, 0.01, dec * 0.7);
      n.connect(nf);
      nf.connect(ng);
      ng.connect(b.out);
    }

    if (this.hbAlarm) {
      // Le château est réveillé : le battement se crispe.
      const o = b.osc('triangle', 148, t, t + 0.18);
      o.frequency.exponentialRampToValueAtTime(96, t + 0.14);
      const g = this.env(b, t, 0.12, 0.006, 0.13);
      o.connect(g);
      g.connect(b.out);
    }
  }

  /* ================================================================== */
  /* Ambiance                                                           */
  /* ================================================================== */

  /**
   * Lit d'ambiance lent. Le rôle donne la couleur, l'alarme ajoute une couche
   * tendue par-dessus, sans jamais couper ce qui tourne déjà.
   */
  setAmbience(role: Role, alarm: boolean): void {
    this.ambRole = role;
    this.ambAlarm = alarm;
    const ctx = this.ctx;
    const bus = this.ambBus;
    if (!ctx || !bus) return;
    if (!this.ambBuilt) this.buildAmbience(ctx, bus);

    const t = ctx.currentTime;
    const warm = role === 'castellan';

    // Le bourdon se retend au lieu de repartir : aucune coupure audible.
    // Chaud et large pour le Châtelain, froid et resserré pour l'Envahisseur.
    const roots = warm ? [58.3, 87.4, 116.6] : [49, 73.4, 98];
    for (let i = 0; i < this.ambDrone.length; i++) {
      this.ambDrone[i].frequency.setTargetAtTime(roots[i % roots.length], t, 1.4);
    }
    if (this.ambDroneGain) {
      this.ambDroneGain.gain.setTargetAtTime(warm ? 0.075 : 0.055, t, 1.2);
    }
    if (this.ambWindFilter) {
      this.ambWindFilter.frequency.setTargetAtTime(warm ? 430 : 720, t, 1.5);
      this.ambWindFilter.Q.setTargetAtTime(warm ? 1 : 2.2, t, 1.5);
    }
    if (this.ambCalmGain) {
      this.ambCalmGain.gain.setTargetAtTime(alarm ? 0.45 : 1, t, alarm ? 0.7 : 1.4);
    }
    if (this.ambAlarmGain) {
      this.ambAlarmGain.gain.setTargetAtTime(alarm ? 1 : 0, t, alarm ? 0.5 : 1.1);
    }
  }

  private buildAmbience(ctx: AudioContext, bus: GainNode): void {
    this.ambBuilt = true;
    const t = ctx.currentTime;

    /* --- Couche calme : un bourdon et un souffle de couloir --- */
    const calm = ctx.createGain();
    calm.gain.value = 1;
    calm.connect(bus);
    this.ambCalmGain = calm;

    const drone = ctx.createGain();
    drone.gain.value = 0;
    drone.gain.setTargetAtTime(0.06, t, 2);
    const droneLp = ctx.createBiquadFilter();
    droneLp.type = 'lowpass';
    droneLp.frequency.value = 240;
    droneLp.Q.value = 0.8;
    drone.connect(droneLp);
    droneLp.connect(calm);
    this.ambDroneGain = drone;

    // Six oscillateurs : trois hauteurs, chacune doublée et désaccordée.
    for (let i = 0; i < 6; i++) {
      const o = ctx.createOscillator();
      o.type = i < 3 ? 'sine' : 'triangle';
      o.frequency.value = 58.3;
      o.detune.value = i < 3 ? 0 : 6;
      const g = ctx.createGain();
      g.gain.value = i < 3 ? 0.5 : 0.16;
      o.connect(g);
      g.connect(drone);
      o.start();
      this.ambDrone.push(o);
      this.ambNodes.push(o);
    }

    if (this.whiteBuf) {
      const wind = ctx.createBufferSource();
      wind.buffer = this.whiteBuf;
      wind.loop = true;
      wind.playbackRate.value = 0.35;
      const wf = ctx.createBiquadFilter();
      wf.type = 'bandpass';
      wf.frequency.value = 520;
      wf.Q.value = 1.2;
      const wg = ctx.createGain();
      wg.gain.value = 0;
      wg.gain.setTargetAtTime(0.05, t, 3);
      wind.connect(wf);
      wf.connect(wg);
      wg.connect(calm);
      wind.start();
      this.ambNodes.push(wind);
      this.ambWindFilter = wf;

      // Le souffle respire très lentement : la bande passante dérive.
      const breath = ctx.createOscillator();
      breath.type = 'sine';
      breath.frequency.value = 0.055;
      const bg = ctx.createGain();
      bg.gain.value = 180;
      breath.connect(bg);
      bg.connect(wf.frequency);
      breath.start();
      this.ambNodes.push(breath);
    }

    /* --- Couche d'alarme : le château est réveillé --- */
    const alarmLayer = ctx.createGain();
    alarmLayer.gain.value = 0;
    alarmLayer.connect(bus);
    this.ambAlarmGain = alarmLayer;

    // Un intervalle serré qui bat : impossible d'ignorer, jamais strident.
    for (const f of [174, 184.5]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 620;
      lp.Q.value = 1.6;
      const g = ctx.createGain();
      g.gain.value = 0.035;
      o.connect(lp);
      lp.connect(g);
      g.connect(alarmLayer);
      o.start();
      this.ambNodes.push(o);
    }

    // Une pulsation lente par-dessus, comme un guet qui fait les cent pas.
    const pulseGain = ctx.createGain();
    pulseGain.gain.value = 0.5;
    pulseGain.connect(alarmLayer);
    const pulse = ctx.createOscillator();
    pulse.type = 'sine';
    pulse.frequency.value = 0.5;
    const pg = ctx.createGain();
    pg.gain.value = 0.45;
    pulse.connect(pg);
    pg.connect(pulseGain.gain);
    pulse.start();
    this.ambNodes.push(pulse);

    const shimmer = ctx.createOscillator();
    shimmer.type = 'sine';
    shimmer.frequency.value = 1420;
    const sg = ctx.createGain();
    sg.gain.value = 0.012;
    shimmer.connect(sg);
    sg.connect(pulseGain);
    shimmer.start();
    this.ambNodes.push(shimmer);
  }

  /* ================================================================== */
  /* Sons d'interface — hors du monde, jamais spatialisés               */
  /* ================================================================== */

  ui(kind: 'click' | 'ready' | 'deny' | 'tick' | 'win' | 'lose' | 'place' | 'remove'): void {
    switch (kind) {
      case 'click': {
        const b = this.begin(0.34, 0.16, null, this.uiBus);
        if (!b) return;
        this.ring(b, b.t, 1560, 0.4, 0.06, 3);
        this.grain(b, b.t, 3200, 0.22, 0.015);
        break;
      }
      case 'ready': {
        const b = this.begin(0.45, 0.6, null, this.uiBus);
        if (!b) return;
        this.ring(b, b.t, 523, 0.4, 0.22);
        this.ring(b, b.t + 0.1, 784, 0.4, 0.34);
        this.ring(b, b.t + 0.1, 1046, 0.14, 0.3);
        break;
      }
      case 'deny': {
        const b = this.begin(0.38, 0.32, null, this.uiBus);
        if (!b) return;
        const t = b.t;
        for (const f of [138, 146]) {
          const o = b.osc('square', f, t, t + 0.24);
          const lp = this.filter(b, 'lowpass', 900, 1.2);
          const g = this.env(b, t, 0.28, 0.006, 0.2);
          o.connect(lp);
          lp.connect(g);
          g.connect(b.out);
        }
        break;
      }
      case 'tick': {
        const b = this.begin(0.3, 0.12, null, this.uiBus);
        if (!b) return;
        this.ring(b, b.t, 1180, 0.4, 0.05, 2);
        break;
      }
      case 'win': {
        const b = this.begin(0.6, 2.2, null, this.uiBus);
        if (!b) return;
        const t = b.t;
        const notes = [392, 494, 587, 784];
        for (let i = 0; i < notes.length; i++) {
          const at = t + i * 0.13;
          this.ring(b, at, notes[i], 0.34, i === notes.length - 1 ? 1.6 : 0.5);
          this.ring(b, at, notes[i] * 2, 0.1, 0.4, 7);
        }
        this.thump(b, t, 196, 98, 0.3, 0.5);
        break;
      }
      case 'lose': {
        const b = this.begin(0.55, 2.4, null, this.uiBus);
        if (!b) return;
        const t = b.t;
        const notes = [440, 349, 262, 175];
        for (let i = 0; i < notes.length; i++) {
          const at = t + i * 0.17;
          this.ring(b, at, notes[i], 0.3, i === notes.length - 1 ? 1.8 : 0.6, 6);
        }
        const o = b.osc('sawtooth', 88, t, t + 2);
        o.frequency.exponentialRampToValueAtTime(44, t + 1.7);
        const lp = this.filter(b, 'lowpass', 400, 1.2);
        const g = this.swell(b, t, 0.22, 0.2, 0.5, 1.2);
        o.connect(lp);
        lp.connect(g);
        g.connect(b.out);
        break;
      }
      case 'place': {
        const b = this.begin(0.4, 0.3, null, this.uiBus);
        if (!b) return;
        const t = b.t;
        // Une pierre posée bien à plat : mat, franc, satisfaisant.
        this.thump(b, t, 168, 74, 0.6, 0.13);
        const n = b.noise(t, t + 0.2, 'brown');
        const f = this.filter(b, 'lowpass', 900, 1);
        const g = this.env(b, t, 0.4, 0.003, 0.1);
        n.connect(f);
        f.connect(g);
        g.connect(b.out);
        this.grain(b, t, 1900, 0.16, 0.025);
        break;
      }
      case 'remove': {
        const b = this.begin(0.32, 0.26, null, this.uiBus);
        if (!b) return;
        const t = b.t;
        // On retire : ça monte au lieu de descendre.
        this.whoosh(b, t, 500, 1900, 0.16, 0.5, 2);
        const o = b.osc('triangle', 300, t, t + 0.14);
        o.frequency.exponentialRampToValueAtTime(520, t + 0.1);
        const g = this.env(b, t, 0.2, 0.004, 0.1);
        o.connect(g);
        g.connect(b.out);
        break;
      }
      default:
        break;
    }
  }

  /* ================================================================== */
  /* Séquenceur et ménage                                               */
  /* ================================================================== */

  /**
   * Tourne toutes les 40 ms : programme les battements un peu à l'avance (le
   * `setInterval` n'est pas assez régulier pour un rythme) et débranche les
   * voix terminées.
   */
  private sweep(): void {
    const ctx = this.ctx;
    if (!ctx || this.dead) return;
    const now = ctx.currentTime;

    /* --- Ménage : rien ne doit s'accumuler sur une manche de 3 minutes --- */
    for (const list of [this.voices, this.dying]) {
      for (let i = list.length - 1; i >= 0; i--) {
        const v = list[i];
        if (v.end <= now) {
          this.unplug(v);
          list.splice(i, 1);
        }
      }
    }

    /* --- Battement --- */
    // Personne n'a donné de nouvelles : on se tait plutôt que d'inventer.
    const stale = now - this.hbLast > 0.6;
    if (stale || this.mute) {
      this.hbNext = now + 0.1;
      return;
    }
    const { period, level } = this.heartbeatShape();
    if (this.hbNext < now) this.hbNext = now + 0.03;
    while (this.hbNext < now + LOOKAHEAD) {
      if (level > 0.01) this.beat(this.hbNext, level, period);
      this.hbNext += period;
    }
  }
}
