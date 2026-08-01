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

// Plus rien à choisir : les deux se déclarent prêts, le château est tiré au sort.
for (const p of [host, guest]) {
  await p.getByRole('button', { name: /^Je suis prêt$/ }).click();
  await p.waitForTimeout(250);
}
await host.waitForTimeout(2500);
await shot(host, '02-prep-castellan');
await shot(guest, '03-prep-invader');

const prepHost = await host.innerText('body');
const prepGuest = await guest.innerText('body');
if (!/Guets posés/i.test(prepHost)) problems.push('Le Châtelain n’a pas son écran de guets.');
if (!/Ce que vous savez/i.test(prepGuest)) problems.push('L’Envahisseur n’a pas son briefing.');
step('préparation : le Châtelain pose ses guets, l’Envahisseur lit son briefing');

// Le Châtelain pose ses trois guets sur le plan (pinceau par défaut).
const planCanvas = host.locator('canvas').first();
const box = await planCanvas.boundingBox();
for (const [fx, fy] of [
  [0.45, 0.45],
  [0.6, 0.3],
  [0.3, 0.6],
  [0.55, 0.55],
]) {
  await host.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
  await host.waitForTimeout(120);
}
const guetCount = await host.innerText('body');
if (!/[1-3] \/ 3/.test(guetCount.replace(/\s+/g, ' '))) {
  problems.push('Poser un guet sur le plan ne fait pas monter le compteur.');
}
step('guets posés sur le plan');

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

/* ---- Sur un écran court, tout doit rester atteignable ----
 * C'est le bug le plus sournois d'une mise en page : un bouton coupé par un
 * conteneur en overflow-hidden n'est pas « plus bas », il est inatteignable. */
{
  const small = await browser.newContext({ viewport: { width: 1000, height: 620 } });
  const sA = await small.newPage();
  const sB = await small.newPage();
  await sA.goto(URL, { waitUntil: 'networkidle' });
  await sB.goto(URL, { waitUntil: 'networkidle' });
  await sA.getByRole('button', { name: /créer/i }).first().click();
  await sA.waitForTimeout(1200);
  const sCode = (await sA.locator('.session-code').first().innerText()).replace(/\s/g, '');
  await sB.locator('input[type="text"], input:not([type])').first().fill(sCode);
  await sB.getByRole('button', { name: /^Rejoindre$/ }).click();
  await sB.waitForTimeout(2000);
  for (const p of [sA, sB]) {
    await p.getByRole('button', { name: /^Je suis prêt$/ }).click();
    await p.waitForTimeout(200);
  }
  await sA.waitForTimeout(2000);

  for (const [who, page, needle] of [
    ['Châtelain', sA, /Retirer/],
    ['Envahisseur', sB, /Prêt|prêt/],
  ]) {
    const ok = await page.evaluate((src) => {
      const needle = new RegExp(src);
      const btns = [...document.querySelectorAll('button')];
      const target = btns.find((b) => needle.test(b.textContent || ''));
      const ready = btns.find((b) => /Je suis prêt|Prêt —/.test(b.textContent || ''));
      const reachable = (el) => {
        if (!el) return false;
        el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return r.top >= 0 && r.bottom <= window.innerHeight && Boolean(hit && (hit === el || el.contains(hit)));
      };
      return { target: reachable(target), ready: reachable(ready) };
    }, needle.source);
    if (!ok.target) problems.push(`${who}, écran 1000×620 : le bas de la palette est inatteignable.`);
    if (!ok.ready) problems.push(`${who}, écran 1000×620 : le bouton « Je suis prêt » est inatteignable.`);
  }
  step('écran court : palette entière et bouton « prêt » atteignables pour les deux rôles');
  await small.close();
}

/* ---- Le parcours qui échoue doit le dire ---- */
const lost = await context.newPage();
lost.on('pageerror', (e) => problems.push(`[perdu] ${e.message}`));
await lost.bringToFront();
await lost.goto(URL, { waitUntil: 'networkidle' });
await lost.locator('input[type="text"], input:not([type])').first().fill('QQQQQQ');
await lost.getByRole('button', { name: /^Rejoindre$/ }).click();
await lost.waitForTimeout(9500);
const lostText = (await lost.innerText('body')).replace(/\s+/g, ' ');
if (!/Vous rejoignez cette partie/.test(lostText)) {
  problems.push('Celui qui rejoint voit l’écran de l’hôte (« Dictez ce code »).');
}
if (!/Aucune partie ne porte ce code/.test(lostText)) {
  problems.push('Un code inexistant ne produit aucun message : le joueur attend sans savoir pourquoi.');
}
step('un code inexistant est signalé, avec sa cause');

/* ---- Le bouton « Ouvrir la seconde fenêtre » branche tout seul ---- */
const solo = await context.newPage();
await solo.bringToFront();
await solo.goto(URL, { waitUntil: 'networkidle' });
await solo.getByRole('button', { name: /créer/i }).first().click();
await solo.waitForTimeout(1200);
const soloCode = (await solo.locator('.session-code').first().innerText()).replace(/\s/g, '');
const invite = solo.getByRole('button', { name: /Ouvrir la seconde fenêtre/ });
if ((await invite.count()) === 0) {
  problems.push('En mode local, rien ne propose d’ouvrir la seconde fenêtre.');
} else {
  const [popup] = await Promise.all([context.waitForEvent('page'), invite.click()]);
  await popup.waitForLoadState('networkidle');
  await popup.waitForTimeout(2500);
  if (!popup.url().includes(`join=${soloCode}`)) {
    problems.push('La seconde fenêtre ne reçoit pas le code dans son adresse.');
  }
  if (!/adversaire est arrivé/.test((await solo.innerText('body')).replace(/\s+/g, ' '))) {
    problems.push('La seconde fenêtre ne rejoint pas la partie toute seule.');
  }
  step('la seconde fenêtre rejoint la partie sans rien retaper');
}

/* ---- Deux navigateurs distincts : la preuve du mode à distance ----
 * Ce test n'a de sens que si Supabase est configuré. Deux contextes séparés
 * ne partagent aucun BroadcastChannel : s'ils se rejoignent, c'est que le
 * trajet passe bien par le réseau, donc que deux personnes le peuvent aussi. */
const remote = Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
if (remote) {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const far1 = await ctxA.newPage();
  const far2 = await ctxB.newPage();
  await far1.goto(URL, { waitUntil: 'networkidle' });
  await far2.goto(URL, { waitUntil: 'networkidle' });
  await far1.getByRole('button', { name: /créer/i }).first().click();
  await far1.waitForTimeout(2500);
  const farCode = (await far1.locator('.session-code').first().innerText()).replace(/\s/g, '');
  await far2.locator('input[type="text"], input:not([type])').first().fill(farCode);
  await far2.getByRole('button', { name: /^Rejoindre$/ }).click();
  await far2.waitForTimeout(6000);
  const farText = (await far1.innerText('body')).replace(/\s+/g, ' ');
  if (!/adversaire est arrivé|adversaire est prêt/.test(farText)) {
    problems.push('Supabase est configuré, mais deux navigateurs distincts ne se rejoignent pas.');
  } else {
    step(`deux navigateurs distincts se rejoignent (code ${farCode}) — le mode à distance fonctionne`);
  }
  await ctxA.close();
  await ctxB.close();
} else {
  step('mode à distance non testé : Supabase n’est pas configuré (npm run supabase:check)');
}

await browser.close();

console.log('');
if (problems.length) {
  console.error(`${problems.length} problème(s) :`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}
console.log('✓ Une session complète se joue de bout en bout, sans une erreur.');
