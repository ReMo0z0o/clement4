/**
 * Clavier et souris → `InputFrame`.
 *
 * Vit côté rendu, jamais dans `src/game` : la simulation doit rester
 * exécutable dans un test Node, sans DOM (§18).
 *
 * Le schéma est symétrique entre les deux rôles : même épée au clic gauche,
 * même arbalète au clic droit — son carreau rebondit sur les murs, à manier
 * avec respect dans un couloir. L'Envahisseur a en plus ses allures, son
 * esquive et ses trois coups d'œil à la carte (M).
 *
 * Les déplacements acceptent WASD, ZQSD et les flèches : un joueur français ne
 * doit pas avoir à changer de clavier pour jouer.
 */

import { CFG } from '@/game/config';
import type { Gait, InputFrame, Role, Vec } from '@/game/types';
import { emptyInput } from '@/game/types';

export interface ControlSnapshot {
  move: Vec;
  aim: number;
  gait: Gait;
  primary: boolean;
  scry: boolean;
  interact: boolean;
  /** Impulsions consommées une seule fois. */
  secondary: boolean;
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
  'KeyM',
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
  /**
   * Un clic gauche = UN coup d'épée. C'était l'état du bouton qui partait :
   * le garder enfoncé enchaînait les coups sans fin, et comme chaque coup
   * ralentit (armement ×0,35, récupération ×0,55), le joueur se traînait à
   * 49 % de sa vitesse — mesuré — sans comprendre pourquoi.
   */
  private pendingPrimary = false;
  private pendingSecondary = false;
  private pendingDodge = false;
  private pendingGlimpse = false;
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
      // La touche est (ré)enregistrée AVANT le filtre de répétition.
      //
      // L'ordre inverse figeait le joueur : après un Alt+Tab, le retour de
      // focus avec Z toujours enfoncé n'envoie plus que des répétitions — le
      // premier appui a eu lieu dans l'autre fenêtre. Elles étaient jetées
      // avant d'être notées, et le personnage refusait d'avancer tant qu'on ne
      // relâchait pas la touche pour la ré-enfoncer.
      this.keys.add(e.code);
      if (SWALLOW.has(e.code)) e.preventDefault();
      // Les impulsions, elles, ne partent qu'au premier appui.
      if (e.repeat) return;
      if (e.code === 'KeyF') this.pendingDodge = true;
      // La carte est sur M seulement. Sur Tab, chaque Alt+Tab aurait brûlé une
      // charge : le navigateur reçoit le Tab avant de perdre le focus.
      if (e.code === 'KeyM') this.pendingGlimpse = true;
      if (e.code === 'Digit1') this.pendingTool = 0;
      if (e.code === 'Digit2') this.pendingTool = 1;
      if (e.code === 'Digit3') this.pendingTool = 2;
    };
    const onKeyUp = (e: KeyboardEvent) => {
      this.keys.delete(e.code);
    };
    const onBlur = () => {
      // Perdre le focus ne doit pas laisser le personnage courir tout seul,
      // ni déclencher au retour une action armée juste avant de partir.
      this.keys.clear();
      this.pendingPrimary = false;
      this.pendingSecondary = false;
      this.pendingDodge = false;
      this.pendingGlimpse = false;
      this.pendingTool = -1;
    };
    const onMove = (e: PointerEvent) => {
      const rect = this.el.getBoundingClientRect();
      this.mouse = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    const onDown = (e: PointerEvent) => {
      if (!this.enabled) return;
      if (e.button === 0) this.pendingPrimary = true;
      // Clic droit : un carreau part. Une impulsion, pas un tir en rafale.
      if (e.button === 2) this.pendingSecondary = true;
      this.el.focus();
    };
    const onContext = (e: Event) => e.preventDefault();

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('contextmenu', onContext);

    this.detach = [
      () => window.removeEventListener('keydown', onKeyDown),
      () => window.removeEventListener('keyup', onKeyUp),
      () => window.removeEventListener('blur', onBlur),
      () => el.removeEventListener('pointermove', onMove),
      () => el.removeEventListener('pointerdown', onDown),
      () => el.removeEventListener('contextmenu', onContext),
    ];
  }

  setEnabled(v: boolean): void {
    this.enabled = v;
    if (!v) {
      this.keys.clear();
      this.pendingPrimary = false;
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
    } else {
      // Le Châtelain n'a plus de Scrutation : Espace ne le fige plus.
      f.gait = 'normal';
    }
    f.scry = false;

    f.primary = this.pendingPrimary;
    f.secondary = this.pendingSecondary;
    f.parry = false;
    f.interact = this.keys.has('KeyE');
    f.dodge = this.pendingDodge;
    f.glimpse = role === 'invader' && this.pendingGlimpse;
    f.tool = this.pendingTool;
    f.device = this.pendingDevice;
    f.rearm = this.pendingRearm;

    this.pendingPrimary = false;
    this.pendingSecondary = false;
    this.pendingDodge = false;
    this.pendingGlimpse = false;
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
    { keys: 'Clic gauche', label: 'Épée' },
    { keys: 'Clic droit', label: 'Arbalète — le carreau rebondit' },
  ];
  if (role === 'invader') {
    return [
      ...common,
      { keys: 'Maj', label: 'Avancer prudemment (maintenu)' },
      { keys: 'Espace', label: 'Courir (maintenu)' },
      { keys: 'F', label: 'Esquiver' },
      { keys: 'M', label: `Coup d’œil à la carte (${CFG.glimpse.charges} × ${CFG.glimpse.duration} s)` },
      { keys: 'E', label: 'Allumer un brasero' },
    ];
  }
  return common;
}
