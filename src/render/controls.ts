/**
 * Clavier et souris → `InputFrame`.
 *
 * Vit côté rendu, jamais dans `src/game` : la simulation doit rester
 * exécutable dans un test Node, sans DOM (§18).
 *
 * Le schéma est symétrique entre les deux rôles, ce qui évite de réapprendre
 * les touches à chaque manche : **Espace maintenu est la grande touche des
 * deux camps** — courir pour l'Envahisseur, entrer en Scrutation pour le
 * Châtelain. Aucun des deux ne peut faire les deux, la touche n'est donc
 * jamais ambiguë.
 *
 * Les déplacements acceptent WASD, ZQSD et les flèches : un joueur français ne
 * doit pas avoir à changer de clavier pour jouer.
 */

import type { Gait, InputFrame, Role, Vec } from '@/game/types';
import { emptyInput } from '@/game/types';

export interface ControlSnapshot {
  move: Vec;
  aim: number;
  gait: Gait;
  primary: boolean;
  parry: boolean;
  scry: boolean;
  interact: boolean;
  /** Impulsions consommées une seule fois. */
  dodge: boolean;
  tool: number;
  device: number;
  rearm: number;
}

const UP = new Set(['KeyW', 'KeyZ', 'ArrowUp']);
const DOWN = new Set(['KeyS', 'ArrowDown']);
const LEFT = new Set(['KeyA', 'KeyQ', 'ArrowLeft']);
const RIGHT = new Set(['KeyD', 'ArrowRight']);
/** Touches dont on retire le comportement par défaut du navigateur. */
const SWALLOW = new Set([
  ...UP,
  ...DOWN,
  ...LEFT,
  ...RIGHT,
  'Space',
  'ShiftLeft',
  'ShiftRight',
  'KeyE',
  'KeyF',
  'KeyR',
  'Digit1',
  'Digit2',
  'Digit3',
  'Digit4',
  'Digit5',
  'Digit6',
]);

export class Controls {
  private keys = new Set<string>();
  private mouse: Vec = { x: 0, y: 0 };
  private primary = false;
  private parry = false;
  private pendingDodge = false;
  private pendingTool = -1;
  private pendingDevice = -1;
  private pendingRearm = -1;
  private detach: (() => void)[] = [];
  private el: HTMLElement;
  private enabled = true;

  /** Angle de visée courant, en radians, dans le repère monde. */
  aim = 0;

  constructor(el: HTMLElement) {
    this.el = el;
    const onKeyDown = (e: KeyboardEvent) => {
      if (!this.enabled) return;
      // On ne vole jamais le clavier à un champ de saisie.
      if (isTypingTarget(e.target)) return;
      if (e.repeat) {
        if (SWALLOW.has(e.code)) e.preventDefault();
        return;
      }
      this.keys.add(e.code);
      if (e.code === 'KeyF') this.pendingDodge = true;
      if (e.code === 'Digit1') this.pendingTool = 0;
      if (e.code === 'Digit2') this.pendingTool = 1;
      if (e.code === 'Digit3') this.pendingTool = 2;
      if (SWALLOW.has(e.code)) e.preventDefault();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      this.keys.delete(e.code);
    };
    const onBlur = () => {
      // Perdre le focus ne doit pas laisser le personnage courir tout seul.
      this.keys.clear();
      this.primary = false;
      this.parry = false;
    };
    const onMove = (e: PointerEvent) => {
      const rect = this.el.getBoundingClientRect();
      this.mouse = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    const onDown = (e: PointerEvent) => {
      if (!this.enabled) return;
      if (e.button === 0) this.primary = true;
      if (e.button === 2) this.parry = true;
      this.el.focus();
    };
    const onUp = (e: PointerEvent) => {
      if (e.button === 0) this.primary = false;
      if (e.button === 2) this.parry = false;
    };
    const onContext = (e: Event) => e.preventDefault();

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerdown', onDown);
    window.addEventListener('pointerup', onUp);
    el.addEventListener('contextmenu', onContext);

    this.detach = [
      () => window.removeEventListener('keydown', onKeyDown),
      () => window.removeEventListener('keyup', onKeyUp),
      () => window.removeEventListener('blur', onBlur),
      () => el.removeEventListener('pointermove', onMove),
      () => el.removeEventListener('pointerdown', onDown),
      () => window.removeEventListener('pointerup', onUp),
      () => el.removeEventListener('contextmenu', onContext),
    ];
  }

  setEnabled(v: boolean): void {
    this.enabled = v;
    if (!v) {
      this.keys.clear();
      this.primary = false;
      this.parry = false;
    }
  }

  /** Position du curseur, en pixels écran relatifs au canvas. */
  pointer(): Vec {
    return this.mouse;
  }

  triggerDevice(id: number): void {
    this.pendingDevice = id;
  }

  triggerRearm(id: number): void {
    this.pendingRearm = id;
  }

  triggerTool(i: number): void {
    this.pendingTool = i;
  }

  /**
   * Produit la trame d'entrée du tick. Les impulsions (esquive, outil,
   * mécanisme) sont consommées : elles ne valent que pour ce tick.
   */
  frame(role: Role, aimWorld: number, seq: number, t: number): InputFrame {
    const f = emptyInput(seq);
    f.t = t;

    let mx = 0;
    let my = 0;
    for (const k of this.keys) {
      if (UP.has(k)) my -= 1;
      else if (DOWN.has(k)) my += 1;
      else if (LEFT.has(k)) mx -= 1;
      else if (RIGHT.has(k)) mx += 1;
    }
    const len = Math.hypot(mx, my);
    f.move = len > 0 ? { x: mx / len, y: my / len } : { x: 0, y: 0 };
    f.aim = aimWorld;

    const shift = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    const space = this.keys.has('Space');

    if (role === 'invader') {
      // Prudente sur Maj : c'est l'allure la plus utilisée, donc la touche la
      // plus confortable. Course sur Espace, maintenue.
      f.gait = shift ? 'careful' : space ? 'run' : 'normal';
      f.scry = false;
    } else {
      f.gait = 'normal';
      f.scry = space;
    }

    f.primary = this.primary;
    f.parry = this.parry;
    f.interact = this.keys.has('KeyE');
    f.dodge = this.pendingDodge;
    f.tool = this.pendingTool;
    f.device = this.pendingDevice;
    f.rearm = this.pendingRearm;

    this.pendingDodge = false;
    this.pendingTool = -1;
    this.pendingDevice = -1;
    this.pendingRearm = -1;
    return f;
  }

  dispose(): void {
    for (const d of this.detach) d();
    this.detach = [];
  }
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable;
}

/** Aide-mémoire affiché au joueur, dans sa langue et sans jargon. */
export function controlHints(role: Role): { keys: string; label: string }[] {
  const common = [
    { keys: 'ZQSD / WASD', label: 'Se déplacer' },
    { keys: 'Souris', label: 'Viser' },
    { keys: 'Clic gauche', label: 'Frapper' },
  ];
  if (role === 'invader') {
    return [
      ...common,
      { keys: 'Clic droit', label: 'Parer (maintenu)' },
      { keys: 'Maj', label: 'Avancer prudemment (maintenu)' },
      { keys: 'Espace', label: 'Courir (maintenu)' },
      { keys: 'F', label: 'Esquiver' },
      { keys: 'E', label: 'Allumer un brasero' },
      { keys: '1 2 3', label: 'Outils' },
    ];
  }
  return [
    ...common,
    { keys: 'Espace', label: 'Scrutation (maintenu)' },
    { keys: 'Clic en Scrutation', label: 'Déclencher un mécanisme' },
    { keys: 'E', label: 'Interagir' },
  ];
}
