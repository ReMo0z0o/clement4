/**
 * Vérifie qu'une configuration Supabase permet réellement de jouer.
 *
 *   npm run supabase:check
 *
 * Lit `.env.local` (ou les variables d'environnement), ouvre deux clients
 * distincts sur le même canal — exactement comme deux joueurs — et fait passer
 * un message de l'un à l'autre. Il ne vérifie pas que « la clé a l'air bonne » :
 * il vérifie que le tour complet fonctionne.
 *
 * On peut aussi lui passer les deux valeurs directement :
 *   node scripts/supabase-check.mjs <URL> <CLE_ANON>
 */

import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

/* ------------------------------------------------------------------ */
/* Lecture de la configuration                                        */
/* ------------------------------------------------------------------ */

function fromEnvFile(path) {
  try {
    const out = {};
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
    }
    return out;
  } catch {
    return {};
  }
}

const file = { ...fromEnvFile('.env'), ...fromEnvFile('.env.local') };
const url = process.argv[2] ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? file.NEXT_PUBLIC_SUPABASE_URL;
const key =
  process.argv[3] ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? file.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const fail = (msg, hint) => {
  console.error(`\n✗ ${msg}`);
  if (hint) console.error(`\n  ${hint}`);
  process.exit(1);
};

console.log('Vérification de la configuration Supabase\n');

if (!url || !key) {
  fail(
    'Les deux variables ne sont pas renseignées.',
    'Créez un fichier .env.local à la racine :\n\n' +
      '    NEXT_PUBLIC_SUPABASE_URL=https://xxxxxxxx.supabase.co\n' +
      '    NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOi...\n\n' +
      '  Les deux se trouvent dans Supabase → votre projet → Project Settings → API.',
  );
}

/* ------------------------------------------------------------------ */
/* Contrôles de forme, avant de toucher au réseau                     */
/* ------------------------------------------------------------------ */

if (!/^https:\/\/[a-z0-9-]+\.supabase\.(co|in)$/.test(url.replace(/\/$/, ''))) {
  fail(
    `L'adresse « ${url} » n'a pas la forme attendue.`,
    'Elle doit ressembler à https://abcdefghijklmnop.supabase.co — sans barre finale,\n' +
      '  sans /rest/v1, et sans le tableau de bord (app.supabase.com n’est pas l’adresse du projet).',
  );
}
if (key.startsWith('sb_secret') || key.includes('service_role')) {
  fail(
    'C’est la clé de service, pas la clé anonyme.',
    'La clé anonyme (anon / publishable) est publique par nature : elle part dans le\n' +
      '  navigateur. La clé de service ne doit JAMAIS s’y trouver. Reprenez la ligne « anon ».',
  );
}
console.log(`  projet : ${url}`);
console.log(`  clé    : ${key.slice(0, 12)}…${key.slice(-4)} (${key.length} caractères)\n`);

/* ------------------------------------------------------------------ */
/* Le vrai test : deux clients, un aller-retour                       */
/* ------------------------------------------------------------------ */

const mk = () =>
  createClient(url, key, {
    realtime: { params: { eventsPerSecond: 100 } },
    auth: { persistSession: false },
  });

const topic = `siege:CHECK${Math.floor(Math.random() * 9000 + 1000)}`;
const hostClient = mk();
const guestClient = mk();

const subscribe = (client, label) =>
  new Promise((resolve, reject) => {
    const ch = client.channel(topic, { config: { broadcast: { self: false } } });
    const timer = setTimeout(
      () => reject(new Error(`${label} : le serveur n'a pas répondu en 12 secondes.`)),
      12000,
    );
    ch.subscribe((status, err) => {
      if (status === 'SUBSCRIBED') {
        clearTimeout(timer);
        resolve(ch);
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        clearTimeout(timer);
        reject(new Error(`${label} : ${status}${err?.message ? ` — ${err.message}` : ''}`));
      }
    });
  });

let code = 0;
try {
  console.log('  · ouverture du canal côté hôte…');
  const hostCh = await subscribe(hostClient, 'hôte');
  console.log('  · ouverture du canal côté invité…');
  const guestCh = await subscribe(guestClient, 'invité');

  const received = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('le message n’est jamais arrivé à l’autre client.')),
      8000,
    );
    guestCh.on('broadcast', { event: 'm' }, (p) => {
      clearTimeout(timer);
      resolve(p.payload);
    });
  });

  console.log('  · envoi d’un message de l’hôte vers l’invité…');
  const sentAt = Date.now();
  // Petit délai : le second abonnement doit être enregistré côté serveur.
  await new Promise((r) => setTimeout(r, 600));
  await hostCh.send({ type: 'broadcast', event: 'm', payload: { type: 'ping', t: sentAt } });

  const payload = await received;
  const rtt = Date.now() - sentAt;
  if (payload?.t !== sentAt) throw new Error('le message reçu ne correspond pas à celui envoyé.');

  console.log(`\n✓ Tout fonctionne. Message transmis en ${rtt} ms.`);
  console.log('\n  Deux personnes peuvent maintenant jouer ensemble, sur deux appareils.');
  console.log('  N’oubliez pas de reporter ces deux variables dans le projet Vercel');
  console.log('  (Settings → Environment Variables), puis de redéployer.');
} catch (err) {
  code = 1;
  console.error(`\n✗ La connexion ne fonctionne pas : ${err.message}`);
  console.error('\n  Pistes, dans l’ordre :');
  console.error('  1. Le projet Supabase est-il actif ? Un projet gratuit est mis en pause');
  console.error('     après une période d’inactivité — il faut le réveiller depuis le tableau de bord.');
  console.error('  2. La clé est-elle bien la clé « anon » du MÊME projet que l’adresse ?');
  console.error('  3. Votre réseau autorise-t-il les WebSockets sortants (wss://) ?');
  console.error('  4. Realtime est-il activé ? Il l’est par défaut ; aucune table n’est requise,');
  console.error('     le jeu n’utilise que Broadcast.');
} finally {
  await hostClient.removeAllChannels().catch(() => {});
  await guestClient.removeAllChannels().catch(() => {});
  process.exit(code);
}
