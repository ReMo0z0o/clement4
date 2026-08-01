/**
 * Personnages en pixel-art, vus du dessus, d'après la planche de référence :
 * le Châtelain est un chevalier au heaume d'acier et à la cape bleue frappée
 * d'un château blanc ; l'Envahisseur un rôdeur à la capuche verte et au sac
 * de cuir.
 *
 * Chaque sprite est dessiné une seule fois sur un petit canvas hors écran
 * (18×18 « gros pixels »), puis agrandi sans lissage : c'est l'agrandissement
 * brut qui donne le rendu pixelisé de la planche. Le sprite est dessiné face
 * à DROITE (+x) ; le rendu le tourne vers la visée.
 */

const GRID = 18;
const CELL = 8; // résolution interne d'un « gros pixel »

type Painter = (px: (x: number, y: number, color: string, w?: number, h?: number) => void) => void;

function bake(paint: Painter): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = GRID * CELL;
  c.height = GRID * CELL;
  const g = c.getContext('2d')!;
  const px = (x: number, y: number, color: string, w = 1, h = 1) => {
    g.fillStyle = color;
    g.fillRect(Math.round(x * CELL), Math.round(y * CELL), Math.round(w * CELL), Math.round(h * CELL));
  };
  paint(px);
  return c;
}

/* ==================================================================== */
/* Palettes, prises sur la planche                                      */
/* ==================================================================== */

const K = {
  capeDark: '#274a8f',
  cape: '#3563b8',
  capeLight: '#4a7ad0',
  emblem: '#e8e6df',
  steelDark: '#5c6470',
  steel: '#8b93a1',
  steelLight: '#c2c9d4',
  gold: '#c9a24a',
  outline: '#23262e',
};

const R = {
  hoodDark: '#3e4a26',
  hood: '#5a6b35',
  hoodLight: '#75884a',
  packDark: '#4f3a24',
  pack: '#6e5233',
  packLight: '#8a6a44',
  skin: '#d9a877',
  blade: '#c2c9d4',
  outline: '#22261a',
};

/* ==================================================================== */
/* Le Châtelain : heaume, épaulières, cape frappée du château           */
/* ==================================================================== */

function paintKnight(px: Parameters<Painter>[0]): void {
  // La cape traîne derrière lui (à gauche puisqu'il regarde à droite).
  px(2, 5, K.capeDark, 6, 8);
  px(3, 4, K.cape, 5, 10);
  px(4, 5, K.capeLight, 3, 1);
  // Le château blanc de la cape : deux tours et un corps.
  px(4, 8, K.emblem, 1, 1);
  px(6, 8, K.emblem, 1, 1);
  px(4, 9, K.emblem, 3, 2);
  // Liseré d'ombre du bord de cape.
  px(2, 5, K.outline, 1, 8);
  px(3, 13, K.outline, 5, 1);
  px(3, 4, K.outline, 5, 1);

  // Épaulières : deux masses d'acier de part et d'autre du heaume.
  px(8, 3, K.steelDark, 5, 3);
  px(8, 12, K.steelDark, 5, 3);
  px(9, 3.5, K.steel, 3, 2);
  px(9, 12.5, K.steel, 3, 2);
  px(9, 3.5, K.steelLight, 2, 0.7);
  px(9, 12.5, K.steelLight, 2, 0.7);

  // Le corps sous le heaume.
  px(8, 6, K.steelDark, 6, 6);

  // Le heaume : dôme d'acier, reflet, nasale dorée vers l'avant.
  px(9, 5.5, K.steel, 5, 7);
  px(10, 5, K.steel, 4, 8);
  px(13, 6.5, K.steel, 2, 5);
  px(10.5, 6, K.steelLight, 2.5, 2);
  px(14, 8, K.gold, 1.5, 2);
  // Cerne du heaume.
  px(9, 5, K.outline, 5, 0.6);
  px(9, 12.4, K.outline, 5, 0.6);

  // La lame au flanc, prête.
  px(12, 13.4, R.blade, 4, 0.9);
  px(11.4, 13.2, K.gold, 1, 1.3);
}

/* ==================================================================== */
/* L'Envahisseur : capuche verte, sac de cuir, lame courte              */
/* ==================================================================== */

function paintRogue(px: Parameters<Painter>[0]): void {
  // Le sac dans le dos (à gauche), avec rabat et sangle.
  px(3, 6, R.packDark, 4, 6);
  px(3.6, 6.6, R.pack, 3, 4.8);
  px(3.6, 6.6, R.packLight, 3, 1.2);
  px(5, 6, R.outline, 0.6, 6);
  px(3, 6, R.outline, 4, 0.5);
  px(3, 11.5, R.outline, 4, 0.5);

  // Les épaules sous la capuche.
  px(6.5, 5.5, R.hoodDark, 5, 7);

  // La capuche : dôme vert, pointe vers l'arrière, visage au bord avant.
  px(7, 5, R.hood, 6, 8);
  px(8, 4.5, R.hood, 4, 9);
  px(12, 6, R.hood, 1.6, 6);
  px(8.5, 5.4, R.hoodLight, 3, 1.6);
  // L'ombre du creux de capuche, puis le peu de visage qu'on voit.
  px(12.6, 7.4, R.outline, 1.2, 3.2);
  px(13, 8, R.skin, 0.9, 1.9);
  // Cerne.
  px(7.6, 4.4, R.outline, 4.6, 0.5);
  px(7.6, 13.1, R.outline, 4.6, 0.5);

  // La lame courte, tenue basse côté avant.
  px(12, 12.8, R.blade, 4.4, 0.8);
  px(11.4, 12.6, R.packDark, 1, 1.2);
}

/* ==================================================================== */
/* Cache et dessin                                                      */
/* ==================================================================== */

let knight: HTMLCanvasElement | null = null;
let rogue: HTMLCanvasElement | null = null;

export function drawCharacter(
  ctx: CanvasRenderingContext2D,
  kind: 'castellan' | 'invader',
  x: number,
  y: number,
  aim: number,
  sizePx: number,
  bobPhase: number,
  alpha: number,
): void {
  if (!knight) knight = bake(paintKnight);
  if (!rogue) rogue = bake(paintRogue);
  const sprite = kind === 'castellan' ? knight : rogue;

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(aim);
  // Le pas : un balancement perpendiculaire d'un demi-pixel, rien de plus.
  ctx.translate(0, Math.sin(bobPhase) * sizePx * 0.03);
  ctx.globalAlpha = alpha;
  // Le lissage est coupé : c'est lui qui ferait fondre les gros pixels.
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(sprite, -sizePx / 2, -sizePx / 2, sizePx, sizePx);
  ctx.imageSmoothingEnabled = true;
  ctx.restore();
}
