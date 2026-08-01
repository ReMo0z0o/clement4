/**
 * Test de bout en bout, deux onglets.
 *
 *   npm run dev        (dans un autre terminal)
 *   npm run e2e
 *
 * Joue une session complète — créer, rejoindre, choisir un château, préparer,
 * envahir — dans un vrai navigateur, et échoue sur la moindre erreur de
 * console. C'est le seul contrôle qui prouve que le jeu *tourne* : un build qui
 * passe ne dit rien du câblage entre React, le canvas et le réseau.
 *
 * Il a déjà attrapé trois bogues qu'aucun test unitaire ne pouvait voir : un
 * nettoyage React qui fermait la connexion à peine ouverte, un Châtelain qui ne
 * recevait jamais les tuiles de son propre château, et un rendu illisible.
 */

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = process.env.E2E_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SHOTS ?? '';
const EXE = process.env.PLAYWRIGHT_CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const shot = async (page, name) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
};

const problems = [];
const step = (msg) => console.log(`  · ${msg}`);

const browser = await chromium.launch({ executablePath: EXE }).catch(() => chromium.launch());
const context = await browser.newContext({ viewport: { width: 1360, height: 860 } });

const host = await context.newPage();
const guest = await context.newPage();
for (const [name, page] of [
  ['hôte', host],
  ['invité', guest],
]) {
  page.on('console', (m) => {
    // Les 404 de développement (favicon, source maps) ne concernent pas le jeu.
    if (m.type() === 'error' && !/404|Failed to load resource/.test(m.text())) {
      problems.push(`[${name}] ${m.text()}`);
    }
  });
  page.on('pageerror', (e) => problems.push(`[${name}] ${e.message}`));
}

console.log('Test de bout en bout — deux onglets\n');

await host.goto(URL, { waitUntil: 'networkidle' });
await guest.goto(URL, { waitUntil: 'networkidle' });
step('lobby chargé des deux côtés');
await shot(host, '01-lobby');

await host.getByRole('button', { name: /créer/i }).first().click();
await host.waitForTimeout(1200);
const code = (await host.locator('.session-code').first().innerText()).replace(/\s/g, '');
if (!/^[A-Z2-9]{6}$/.test(code)) problems.push(`Code de session invalide : « ${code} »`);
step(`partie créée, code ${code}`);

await guest.locator('input[type="text"], input:not([type])').first().fill(code);
await guest.getByRole('button', { name: /rejoindre/i }).last().click();
await guest.waitForTimeout(2200);

const seen = await host.innerText('body');
if (!/adversaire est arrivé|adversaire est prêt/i.test(seen)) {
  problems.push('L’hôte ne voit pas son adversaire arriver.');
}
step('les deux joueurs sont connectés');

// Chacun choisit son château, puis se déclare prêt.
await host.getByRole('radio').nth(0).click();
await guest.getByRole('radio').nth(1).click();
for (const p of [host, guest]) {
  await p.getByRole('button', { name: /^Je suis prêt$/ }).click();
  await p.waitForTimeout(250);
}
await host.waitForTimeout(2500);
await shot(host, '02-prep-castellan');
await shot(guest, '03-prep-invader');

const prepHost = await host.innerText('body');
const prepGuest = await guest.innerText('body');
if (!/Budget de construction/i.test(prepHost)) problems.push('Le Châtelain n’a pas d’écran de construction.');
if (!/Outils/i.test(prepGuest)) problems.push('L’Envahisseur n’a pas d’écran d’équipement.');
step('préparation : le Châtelain construit, l’Envahisseur s’équipe');

// Le Châtelain pose quelques pièges sur son plan.
const planCanvas = host.locator('canvas').first();
const box = await planCanvas.boundingBox();
for (const [fx, fy] of [
  [0.45, 0.45],
  [0.5, 0.42],
  [0.42, 0.5],
  [0.55, 0.55],
]) {
  await host.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
  await host.waitForTimeout(120);
}
// L'Envahisseur achète deux outils.
const tools = guest.getByRole('button').filter({ hasText: /Arbalète|Sonde|Grappin/ });
for (let i = 0; i < Math.min(2, await tools.count()); i++) {
  await tools.nth(i).click();
  await guest.waitForTimeout(100);
}
step('pièges posés, outils achetés');

for (const p of [host, guest]) {
  const ready = p.getByRole('button', { name: /Je suis prêt/ });
  if (await ready.count()) await ready.click();
  await p.waitForTimeout(200);
}
await host.waitForTimeout(6000);

const invHost = await host.innerText('body');
const invGuest = await guest.innerText('body');
if (!/INFLUENCE/i.test(invHost)) problems.push('Le HUD du Châtelain n’affiche pas son Influence.');
if (!/PRUDENT[\s\S]*COURSE/i.test(invGuest)) problems.push('Le HUD de l’Envahisseur n’affiche pas ses allures.');
if (!/\d:\d\d/.test(invGuest)) problems.push('Le chronomètre ne tourne pas.');
step('invasion démarrée, les deux HUD sont en place');
await shot(host, '04-invasion-castellan');
await shot(guest, '05-invasion-invader');

// L'Envahisseur se déplace et change d'allure. On ramène l'onglet au premier
// plan : un onglet caché voit son `requestAnimationFrame` bridé par le
// navigateur, et sa boucle de jeu s'arrête (voir le README, mode local).
await guest.bringToFront();
await guest.locator('canvas').first().click({ position: { x: 600, y: 400 } });
const before = await guest.innerText('body');
await guest.keyboard.down('KeyD');
await guest.waitForTimeout(1400);
await guest.keyboard.down('Space');
await guest.waitForTimeout(900);
await guest.keyboard.up('Space');
await guest.keyboard.down('ShiftLeft');
await guest.waitForTimeout(900);
await guest.keyboard.up('ShiftLeft');
await guest.keyboard.up('KeyD');
const after = await guest.innerText('body');
if (before === after) problems.push('Rien ne change quand l’Envahisseur se déplace.');
step('l’Envahisseur se déplace et change d’allure');

// Le Châtelain entre en Scrutation.
await host.bringToFront();
await host.locator('canvas').first().click({ position: { x: 600, y: 400 } });
await host.keyboard.down('Space');
await host.waitForTimeout(1600);
const scrying = await host.innerText('body');
if (!/votre corps est immobile/i.test(scrying)) {
  problems.push('La Scrutation ne se signale pas au Châtelain.');
}
await shot(host, '06-scrutation');
await host.keyboard.up('Space');
step('le Châtelain entre en Scrutation');

await browser.close();

console.log('');
if (problems.length) {
  console.error(`${problems.length} problème(s) :`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}
console.log('✓ Une session complète se joue de bout en bout, sans une erreur.');
