/**
 * Castle Siege — toutes les constantes de gameplay.
 *
 * Règle absolue (§17) : aucune valeur de réglage ne vit ailleurs que dans ce
 * fichier. Le panneau de debug mute directement ces objets en direct, donc
 * l'export est volontairement un objet mutable et non un `as const` figé.
 *
 * Unités :
 *  - distances en TUILES (converties en pixels par TILE là où c'est nécessaire)
 *  - vitesses en tuiles / seconde
 *  - durées en secondes
 */

export const TILE = 32;
export const GRID_W = 24;
export const GRID_H = 24;
export const WORLD_W = GRID_W * TILE;
export const WORLD_H = GRID_H * TILE;

/** Pas de simulation fixe : 30 ticks/s, autoritatif côté hôte (§13). */
export const TICK_HZ = 30;
export const TICK_DT = 1 / TICK_HZ;
/** Au-delà, on abandonne le rattrapage (onglet en arrière-plan, §18). */
export const MAX_CATCHUP_TICKS = 8;

export const CFG = {
  /* ------------------------------------------------------------------ */
  /* Rythme du match (§3)                                               */
  /* ------------------------------------------------------------------ */
  match: {
    prepBuild: 40, // manches 1 et 2 — poser ses guets et son Cœur
    prepRedress: 25, // manches 3 et 4 — réaménagement
    prepTiebreak: 30, // manche décisive
    roundDuration: 180,
    tiebreakDuration: 120,
    /** Part du budget rendue au défenseur au réaménagement. */
    redressRefund: 0.4,
    roundEndScreen: 10,
    /** Délai avant que la manche démarre vraiment (compte à rebours 3-2-1). */
    countdown: 3,
  },

  /* ------------------------------------------------------------------ */
  /* Envahisseur — la mécanique centrale (§4)                            */
  /* ------------------------------------------------------------------ */
  invader: {
    baseSpeed: 3.4, // tuiles/s en allure normale
    gait: {
      careful: {
        speedMul: 0.45,
        /** Rayon de révélation des indices, en tuiles. */
        senseRadius: 2.5,
        /** Ne nécessite pas de lumière pour lire un indice. */
        needsLight: false,
        noise: 0,
        canParry: false,
        canAttack: true,
        zoom: 2.85,
      },
      normal: {
        speedMul: 1,
        senseRadius: 1,
        needsLight: true,
        noise: 6, // rayon d'audibilité, en tuiles
        canParry: true,
        canAttack: true,
        zoom: 2.6,
      },
      run: {
        speedMul: 1.55,
        senseRadius: 0,
        needsLight: true,
        noise: 999, // tout le quart de château → en pratique, partout
        canParry: false,
        canAttack: false,
        zoom: 2.3,
      },
    },
    radius: 0.32, // rayon de collision, en tuiles
    maxHp: 100,
    /** Temps de fondu d'un indice qui entre / sort du rayon de perception. */
    tellFade: 0.22,
    /** Accélération : 0 = téléportation d'inertie, plus haut = plus nerveux. */
    accel: 26,
    friction: 22,
  },

  /* ------------------------------------------------------------------ */
  /* Châtelain — Scrutation et Influence (§5)                            */
  /* ------------------------------------------------------------------ */
  castellan: {
    /** Il ne court pas : il connaît les raccourcis, il ne sprinte pas. */
    baseSpeed: 3.4,
    radius: 0.32,
    maxHp: 100,
    /** Régénération de PV dans la salle du Cœur uniquement. */
    heartHpRegen: 3,
    influenceMax: 100,
    influenceStart: 55,
    influenceRegen: 2,
    influenceRegenHeart: 7,
    /** Après la capture à 50 %, le Cœur ne recharge plus. */
    influenceRegenHeartBreached: 2,
    scryDrain: 5,
    /** Influence minimale pour entrer en Scrutation. */
    scryMinInfluence: 6,
    /** Reprise en main à la sortie de Scrutation : pas d'attaque pendant. */
    scryRecover: 0.4,
    /** Montée / descente de la caméra de Scrutation, en secondes. */
    scryLift: 0.28,
    /** Réarmer un piège déjà utilisé. */
    rearmCost: 15,
    rearmTime: 1.2,
    /** Le corps du Châtelain est audible par l'Envahisseur à ce rayon. */
    footstepRadius: 5.5,
  },

  /* ------------------------------------------------------------------ */
  /* Le Cœur du Château (§6)                                             */
  /* ------------------------------------------------------------------ */
  heart: {
    captureTime: 20,
    /** La progression se suspend (elle ne recule JAMAIS). */
    breachAt: 0.5,
    /** Rayon de désactivation des pièges au seuil de 50 %, en tuiles. */
    breachRadius: 5,
    /** Rayon de la salle du Cœur pour la capture / la contestation. */
    roomRadius: 2.6,
    /** Portée audible du battement (navigation sans minimap, §10). */
    heartbeatRadius: 14,
  },

  alarm: {
    /** Déclenchée au premier des deux : entrée dans la salle, ou ce chrono. */
    timeLeftTrigger: 90,
    influenceGift: 30,
    revealDuration: 5,
    /** Durée du flash / bascule de couleur. */
    flash: 1.6,
  },

  /* ------------------------------------------------------------------ */
  /* Braseros (§7)                                                       */
  /* ------------------------------------------------------------------ */
  brazier: {
    count: 3,
    lightTime: 2,
    timeBonus: 25,
    maxLit: 2,
    lightRadius: 7,
  },

  /* ------------------------------------------------------------------ */
  /* Combat (§9)                                                         */
  /* ------------------------------------------------------------------ */
  combat: {
    /** Interruption sur coup encaissé : c'est ce qui rend l'échange lisible. */
    hitstun: 0.2,
    /** Invulnérabilité après un coup, évite le double-hit d'une même frappe. */
    invulnAfterHit: 0.28,
    maxSingleHit: 55, // garde-fou §9 : personne ne meurt d'un coup surprise

    sword: {
      damage: 25,
      range: 1.2,
      arc: Math.PI / 2, // 90°
      windup: 0.12,
      recovery: 0.5,
      knockback: 0.5,
    },
    // Identique à l'épée de l'Envahisseur : les deux camps portent la même
    // lame, l'avantage du Châtelain vient du terrain, pas de l'acier.
    castellanBlade: {
      damage: 25,
      range: 1.2,
      arc: Math.PI / 2,
      windup: 0.12,
      recovery: 0.5,
      knockback: 0.5,
    },
    parry: {
      reduction: 0.7,
      arc: Math.PI * 0.6,
      /** Immobilise pendant la garde. */
      speedMul: 0,
      /** Fenêtre de parade parfaite : renvoie l'attaquant. */
      perfectWindow: 0.18,
      perfectStagger: 0.7,
    },
    dodge: {
      duration: 0.3,
      invuln: 0.3,
      distance: 1.9, // tuiles
      cooldown: 3,
    },
    // L'arbalète est l'arme de base des DEUX camps. Son carreau rebondit sur
    // les murs jusqu'à trois fois : un tir raté continue de vivre dans le
    // couloir — y compris pour celui qui l'a tiré.
    crossbow: {
      damage: 40,
      speed: 13, // tuiles/s — visible et esquivable
      reload: 2.5,
      windup: 0.2,
      bounces: 3,
      /** Durée de vie d'un carreau, en secondes. */
      lifetime: 2.6,
      /** Avant le premier rebond, le tireur est immunisé ce court instant. */
      selfGrace: 0.25,
    },
  },

  /* ------------------------------------------------------------------ */
  /* Guets du Châtelain : trois yeux posés à la préparation              */
  /* ------------------------------------------------------------------ */
  //
  // Un guet ne sonne plus : il REGARDE. Tant que l'Envahisseur est dans son
  // cercle, le Châtelain le voit en direct, à travers les murs.
  //
  // Trois zones de vision permanentes seraient de l'omniscience gratuite, ce
  // que la section 2 interdit. Deux garde-fous rendent l'outil jouable des deux
  // côtés :
  //  - une réserve de veille : un guet ne peut regarder qu'un temps total,
  //    après quoi il s'éteint pour la manche. L'Envahisseur peut donc l'user
  //    volontairement, et le Châtelain doit choisir quand ça vaut le coup ;
  //  - l'Envahisseur SAIT qu'il est vu : l'œil s'allume sous ses yeux quand il
  //    entre dans le cercle. Une information qui arrive sans qu'on puisse rien
  //    en faire n'est pas du jeu, c'est une punition.
  sensors: {
    count: 3,
    /** Rayon de veille, en tuiles. */
    radius: 4,
    /** Réserve de veille d'un guet, en secondes cumulées. */
    watchTime: 18,
    /** Rémanence du dernier point de passage après la sortie du cercle. */
    pingDuration: 8,
    label: 'Œil de guet',
    plural: 'Yeux de guet',
  },

  /* ------------------------------------------------------------------ */
  /* Économie de préparation (§8)                                        */
  /* ------------------------------------------------------------------ */
  budget: {
    castellan: 100,
    invader: 60,
    maxTools: 3,
  },

  /** Pièges automatiques. `tell` désigne l'apparence de l'indice. */
  traps: {
    spikes: {
      cost: 15,
      damage: 35,
      immobilize: 1,
      label: 'Fosse à pics',
      tell: 'seam' as TellKind,
      tellLabel: 'dalles jointoyées trop nettement',
      radius: 0.62,
      rearmable: true,
    },
    arrows: {
      cost: 12,
      damage: 25,
      immobilize: 0,
      knockback: 1.4,
      label: 'Flèches murales',
      tell: 'slit' as TellKind,
      tellLabel: "trous d'archère dans le mur",
      radius: 0.62,
      rearmable: true,
    },
    collapse: {
      cost: 10,
      damage: 20,
      immobilize: 0,
      label: 'Sol effondrable',
      tell: 'crack' as TellKind,
      tellLabel: 'fissures rayonnantes',
      radius: 0.62,
      /** La tuile devient un trou définitif. */
      rearmable: false,
    },
    boulder: {
      cost: 18,
      damage: 45,
      immobilize: 0,
      knockback: 1.1,
      label: 'Rocher tombant',
      tell: 'dust' as TellKind,
      tellLabel: 'poussière au sol, ombre au plafond',
      radius: 1.1, // effet 2×2
      rearmable: true,
    },
    chest: {
      cost: 8,
      damage: 30,
      immobilize: 0,
      label: 'Coffre piégé',
      tell: 'chest' as TellKind,
      tellLabel: 'serrure sans usure',
      radius: 0.7,
      /** Appât : visible même sans allure prudente. */
      alwaysVisible: true,
      rearmable: true,
    },
    decoy: {
      cost: 2,
      damage: 0,
      immobilize: 0,
      label: 'Faux indice',
      tell: 'seam' as TellKind, // remplacé par l'apparence choisie à la pose
      tellLabel: 'identique à un vrai',
      radius: 0.62,
      rearmable: false,
    },
  },

  /** Mécanismes activables en Scrutation. */
  devices: {
    portcullis: {
      cost: 12,
      influence: 10,
      duration: 12,
      label: 'Herse',
      hint: 'Bloque un couloir 12 s',
    },
    chandelier: {
      cost: 15,
      influence: 20,
      damage: 45,
      radius: 1.6,
      once: true,
      label: 'Lustre',
      hint: '45 dégâts en zone, une seule fois',
    },
    trapdoor: {
      cost: 14,
      influence: 15,
      immobilize: 2,
      reveal: 5,
      radius: 0.9,
      label: 'Trappe',
      hint: 'Immobilise 2 s, révèle 5 s',
    },
    hound: {
      cost: 25,
      influence: 25,
      duration: 20,
      speed: 3.1,
      damage: 12,
      biteCooldown: 1.1,
      hp: 60,
      label: 'Molosse en cage',
      hint: 'Poursuite pendant 20 s',
    },
    cavein: {
      cost: 10,
      influence: 20,
      label: 'Éboulement',
      hint: 'Condamne un passage définitivement',
    },
    douse: {
      cost: 6,
      influence: 10,
      duration: 15,
      radius: 8,
      label: 'Extinction',
      hint: "Éteint les torches d'une aile 15 s",
    },
  },

  /** Aménagements divers du Châtelain. */
  fixtures: {
    lockDoor: { cost: 3, label: 'Porte verrouillée' },
    secretDoor: { cost: 5, label: 'Passage secret' },
  },

  /** Équipement de l'Envahisseur. */
  tools: {
    crossbow: { cost: 20, uses: Infinity, label: 'Arbalète', hint: '55 dégâts, 2,5 s de recharge' },
    probe: { cost: 12, uses: 2, label: 'Sonde', hint: "Révèle les indices d'une pièce entière" },
    grapple: { cost: 15, uses: 3, label: 'Grappin', hint: 'Franchit une fosse, un trou, un mur bas' },
    bombs: { cost: 12, uses: 2, label: 'Bombes', hint: 'Ouvre un mur fragile, 35 dégâts en zone' },
    elixir: { cost: 10, uses: 1, label: 'Élixir', hint: '40 PV, 2 s vulnérable' },
    buckler: { cost: 12, uses: 1, label: 'Écu', hint: 'Absorbe 60 dégâts pendant 5 s' },
    stolenmap: { cost: 10, uses: 0, label: 'Plan volé', hint: 'Révèle le tracé des murs' },
  },

  toolParams: {
    probe: { radius: 6, castTime: 0.6, revealDuration: 8 },
    grapple: { range: 3.6, travelSpeed: 13 },
    bombs: { damage: 35, radius: 1.5, fuse: 1.1, throwSpeed: 8, throwRange: 3.5 },
    elixir: { heal: 40, castTime: 2 },
    buckler: { absorb: 60, duration: 5 },
  },

  /** Renseignements achetés sur le même budget (§8). */
  intel: {
    heart: { cost: 14, label: 'Emplacement du Cœur', hint: 'Élimine 2 des 3 candidats' },
    brazier: { cost: 6, label: "Position d'un brasero", hint: 'Un brasero est marqué sur le plan' },
    budget: { cost: 12, label: 'Répartition adverse', hint: 'Combien de pièges, de mécanismes, de faux' },
  },

  /* ------------------------------------------------------------------ */
  /* Perception, lumière, brouillard (§14 / §15)                         */
  /* ------------------------------------------------------------------ */
  vision: {
    /** Portée de la ligne de vue de l'Envahisseur, en tuiles. */
    invaderRange: 9.5,
    castellanRange: 8.5,
    /** Cône de vision : au-delà, on ne voit qu'à courte distance. */
    coneHalfAngle: Math.PI * 0.42,
    coneFalloffRange: 2.6,
    /** Rayon d'une torche murale. */
    torchRadius: 4.6,
    /** Luminosité minimale d'une pièce déjà explorée (mémoire du plan). */
    memoryBrightness: 0.2,
    /** Seuil de luminosité pour "être dans la lumière" (allure normale). */
    lightThreshold: 0.34,
    /** Vitesse d'ouverture / fermeture du brouillard. */
    fogFade: 3.5,
  },

  /* ------------------------------------------------------------------ */
  /* Caméra et retour d'écran (§15)                                      */
  /* ------------------------------------------------------------------ */
  camera: {
    /** Lissage du suivi : plus haut = plus collé au joueur. */
    follow: 9,
    /** Lissage du zoom lors d'un changement d'allure. */
    zoomLerp: 9,
    /** Avance de la caméra dans la direction du regard, en tuiles. */
    lead: 0.9,
    shakeDecay: 6,
    castellanZoom: 2.6,
    /** Zoom de Scrutation : calculé pour que tout le château tienne. */
    scryPadding: 24,
  },

  feel: {
    /** Tremblement par point de dégât encaissé. */
    shakePerDamage: 0.16,
    shakeMax: 14,
    lowHpVignette: 30,
    hitFlash: 0.18,
    /** Vignette de rejeu du piège offerte au Châtelain (§11). */
    replayDuration: 2,
    replayLead: 0.9,
  },

  audio: {
    master: 0.7,
    /** Battement du Cœur : période au plus loin / au plus près. */
    heartbeatSlow: 1.5,
    heartbeatFast: 0.62,
    /** Sous ce temps restant, la pulsation s'emballe pour les deux joueurs. */
    finalRush: 15,
  },

  net: {
    inputHz: 30,
    snapshotHz: 20,
    /** Tampon d'interpolation des entités distantes, en secondes. */
    interpDelay: 0.1,
    /** Réconciliation : au-delà de cet écart en tuiles, on recale sèchement. */
    hardSnapDistance: 2.4,
    /** Lissage du recalage doux. */
    reconcileLerp: 14,
    disconnectGrace: 30,
  },
};

/** Type mutable pour le panneau de debug (§17). */
export type GameConfig = typeof CFG;

/** Zoom de Scrutation : le château entier doit tenir à l'écran. */
export function scryZoom(viewW: number, viewH: number): number {
  const pad = CFG.camera.scryPadding * 2;
  return Math.min((viewW - pad) / WORLD_W, (viewH - pad) / WORLD_H);
}

export type TrapKind = keyof typeof CFG.traps;
export type DeviceKind = keyof typeof CFG.devices;
export type ToolKind = keyof typeof CFG.tools;
export type IntelKind = keyof typeof CFG.intel;
export type TellKind = 'seam' | 'slit' | 'crack' | 'dust' | 'chest';

export const TRAP_KINDS = Object.keys(CFG.traps) as TrapKind[];
export const DEVICE_KINDS = Object.keys(CFG.devices) as DeviceKind[];
export const TOOL_KINDS = Object.keys(CFG.tools) as ToolKind[];
export const INTEL_KINDS = Object.keys(CFG.intel) as IntelKind[];
/** Apparences d'indice disponibles pour un faux indice. */
export const TELL_KINDS: TellKind[] = ['seam', 'slit', 'crack', 'dust', 'chest'];
